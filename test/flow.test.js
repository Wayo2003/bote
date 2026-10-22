// End-to-end ledger + PayPal (mock mode) flow, driven through the agent's own tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.BOTE_DATA = './data/test-groups.json';
delete process.env.PAYPAL_CLIENT_ID;
const store = await import('../src/store.js');
const { runTool } = await import('../src/agent.js');
const actions = await import('../src/actions.js');
const { potSummary, balances } = await import('../src/ledger.js');
const paypal = await import('../src/paypal.js');

const J = (s) => JSON.parse(s);

test('derby trip: collect, pay the bus, give back the rest', async () => {
  const g = store.createGroup({ name: 'Derby trip', currency: 'EUR', organizer: { name: 'Álvaro' } });
  await runTool(g, 'add_members', { members: ['Juan', 'Pedro', 'Lucía', 'Marta', 'Omar'].map((name) => ({ name, email: `${name.toLowerCase()}@example.com` })) });
  J(await runTool(g, 'add_expense', { description: 'Match tickets', amount: 45, split: 'per_person' }));
  J(await runTool(g, 'add_expense', { description: 'Bus', amount: 300, split: 'equal', vendor_name: 'Autocares Triana', vendor_email: 'bus@example.com' }));
  J(await runTool(g, 'add_expense', { description: 'Snacks', amount: 60, split: 'equal', paid_by: 'Juan' }));
  const s = potSummary(g);
  assert.equal(s.total, 6 * 4500 + 30000 + 6000);
  const b = balances(g);
  const juan = Object.values(b).find((r) => r.name === 'Juan');
  const pedro = Object.values(b).find((r) => r.name === 'Pedro');
  assert.equal(pedro.due, 4500 + 5000 + 1000);   // 105.00
  assert.equal(juan.due, 4500 + 5000 + 1000 - 6000); // fronted the snacks: 45.00

  const req = J(await runTool(g, 'request_payments', { message: 'Derby time!' }));
  assert.equal(req.status, 'awaiting_organizer_approval');
  const a = g.actions.at(-1);
  await actions.execute(g, a);
  assert.equal(Object.keys(g.requests).length, 5);

  // Everyone pays through their pay link (Orders API, mocked).
  for (const m of g.members.filter((x) => !x.organizer)) {
    const due = balances(g)[m.id].due;
    const o = await paypal.createOrder({ cents: due, currency: 'EUR', description: 't', customId: 'x' });
    const c = await paypal.captureOrder(o.id);
    actions.recordPayment(g, m.id, { cents: c.cents, source: 'order', paypalId: o.id, captureId: c.captureId });
  }
  assert.equal(potSummary(g).outstanding, 0);

  const bus = g.expenses.find((e) => e.description === 'Bus');
  J(await runTool(g, 'pay_vendor', { expense_id: bus.id }));
  await actions.execute(g, g.actions.at(-1));
  assert.ok(bus.vendorPaid);

  // The bus company charged 300 but Pedro drops out after paying: he is owed his money back.
  J(await runTool(g, 'remove_member', { name: 'Pedro' }));
  const plan = J(await runTool(g, 'settle_up', {}));
  assert.equal(plan.status, 'awaiting_organizer_approval');
  await actions.execute(g, g.actions.at(-1));
  for (const r of Object.values(balances(g))) assert.ok(r.organizer || r.due >= 0, `${r.name} still owed ${r.due}`);
});
