const test = require('node:test');
const assert = require('node:assert');
const qbo = require('../qbo');

// Fake QuickBooks company that records what it is sent
function fakeQbo({ customNumbers = true, existingInvoice = null, customers = [] } = {}) {
  const sent = [];
  let nextId = 100;
  const items = {};
  const http = async (method, url, { body }) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^.*\/company\/\d+/, '');
    const b = body ? JSON.parse(body) : null;
    sent.push({ method, path, query: u.searchParams.get('query'), body: b });
    if (path === '/preferences') return { status: 200, json: { Preferences: { SalesFormsPrefs: { CustomTxnNumbers: customNumbers } } } };
    if (path === '/query') {
      const sql = u.searchParams.get('query');
      if (/from TaxCode/.test(sql)) return { status: 200, json: { QueryResponse: { TaxCode: [{ Id: '5', Name: 'GST free' }, { Id: '10', Name: 'GST' }] } } };
      if (/from Account/.test(sql)) return { status: 200, json: { QueryResponse: { Account: [{ Id: '1', Name: 'Sales' }] } } };
      if (/from Invoice/.test(sql)) return { status: 200, json: { QueryResponse: existingInvoice ? { Invoice: [existingInvoice] } : {} } };
      if (/from Item/.test(sql)) { const n = sql.match(/Name = '(.*)'/)[1]; return { status: 200, json: { QueryResponse: items[n] ? { Item: [items[n]] } : {} } }; }
      if (/from Customer/.test(sql)) { const n = sql.match(/DisplayName = '(.*)'/)[1].replace(/\\'/g, "'"); const f = customers.find(c => c.DisplayName === n); return { status: 200, json: { QueryResponse: f ? { Customer: [f] } : {} } }; }
    }
    if (path === '/item') { const it = { Id: String(nextId++), Name: b.Name }; items[b.Name] = it; return { status: 200, json: { Item: it } }; }
    if (path === '/customer') return { status: 200, json: { Customer: { Id: String(nextId++) } } };
    if (path === '/invoice') {
      const total = b.Line.reduce((a, l) => a + l.Amount * 1.1, 0);
      return { status: 200, json: { Invoice: { Id: '555', DocNumber: b.DocNumber || '1001', TotalAmt: Math.round(total * 100) / 100 } } };
    }
    return { status: 404, json: {} };
  };
  return { http, sent };
}

const input = {
  jobId: 'j1', docNumber: 'TJS-081', txnDate: '2026-11-02',
  customer: { name: "Jo O'Brien", email: 'jo@example.com', phone: '0400 000 000', address: '12 Smith St, Ferntree Gully, 3156' },
  lines: [
    { description: 'Replace 6 m paling fence', qty: 6.5, rate: 95, item: 'Maintenance' },
    { description: 'Treated pine palings and posts', qty: 1, rate: 441.36, item: 'Materials' }
  ]
};

test('hours x rate ex GST become QuickBooks lines', () => {
  const lines = qbo.buildLines(input.lines, { Maintenance: 'MT', Materials: 'M', Other: 'O' }, '10');
  assert.strictEqual(lines[0].Amount, 617.5);
  assert.strictEqual(lines[0].SalesItemLineDetail.Qty, 6.5);
  assert.strictEqual(lines[0].SalesItemLineDetail.UnitPrice, 95);
  assert.strictEqual(lines[0].SalesItemLineDetail.ItemRef.value, 'MT');
  assert.strictEqual(lines[1].Amount, 441.36);
  assert.strictEqual(lines[1].SalesItemLineDetail.TaxCodeRef.value, '10');
});

test('old style GST inclusive amount still works', () => {
  const lines = qbo.buildLines([{ description: 'x', amount: 1320, item: 'Labour' }], { Labour: 'L', Other: 'O' }, '10');
  assert.strictEqual(lines[0].Amount, 1200);
});

test('creates customer, items and invoice with TJS number', async () => {
  const f = fakeQbo();
  const c = qbo.client({ http: f.http, env: 'sandbox', realmId: '123', accessToken: 'x' });
  const r = await qbo.createInvoice(c, 'sandbox', input);
  const inv = f.sent.find(s => s.path === '/invoice').body;
  assert.strictEqual(inv.DocNumber, 'TJS-081');
  assert.strictEqual(inv.GlobalTaxCalculation, 'TaxExcluded');
  assert.strictEqual(inv.Line.length, 2);
  assert.strictEqual(r.total, 1164.75);
  assert.ok(r.customerCreated);
  assert.ok(r.link.includes('sandbox') && r.link.includes('555'));
  assert.ok(!r.warning);
  const cust = f.sent.find(s => s.path === '/customer').body;
  assert.strictEqual(cust.BillAddr.PostalCode, '3156');
  assert.strictEqual(cust.BillAddr.City, 'Ferntree Gully');
  assert.ok(f.sent.some(s => s.query && s.query.includes("O\\'Brien")), 'apostrophe escaped');
});

test('reuses an existing customer', async () => {
  const f = fakeQbo({ customers: [{ Id: '42', DisplayName: "Jo O'Brien" }] });
  const c = qbo.client({ http: f.http, env: 'sandbox', realmId: '123', accessToken: 'x' });
  const r = await qbo.createInvoice(c, 'sandbox', input);
  assert.strictEqual(r.customerCreated, false);
  assert.strictEqual(f.sent.find(s => s.path === '/invoice').body.CustomerRef.value, '42');
});

test('does not duplicate an invoice already in QuickBooks', async () => {
  const f = fakeQbo({ existingInvoice: { Id: '9', DocNumber: 'TJS-081', TotalAmt: 1805.5 } });
  const c = qbo.client({ http: f.http, env: 'production', realmId: '123', accessToken: 'x' });
  const r = await qbo.createInvoice(c, 'production', input);
  assert.ok(r.existing);
  assert.ok(!f.sent.some(s => s.path === '/invoice'));
});

test('custom numbers off: TJS number goes in the memo', async () => {
  const f = fakeQbo({ customNumbers: false });
  const c = qbo.client({ http: f.http, env: 'sandbox', realmId: '123', accessToken: 'x' });
  const r = await qbo.createInvoice(c, 'sandbox', input);
  const inv = f.sent.find(s => s.path === '/invoice').body;
  assert.ok(!inv.DocNumber);
  assert.ok(inv.CustomerMemo.value.includes('TJS-081'));
  assert.strictEqual(r.usedTjsNumber, false);
});

test('rejects an empty invoice', async () => {
  const f = fakeQbo();
  const c = qbo.client({ http: f.http, env: 'sandbox', realmId: '123', accessToken: 'x' });
  await assert.rejects(qbo.createInvoice(c, 'sandbox', { lines: [] }));
});
