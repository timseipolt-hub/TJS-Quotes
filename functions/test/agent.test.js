const test = require('node:test');
const assert = require('node:assert');
const agent = require('../agent');

const QUOTES = [
  { qno: 'TJS-080', qdate: '2026-09-01', status: 'accepted', cname: 'A Smith', csub: 'Ballarat', services: ['Fencing'], grand: 3300,
    items: [{ desc: 'Supply & install Colorbond fence 1.8m', unit: 'm', qty: 20, unitCost: 165, price: 3300 }], savedAtMs: 2 },
  { qno: 'TJS-075', qdate: '2026-08-01', status: 'sent', cname: 'B Jones', csub: 'Sebastopol', services: ['Painting & Plastering'], grand: 900,
    items: [{ desc: 'Paint bedroom walls', unit: 'm²', qty: 30, unitCost: 30, price: 900 }], savedAtMs: 1 }
];

// Fake Anthropic client that replays scripted responses and records requests
function fakeClient(responses) {
  const calls = [];
  return { calls, beta: { messages: { create: async p => { calls.push(JSON.parse(JSON.stringify(p))); return responses.shift(); } } } };
}
const resp = (content, stop) => ({ content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } });

test('searchQuotes ranks by keyword and returns unit costs', () => {
  const r = agent.searchQuotes(QUOTES, { query: 'colorbond fence' });
  assert.strictEqual(r.matches, 1);
  assert.strictEqual(r.quotes[0].qno, 'TJS-080');
  assert.strictEqual(r.quotes[0].items[0].unitCost, 165);
  assert.strictEqual(agent.searchQuotes(QUOTES, { query: 'roofing' }).matches, 0);
});

test('applyUpdate validates and merges', () => {
  const d = {};
  const problems = agent.applyUpdate(d, {
    client: { name: ' Jo ' }, services: ['Fencing', 'Roofing'], pbasis: 'Whatever',
    items: Array.from({ length: 12 }, (_, i) => ({ desc: 'x' + i, unit: 'ea', qty: 1, unitCost: 10.005 }))
  });
  assert.strictEqual(d.cname, 'Jo');
  assert.deepStrictEqual(d.services, ['Fencing']);
  assert.strictEqual(d.items.length, 10);
  assert.strictEqual(d.pbasis, undefined);
  assert.ok(problems.some(p => p.includes('services')));
  assert.ok(problems.some(p => p.includes('pbasis')));
  assert.ok(problems.some(p => p.includes('first 10')));
  assert.strictEqual(d.caddr, undefined, 'untouched fields stay out of the draft');
});

test('runTurn runs tools, returns draft, reply and full transcript', async () => {
  const client = fakeClient([
    resp([{ type: 'tool_use', id: 't1', name: 'search_past_quotes', input: { query: 'fence' } },
          { type: 'tool_use', id: 't2', name: 'get_business_settings', input: {} }], 'tool_use'),
    resp([{ type: 'tool_use', id: 't3', name: 'update_quote', input: { services: ['Fencing'], pbasis: 'Fixed Price',
          items: [{ desc: 'Colorbond fence', unit: 'm', qty: 10, unitCost: 165 }] } }], 'tool_use'),
    resp([{ type: 'text', text: 'Drafted: 10 m at $165/m, total $1,650.' }], 'end_turn')
  ]);
  const r = await agent.runTurn({ client, loadQuotes: async () => QUOTES, loadRate: async () => 75 },
    { text: '10m colorbond fence', form: { cname: 'Jo', items: [] }, today: '2026-11-25' });
  assert.strictEqual(r.reply, 'Drafted: 10 m at $165/m, total $1,650.');
  assert.strictEqual(r.draft.items[0].unitCost, 165);
  assert.strictEqual(r.messages.length, 6);
  const tr = client.calls[1].messages[2].content;
  assert.strictEqual(tr.length, 2, 'parallel tool results go back in one message');
  assert.ok(JSON.parse(tr[1].content).hourlyRateIncGst === 82.5);
  assert.match(JSON.parse(client.calls[2].messages[4].content[0].content).quoteTotal, /1,650\.00/);
  assert.match(client.calls[0].messages[0].content.at(-1).text, /<quote_form date="2026-11-25">/);
  assert.strictEqual(client.calls[0].model, 'claude-opus-5-5');
});

test('next turn appends to the returned transcript', async () => {
  const client = fakeClient([resp([{ type: 'text', text: 'Done' }], 'end_turn')]);
  const prior = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }];
  const r = await agent.runTurn({ client, loadQuotes: async () => [], loadRate: async () => null },
    { messages: prior, text: 'make it cheaper', form: {}, images: [{ mediaType: 'image/jpeg', data: 'AAAA' }, { mediaType: 'text/html', data: 'x' }] });
  assert.strictEqual(r.messages.length, 4);
  assert.deepStrictEqual(client.calls[0].messages.slice(0, 2), prior);
  const content = client.calls[0].messages[2].content;
  assert.strictEqual(content.filter(c => c.type === 'image').length, 1);
});

test('refusal returns a note instead of crashing', async () => {
  const client = fakeClient([resp([], 'refusal')]);
  const r = await agent.runTurn({ client, loadQuotes: async () => [], loadRate: async () => null }, { text: 'x', form: {} });
  assert.match(r.reply, /declined/);
});
