// TJS-Quotes ↔ QuickBooks Online. Firebase Cloud Functions (2nd gen).
// Secrets live in Firebase Secret Manager, never in the web app:
//   firebase functions:secrets:set QBO_CLIENT_ID
//   firebase functions:secrets:set QBO_CLIENT_SECRET
// QBO_ENV is "sandbox" until Intuit approves production keys.

const crypto = require('crypto');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const qbo = require('./qbo');

admin.initializeApp();
const db = admin.firestore();

const CLIENT_ID = defineSecret('QBO_CLIENT_ID');
const CLIENT_SECRET = defineSecret('QBO_CLIENT_SECRET');
const QBO_ENV = defineString('QBO_ENV', { default: 'sandbox' });
const APP_URL = defineString('APP_URL', { default: 'https://timseipolt-hub.github.io/TJS-Quotes/' });

const REGION = 'australia-southeast1';
const opts = { region: REGION, secrets: [CLIENT_ID, CLIENT_SECRET] };

// Tokens sit outside users/{uid} so the web app can never read them.
const tokenDoc = uid => db.collection('qboTokens').doc(uid);
function projectId() {
  if (process.env.GCLOUD_PROJECT) return process.env.GCLOUD_PROJECT;
  try { return JSON.parse(process.env.FIREBASE_CONFIG).projectId; } catch (e) { return 'tjs---quote-template'; }
}
const redirectUri = () => `https://${REGION}-${projectId()}.cloudfunctions.net/qboCallback`;
// Secrets pasted in PowerShell can carry a trailing line break; strip it
const clientId = () => String(CLIENT_ID.value() || '').trim();
const clientSecret = () => String(CLIENT_SECRET.value() || '').trim();

async function http(method, url, { headers, body } = {}) {
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = { raw: text }; }
  return { status: res.status, json };
}

function basicAuth() {
  return 'Basic ' + Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64');
}

async function tokenRequest(params) {
  const res = await fetch(qbo.OAUTH_TOKEN, {
    method: 'POST',
    headers: { Authorization: basicAuth(), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || json.error || `Intuit token error ${res.status}`);
  return json;
}

function saveTokens(uid, t, extra) {
  return tokenDoc(uid).set(Object.assign({
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + (t.expires_in - 120) * 1000,
    refreshExpiresAt: Date.now() + (t.x_refresh_token_expires_in || 0) * 1000,
    updatedAt: Date.now()
  }, extra || {}), { merge: true });
}

async function getClient(uid) {
  const snap = await tokenDoc(uid).get();
  if (!snap.exists) throw new HttpsError('failed-precondition', 'QuickBooks is not connected.');
  let t = snap.data();
  if (Date.now() > t.expiresAt) {
    try {
      const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken });
      await saveTokens(uid, fresh);
      t = Object.assign(t, { accessToken: fresh.access_token });
    } catch (e) {
      throw new HttpsError('failed-precondition', 'QuickBooks connection has expired. Connect again.');
    }
  }
  return { c: qbo.client({ http, env: t.env, realmId: t.realmId, accessToken: t.accessToken }), t };
}

function needUser(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  return req.auth.uid;
}

// 1. App asks for the Intuit sign-in link
exports.qboAuthStart = onCall(opts, async req => {
  const uid = needUser(req);
  const state = crypto.randomBytes(24).toString('hex');
  await db.collection('qboStates').doc(state).set({ uid, createdAt: Date.now() });
  const url = `${qbo.OAUTH_AUTHORIZE}?` + new URLSearchParams({
    client_id: clientId(), response_type: 'code', scope: qbo.SCOPE,
    redirect_uri: redirectUri(), state
  }).toString();
  return { url };
});

// 2. Intuit sends the browser back here after sign-in
exports.qboCallback = onRequest(opts, async (req, res) => {
  const back = (status, msg) => res.redirect(`${APP_URL.value()}?qbo=${status}${msg ? '&qbomsg=' + encodeURIComponent(msg) : ''}#jobs`);
  try {
    const { code, state, realmId, error } = req.query;
    if (error) return back('error', String(error));
    if (!code || !state || !realmId) return back('error', 'Missing details from Intuit');
    const ref = db.collection('qboStates').doc(String(state));
    const s = await ref.get();
    if (!s.exists || Date.now() - s.data().createdAt > 15 * 60000) return back('error', 'Sign in link expired, try again');
    await ref.delete();
    const t = await tokenRequest({ grant_type: 'authorization_code', code: String(code), redirect_uri: redirectUri() });
    let companyName = '';
    try {
      const c = qbo.client({ http, env: QBO_ENV.value(), realmId: String(realmId), accessToken: t.access_token });
      const ci = await c.call('GET', `/companyinfo/${realmId}`);
      companyName = ci.CompanyInfo && ci.CompanyInfo.CompanyName || '';
    } catch (e) { /* name is only for display */ }
    await saveTokens(s.data().uid, t, { realmId: String(realmId), env: QBO_ENV.value(), companyName, connectedAt: Date.now() });
    return back('connected');
  } catch (e) {
    console.error('qboCallback', e);
    return back('error', e.message);
  }
});

// 3. Is QuickBooks connected?
exports.qboStatus = onCall(opts, async req => {
  const uid = needUser(req);
  const snap = await tokenDoc(uid).get();
  if (!snap.exists) return { connected: false, env: QBO_ENV.value() };
  const t = snap.data();
  const expired = t.refreshExpiresAt && Date.now() > t.refreshExpiresAt;
  return { connected: !expired, env: t.env, companyName: t.companyName || '', expired: !!expired };
});

// 4. Disconnect
exports.qboDisconnect = onCall(opts, async req => {
  const uid = needUser(req);
  const snap = await tokenDoc(uid).get();
  if (snap.exists) {
    try {
      await fetch(qbo.OAUTH_REVOKE, {
        method: 'POST',
        headers: { Authorization: basicAuth(), Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: snap.data().refreshToken })
      });
    } catch (e) { /* still remove our copy */ }
    await tokenDoc(uid).delete();
  }
  return { connected: false };
});

// 5. Send one job to QuickBooks as an invoice
exports.qboCreateInvoice = onCall(opts, async req => {
  const uid = needUser(req);
  const d = req.data || {};
  if (!d.jobId) throw new HttpsError('invalid-argument', 'Missing job.');
  const jobRef = db.collection('users').doc(uid).collection('jobs').doc(String(d.jobId));
  const job = await jobRef.get();
  if (!job.exists) throw new HttpsError('not-found', 'Job not found.');
  if (job.data().qbo && job.data().qbo.id && !d.force) {
    throw new HttpsError('already-exists', 'This job is already in QuickBooks.');
  }
  const { c, t } = await getClient(uid);
  try {
    const r = await qbo.createInvoice(c, t.env, d);
    const record = Object.assign({ sentAt: Date.now(), env: t.env }, r);
    await jobRef.set({ qbo: record, updatedAt: Date.now() }, { merge: true });
    return record;
  } catch (e) {
    console.error('qboCreateInvoice', e);
    if (e.code === 'auth') throw new HttpsError('failed-precondition', 'QuickBooks connection has expired. Connect again.');
    throw new HttpsError('internal', e.message || 'QuickBooks rejected the invoice.');
  }
});

// 6. Quote Assistant: Claude drafts and revises the quote in the form
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const agent = require('./agent');
let anthropic = null;
function anthropicClient() {
  if (!anthropic) {
    const Anthropic = require('@anthropic-ai/sdk').default;
    anthropic = new Anthropic({ apiKey: String(ANTHROPIC_API_KEY.value() || '').trim(), timeout: 240000, maxRetries: 2 });
  }
  return anthropic;
}

exports.quoteAgent = onCall({ region: REGION, secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 300, memory: '512MiB' }, async req => {
  const uid = needUser(req);
  const d = req.data || {};
  if (!String(d.text || '').trim() && !(d.images || []).length) throw new HttpsError('invalid-argument', 'Type a message first.');
  if (JSON.stringify(d).length > 8 * 1024 * 1024) throw new HttpsError('invalid-argument', 'This conversation is too long. Start a new chat.');
  const userDoc = db.collection('users').doc(uid);
  try {
    return await agent.runTurn({
      client: anthropicClient(),
      loadQuotes: async () => {
        const snap = await userDoc.collection('quotes').orderBy('savedAt', 'desc').limit(400).get();
        return snap.docs.map(x => x.data());
      },
      loadRate: async () => {
        const m = await userDoc.collection('meta').doc('qbo').get();
        return m.exists && Number(m.data().rate) || null;
      }
    }, { messages: d.messages, text: d.text, form: d.form, images: d.images, today: d.today });
  } catch (e) {
    console.error('quoteAgent', e);
    const Anthropic = require('@anthropic-ai/sdk').default;
    if (e instanceof Anthropic.AuthenticationError) throw new HttpsError('failed-precondition', 'The assistant is not set up: check the ANTHROPIC_API_KEY secret.');
    if (e instanceof Anthropic.RateLimitError) throw new HttpsError('resource-exhausted', 'The assistant is busy. Try again in a minute.');
    if (e instanceof Anthropic.BadRequestError) throw new HttpsError('invalid-argument', 'The assistant could not read this conversation. Start a new chat.');
    if (e instanceof Anthropic.APIError) throw new HttpsError('unavailable', 'The assistant is unavailable right now. Try again shortly.');
    throw new HttpsError('internal', e.message || 'The assistant failed.');
  }
});
