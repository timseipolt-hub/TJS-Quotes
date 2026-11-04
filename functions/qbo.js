// QuickBooks Online helpers. Pure logic: the HTTP call is passed in, so this
// file can be tested without Firebase or a real QuickBooks company.

const OAUTH_AUTHORIZE = 'https://appcenter.intuit.com/connect/oauth2';
const OAUTH_TOKEN = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const OAUTH_REVOKE = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const SCOPE = 'com.intuit.quickbooks.accounting';
const MINOR = '75';

const ITEM_NAMES = ['Maintenance', 'Labour', 'Materials', 'Engineering', 'Other'];

function apiBase(env) {
  return env === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com';
}
function appBase(env) {
  return env === 'production' ? 'https://app.qbo.intuit.com' : 'https://app.sandbox.qbo.intuit.com';
}
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function q(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

// Guess which generic product a quote line belongs to. The app lets you change it.
function guessItem(desc) {
  const d = String(desc || '').toLowerCase();
  if (/engineer|inspect|assess|report|certif|design|calc|computation|structural/.test(d)) return 'Engineering';
  if (/material|supply|supplies|timber|sheet|fixings|hardware|concrete|steel|post|panel|delivery|hire|skip|tip/.test(d)) return 'Materials';
  if (/labour|labor|install|repair|replace|remove|build|paint|clean|fit|construct|demol/.test(d)) return 'Labour';
  return 'Labour';
}

// Line value excluding GST: hours/qty x rate. Older callers sent a GST inclusive amount.
function lineNet(l) {
  if (l.rate != null && l.rate !== '') return round2((Number(l.qty) || 0) * Number(l.rate));
  return round2((Number(l.amount) || 0) / 1.1);
}

// App lines (ex GST) -> QuickBooks lines. QuickBooks adds the GST.
function buildLines(lines, itemIds, gstCodeId) {
  return lines
    .map(l => Object.assign({}, l, { net: lineNet(l) }))
    .filter(l => Math.abs(l.net) >= 0.005)
    .map(l => {
      const hasRate = l.rate != null && l.rate !== '';
      const qty = hasRate ? Number(l.qty) || 0 : 1;
      const rate = hasRate ? round2(l.rate) : l.net;
      return {
        DetailType: 'SalesItemLineDetail',
        Description: String(l.description || '').slice(0, 4000),
        Amount: l.net,
        SalesItemLineDetail: {
          ItemRef: { value: itemIds[l.item] || itemIds.Other },
          Qty: qty,
          UnitPrice: rate,
          TaxCodeRef: { value: gstCodeId }
        }
      };
    });
}

function parseAddress(addr) {
  // "12 Smith St, Ferntree Gully, 3156" -> parts. Kept loose on purpose.
  const parts = String(addr || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out = { Line1: parts[0], Country: 'Australia' };
  const pc = parts.find(p => /^\d{4}$/.test(p) || /\b\d{4}$/.test(p));
  if (pc) out.PostalCode = pc.match(/\d{4}$/)[0];
  const city = parts.slice(1).find(p => p !== pc && !/^\d{4}$/.test(p));
  if (city) out.City = city.replace(/\s+(VIC|NSW|QLD|SA|WA|TAS|ACT|NT)$/i, '');
  const st = String(addr).match(/\b(VIC|NSW|QLD|SA|WA|TAS|ACT|NT)\b/i);
  out.CountrySubDivisionCode = st ? st[1].toUpperCase() : 'VIC';
  return out;
}

// A small client around one company. http(method, url, {headers, body}) -> {status, json}
function client({ http, env, realmId, accessToken }) {
  const base = `${apiBase(env)}/v3/company/${realmId}`;
  async function call(method, path, body) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await http(method, `${base}${path}${sep}minorversion=${MINOR}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 401) { const e = new Error('QuickBooks session expired'); e.code = 'auth'; throw e; }
    if (res.status >= 400) {
      const f = res.json && res.json.Fault && res.json.Fault.Error && res.json.Fault.Error[0];
      const e = new Error(f ? `${f.Message}: ${f.Detail || ''}`.trim() : `QuickBooks error ${res.status}`);
      e.qboCode = f && f.code; e.status = res.status;
      throw e;
    }
    return res.json;
  }
  async function query(sql) {
    const r = await call('GET', `/query?query=${encodeURIComponent(sql)}`);
    return r.QueryResponse || {};
  }
  return { call, query };
}

async function findGstCode(c) {
  const r = await c.query("select * from TaxCode where Active = true");
  const codes = r.TaxCode || [];
  const exact = codes.find(t => /^gst$/i.test(t.Name));
  const loose = codes.find(t => /gst/i.test(t.Name) && !/free|fre|exempt|export|input|capital|bas excl/i.test(t.Name));
  const code = exact || loose;
  if (!code) throw new Error('No GST tax code found in QuickBooks. Check GST is set up under Taxes.');
  return code.Id;
}

async function findIncomeAccount(c) {
  const r = await c.query("select * from Account where AccountType = 'Income' and Active = true");
  const accs = r.Account || [];
  const pick = accs.find(a => /^sales$/i.test(a.Name)) || accs.find(a => /services|sales/i.test(a.Name)) || accs[0];
  if (!pick) throw new Error('No income account found in QuickBooks.');
  return pick.Id;
}

async function ensureItems(c, names, gstId) {
  const ids = {};
  let incomeId = null;
  for (const name of names) {
    const r = await c.query(`select * from Item where Name = '${q(name)}'`);
    const found = (r.Item || [])[0];
    if (found) { ids[name] = found.Id; continue; }
    if (!incomeId) incomeId = await findIncomeAccount(c);
    const made = await c.call('POST', '/item', {
      Name: name,
      Type: 'Service',
      IncomeAccountRef: { value: incomeId },
      SalesTaxIncluded: false,
      SalesTaxCodeRef: { value: gstId }
    });
    ids[name] = made.Item.Id;
  }
  return ids;
}

async function ensureCustomer(c, cust) {
  const name = String(cust.name || '').trim().slice(0, 100) || 'Unnamed client';
  const r = await c.query(`select * from Customer where DisplayName = '${q(name)}'`);
  const found = (r.Customer || [])[0];
  if (found) return { id: found.Id, created: false, name };
  const body = { DisplayName: name };
  if (cust.email) body.PrimaryEmailAddr = { Address: cust.email };
  if (cust.phone) body.PrimaryPhone = { FreeFormNumber: cust.phone };
  const addr = parseAddress(cust.address);
  if (addr) body.BillAddr = addr;
  try {
    const made = await c.call('POST', '/customer', body);
    return { id: made.Customer.Id, created: true, name };
  } catch (e) {
    // Name clashes with a supplier or employee: QuickBooks needs unique names
    if (String(e.qboCode) === '6240') {
      body.DisplayName = `${name} (client)`;
      const made = await c.call('POST', '/customer', body);
      return { id: made.Customer.Id, created: true, name: body.DisplayName };
    }
    throw e;
  }
}

async function customNumbersOn(c) {
  const r = await c.call('GET', '/preferences');
  const p = r.Preferences && r.Preferences.SalesFormsPrefs;
  return !!(p && p.CustomTxnNumbers);
}

// Main entry: create one invoice from what the app sends.
async function createInvoice(c, env, input) {
  const lines = (input.lines || []).filter(l => ITEM_NAMES.includes(l.item));
  if (!lines.length) throw new Error('Add at least one line with an amount.');
  const expected = round2(lines.reduce((a, l) => a + lineNet(l), 0)); // ex GST
  if (expected <= 0) throw new Error('Invoice total must be more than $0.');

  const docNumber = String(input.docNumber || '').trim().slice(0, 21);
  const useNumber = docNumber && await customNumbersOn(c);

  if (useNumber) {
    const dup = await c.query(`select * from Invoice where DocNumber = '${q(docNumber)}'`);
    const existing = (dup.Invoice || [])[0];
    if (existing) {
      return {
        id: existing.Id, docNumber: existing.DocNumber, total: existing.TotalAmt,
        link: `${appBase(env)}/app/invoice?txnId=${existing.Id}`, existing: true
      };
    }
  }

  const gstId = await findGstCode(c);
  const itemIds = await ensureItems(c, [...new Set(lines.map(l => l.item).concat('Other'))], gstId);
  const cust = await ensureCustomer(c, input.customer || {});

  const inv = {
    CustomerRef: { value: cust.id },
    GlobalTaxCalculation: 'TaxExcluded',
    Line: buildLines(lines, itemIds, gstId)
  };
  if (input.txnDate) inv.TxnDate = input.txnDate;
  if (input.dueDate) inv.DueDate = input.dueDate;
  if (useNumber) inv.DocNumber = docNumber;
  const memo = [docNumber && !useNumber ? `TJS ref ${docNumber}` : '', input.siteAddress ? `Site: ${input.siteAddress}` : '']
    .filter(Boolean).join('\n');
  if (memo) inv.CustomerMemo = { value: memo.slice(0, 1000) };
  inv.PrivateNote = `Sent from TJS-Quotes${docNumber ? ' · ' + docNumber : ''}`;
  if (input.customer && input.customer.email) inv.BillEmail = { Address: input.customer.email };

  const made = await c.call('POST', '/invoice', inv);
  const out = made.Invoice;
  const result = {
    id: out.Id,
    docNumber: out.DocNumber || '',
    total: out.TotalAmt,
    link: `${appBase(env)}/app/invoice?txnId=${out.Id}`,
    customerCreated: cust.created,
    customerName: cust.name,
    usedTjsNumber: !!useNumber
  };
  const expectedInc = round2(expected * 1.1);
  if (Math.abs(round2(out.TotalAmt) - expectedInc) > 0.05) {
    result.warning = `QuickBooks total is ${out.TotalAmt}, app expected ${expectedInc} inc GST. Check GST settings on the invoice.`;
  }
  return result;
}

module.exports = {
  OAUTH_AUTHORIZE, OAUTH_TOKEN, OAUTH_REVOKE, SCOPE, ITEM_NAMES,
  apiBase, appBase, round2, guessItem, lineNet, buildLines, parseAddress, client,
  findGstCode, ensureItems, ensureCustomer, createInvoice
};
