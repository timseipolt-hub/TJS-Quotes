// Quote Assistant: a Claude agent that drafts and revises TJS quotes.
// It reads past quotes for pricing, then writes its draft through the
// update_quote tool. Nothing is saved here: the app applies the draft to the
// quote form, and Tim reviews and saves it as usual.

const MODEL = 'claude-opus-5-5';
const MAX_STEPS = 10;

const SERVICES = ['General Maintenance', 'Painting & Plastering', 'Decks & Patios', 'Garden Maintenance', 'Fencing', 'Other'];
const BASES = ['Fixed Price', 'Cost Plus', 'Materials Only', 'Estimate Only'];
const MAX_ITEMS = 10; // the PDF letters line items A to J

const SYSTEM = `You are the quoting assistant for TJS Maintenance (ABN 41 178 053 874), a property maintenance business in Victoria, Australia, run by Tim Seipolt. You work inside the TJS quote builder app. Tim describes a job, sometimes with site photos, and you turn it into a quote in the app's quote form, then revise it as he asks.

Services offered: ${SERVICES.join(', ')}.

How a TJS quote is built:
- Client details (name, mobile, email, postal address) and site details (address, suburb, postcode, access notes). The site address is only needed when it differs from the client's address.
- Up to ${MAX_ITEMS} line items, lettered A to J on the PDF. Each has a description of works, a unit (m, lm, m², hr, ea, day, lot), a quantity and a unit cost. Line total = qty x unit cost.
- All prices are in AUD and include GST. There is an optional Extras amount added to the total.
- Inclusions and exclusions lists, and free-text notes / special conditions.
- Pricing basis: Fixed Price (10% deposit, balance on completion), Cost Plus (actual costs plus a margin on materials, default 20%), Materials Only (50% deposit, balance on delivery), or Estimate Only (budget estimate, no deposit). An optional progress payment line, e.g. "$500 on delivery of materials".
- Quotes are valid 30 days by default.

How to work:
- Before pricing, call search_past_quotes for similar work, and get_business_settings for the hourly rate. Base prices on what Tim has charged before. When there is no history for a kind of work, use realistic current Victorian trade rates, and say clearly which prices are your estimates so Tim can check them.
- Write the quote with update_quote. Draft early, stating your assumptions, rather than asking a string of questions; ask only about what you cannot reasonably assume (for example, a fence length that is not given). Never invent client names, phone numbers, emails or addresses: leave blank what Tim has not given you.
- Write line item descriptions the way they will read on the client's PDF: clear, specific, professional, in Australian English. Split labour and materials into separate items when that helps the client understand the price.
- Choose inclusions and exclusions that fit the job (for example, for fencing: removal of the old fence, dividing-fence cost sharing, digging in rock). Put site-specific assumptions in the notes.
- The form state you are shown is the current quote. When Tim asks for a change, change only what he asked for.
- After updating, reply in two to five short lines: what you put in, the total, and any prices or assumptions Tim should check. Don't repeat the whole quote back; he can see it in the form.`;

const TOOLS = [
  {
    name: 'search_past_quotes',
    description: "Search Tim's saved quotes by keywords (type of work, materials, suburb or client name). Returns matching quotes with their line items, units and unit costs, newest first. Use it to price new work consistently with past quotes. Accepted quotes show what clients agreed to pay.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "colorbond fence" or "deck oil"' },
        limit: { type: 'integer', description: 'Most quotes to return, 1 to 15. Default 8.' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_business_settings',
    description: "Returns Tim's hourly labour rate (ex GST, as used on invoices) and a summary of his quoting history: number of quotes by status and the most common line item units.",
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'update_quote',
    description: 'Write to the quote form. Only the fields you pass are changed. "items" replaces every line item; "incs" and "excs" replace those lists. Prices include GST.',
    input_schema: {
      type: 'object',
      properties: {
        client: {
          type: 'object',
          description: 'Client details',
          properties: {
            name: { type: 'string' }, mobile: { type: 'string' }, email: { type: 'string' },
            address: { type: 'string', description: 'Street address' }, suburb: { type: 'string' }, postcode: { type: 'string' }
          }
        },
        site: {
          type: 'object',
          description: 'Site details, when the site differs from the client address',
          properties: {
            address: { type: 'string' }, suburb: { type: 'string' }, postcode: { type: 'string' },
            access: { type: 'string', description: 'Access notes, e.g. side gate code' }
          }
        },
        services: { type: 'array', items: { type: 'string', enum: SERVICES } },
        items: {
          type: 'array',
          description: `Line items, at most ${MAX_ITEMS}`,
          items: {
            type: 'object',
            properties: {
              desc: { type: 'string', description: 'Description of works, as shown to the client' },
              unit: { type: 'string', description: 'm, lm, m², hr, ea, day or lot' },
              qty: { type: 'number' },
              unitCost: { type: 'number', description: 'AUD incl. GST, per unit' }
            },
            required: ['desc', 'unit', 'qty', 'unitCost']
          }
        },
        extra: { type: 'number', description: 'Extras amount added to the total, AUD incl. GST' },
        incs: { type: 'array', items: { type: 'string' }, description: 'Inclusions' },
        excs: { type: 'array', items: { type: 'string' }, description: 'Exclusions' },
        notes: { type: 'string', description: 'Notes / special conditions' },
        pbasis: { type: 'string', enum: BASES },
        costPlusPct: { type: 'number', description: 'Cost Plus margin on materials, %' },
        pprog: { type: 'string', description: 'Progress payment line' },
        validDays: { type: 'integer', description: 'Days the quote is valid, default 30' }
      }
    }
  }
];

const str = v => (v == null ? '' : String(v)).trim();
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const money = n => '$' + round2(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// ── Tools ────────────────────────────────────────────────────────────────

function quoteText(q) {
  return [q.cname, q.csub, q.ssub, q.saddr, q.caddr, q.notes, (q.services || []).join(' '),
    (q.items || []).map(i => i.desc).join(' ')].join(' ').toLowerCase();
}

function searchQuotes(quotes, input) {
  const words = str(input.query).toLowerCase().split(/[^a-z0-9²]+/).filter(w => w.length > 1);
  const limit = Math.min(Math.max(parseInt(input.limit, 10) || 8, 1), 15);
  const scored = quotes.map(q => {
    const t = quoteText(q);
    const score = words.reduce((s, w) => s + (t.includes(w) ? 1 : 0), 0);
    return { q, score };
  }).filter(x => !words.length || x.score > 0);
  scored.sort((a, b) => b.score - a.score || (b.q.savedAtMs || 0) - (a.q.savedAtMs || 0));
  const out = scored.slice(0, limit).map(({ q }) => ({
    qno: q.qno, date: q.qdate, status: q.status || 'draft', client: q.cname,
    suburb: q.ssub || q.csub || '', services: q.services || [], pricingBasis: q.pbasis || '',
    total: q.grand || 0,
    items: (q.items || []).map(i => ({ desc: i.desc, unit: i.unit, qty: i.qty, unitCost: i.unitCost, total: i.price }))
  }));
  if (!out.length) return { matches: 0, note: `No past quotes match "${str(input.query)}". Try broader words.` };
  return { matches: out.length, searched: quotes.length, quotes: out };
}

function businessSettings(quotes, rate) {
  const byStatus = {};
  const units = {};
  quotes.forEach(q => {
    const s = q.status || 'draft';
    byStatus[s] = (byStatus[s] || 0) + 1;
    (q.items || []).forEach(i => { const u = str(i.unit).toLowerCase(); if (u) units[u] = (units[u] || 0) + 1; });
  });
  return {
    hourlyRateExGst: rate || null,
    hourlyRateIncGst: rate ? round2(rate * 1.1) : null,
    note: rate ? undefined : 'No hourly rate saved yet. Ask Tim if labour is priced by the hour.',
    quotesByStatus: byStatus,
    commonUnits: Object.entries(units).sort((a, b) => b[1] - a[1]).slice(0, 8).map(e => e[0])
  };
}

// Validate an update_quote call and merge it into the draft for this turn.
function applyUpdate(draft, input) {
  const problems = [];
  const set = (k, v) => { if (v !== undefined) draft[k] = v; };

  const c = input.client || {};
  set('cname', c.name !== undefined ? str(c.name) : undefined);
  set('cmob', c.mobile !== undefined ? str(c.mobile) : undefined);
  set('cemail', c.email !== undefined ? str(c.email) : undefined);
  set('caddr', c.address !== undefined ? str(c.address) : undefined);
  set('csub', c.suburb !== undefined ? str(c.suburb) : undefined);
  set('cpost', c.postcode !== undefined ? str(c.postcode) : undefined);
  const s = input.site || {};
  set('saddr', s.address !== undefined ? str(s.address) : undefined);
  set('ssub', s.suburb !== undefined ? str(s.suburb) : undefined);
  set('spost', s.postcode !== undefined ? str(s.postcode) : undefined);
  set('saccess', s.access !== undefined ? str(s.access) : undefined);

  if (Array.isArray(input.services)) {
    const ok = input.services.filter(x => SERVICES.includes(x));
    if (ok.length !== input.services.length) problems.push(`services must be from: ${SERVICES.join(', ')}`);
    draft.services = ok;
  }
  if (Array.isArray(input.items)) {
    if (input.items.length > MAX_ITEMS) problems.push(`only the first ${MAX_ITEMS} line items were kept; combine items`);
    draft.items = input.items.slice(0, MAX_ITEMS).map((i, n) => {
      const qty = num(i && i.qty), unitCost = num(i && i.unitCost);
      if (!str(i && i.desc)) problems.push(`item ${n + 1} has no description`);
      if (qty === null || unitCost === null) problems.push(`item ${n + 1} needs numeric qty and unitCost`);
      return { desc: str(i && i.desc), unit: str(i && i.unit), qty: qty || 0, unitCost: round2(unitCost || 0) };
    });
  }
  if (input.extra !== undefined) draft.extra = round2(num(input.extra) || 0);
  if (Array.isArray(input.incs)) draft.incs = input.incs.map(str).filter(Boolean);
  if (Array.isArray(input.excs)) draft.excs = input.excs.map(str).filter(Boolean);
  if (input.notes !== undefined) draft.notes = str(input.notes);
  if (input.pbasis !== undefined) {
    if (BASES.includes(input.pbasis)) draft.pbasis = input.pbasis;
    else problems.push(`pbasis must be one of: ${BASES.join(', ')}`);
  }
  if (input.costPlusPct !== undefined) draft.costPlusPct = num(input.costPlusPct) || 20;
  if (input.pprog !== undefined) draft.pprog = str(input.pprog);
  if (input.validDays !== undefined) draft.validDays = Math.min(Math.max(parseInt(input.validDays, 10) || 30, 1), 365);
  return problems;
}

function quoteTotal(form, draft) {
  const items = draft.items || form.items || [];
  const sub = items.reduce((a, i) => a + (Number(i.qty) || 0) * (Number(i.unitCost) || 0), 0);
  const extra = draft.extra !== undefined ? draft.extra : (Number(form.extra) || 0);
  return round2(sub + extra);
}

// ── Agent loop ───────────────────────────────────────────────────────────

// Keep only the fields the agent needs from the quote form.
function formSnapshot(f) {
  f = f || {};
  const pick = ['qno', 'qdate', 'qvalid', 'cname', 'cmob', 'cemail', 'caddr', 'csub', 'cpost', 'saddr', 'ssub', 'spost',
    'saccess', 'services', 'extra', 'incs', 'excs', 'notes', 'pbasis', 'costPlusPct', 'pprog', 'status'];
  const out = {};
  pick.forEach(k => { if (f[k] !== undefined && f[k] !== '') out[k] = f[k]; });
  out.items = (f.items || []).map(i => ({ desc: i.desc, unit: i.unit, qty: i.qty, unitCost: i.unitCost }));
  out.total = quoteTotal(f, {});
  return out;
}

function userTurn(text, form, images, today) {
  const content = [];
  (images || []).slice(0, 4).forEach(img => {
    if (img && /^image\/(jpeg|png|webp|gif)$/.test(img.mediaType) && typeof img.data === 'string') {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
    }
  });
  content.push({
    type: 'text',
    text: `<quote_form date="${today}">\n${JSON.stringify(formSnapshot(form), null, 1)}\n</quote_form>\n\n${str(text) || '(see photos)'}`
  });
  return { role: 'user', content };
}

function finalText(content) {
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

/**
 * Run one turn of the quote assistant.
 * deps: { client (Anthropic), loadQuotes: () => Promise<quote[]>, loadRate: () => Promise<number|null> }
 * req:  { messages (prior transcript, returned by the last call), text, form, images, today }
 */
async function runTurn(deps, req) {
  const messages = Array.isArray(req.messages) ? req.messages.slice() : [];
  const turn = userTurn(req.text, req.form, req.images, req.today || new Date().toISOString().slice(0, 10));
  const prev = messages[messages.length - 1];
  // A turn cut off after tool results ends on a user message: add to it rather than send two in a row
  if (prev && prev.role === 'user' && Array.isArray(prev.content)) {
    messages[messages.length - 1] = { role: 'user', content: prev.content.concat(turn.content) };
  } else {
    messages.push(turn);
  }

  const draft = {};
  let quotes = null;
  const getQuotes = async () => (quotes = quotes || await deps.loadQuotes());
  const usage = { input: 0, output: 0, cacheRead: 0 };
  let note = '';

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await deps.client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools: TOOLS,
      messages,
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default'
    });
    usage.input += res.usage.input_tokens || 0;
    usage.output += res.usage.output_tokens || 0;
    usage.cacheRead += res.usage.cache_read_input_tokens || 0;
    messages.push({ role: 'assistant', content: res.content });

    if (res.stop_reason === 'pause_turn') continue;
    if (res.stop_reason === 'refusal') { note = 'The assistant declined this request.'; break; }
    if (res.stop_reason === 'max_tokens') { note = 'The reply was cut short. Ask it to continue.'; break; }
    if (res.stop_reason !== 'tool_use') break;

    const results = [];
    for (const b of res.content.filter(x => x.type === 'tool_use')) {
      let out, isError = false;
      try {
        if (b.name === 'search_past_quotes') out = searchQuotes(await getQuotes(), b.input || {});
        else if (b.name === 'get_business_settings') out = businessSettings(await getQuotes(), await deps.loadRate());
        else if (b.name === 'update_quote') {
          const problems = applyUpdate(draft, b.input || {});
          out = { applied: true, quoteTotal: money(quoteTotal(req.form || {}, draft)), problems: problems.length ? problems : undefined };
        } else { out = `Unknown tool ${b.name}`; isError = true; }
      } catch (e) {
        out = `Tool failed: ${e.message}`; isError = true;
      }
      results.push({ type: 'tool_result', tool_use_id: b.id, content: typeof out === 'string' ? out : JSON.stringify(out), is_error: isError || undefined });
    }
    messages.push({ role: 'user', content: results });
    if (step === MAX_STEPS - 1) note = 'The assistant stopped after too many steps.';
  }

  const last = messages[messages.length - 1];
  const reply = last.role === 'assistant' ? finalText(last.content) : '';
  return { messages, reply: [reply, note].filter(Boolean).join('\n\n'), draft, usage };
}

module.exports = { runTurn, applyUpdate, searchQuotes, businessSettings, formSnapshot, TOOLS, SYSTEM, MODEL };
