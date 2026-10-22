// Money-moving actions. The agent can only *propose* these; they run when the
// organizer taps Approve. Everything here talks to PayPal and updates the ledger.

import * as paypal from './paypal.js';
import { balances, potSummary, settlementPlan, fromCents } from './ledger.js';
import { newId, log, say, touch } from './store.js';

const PUBLIC_URL = () => process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3500}`;
export const payLink = (group, memberId) => `${PUBLIC_URL()}/pay/${group.id}/${memberId}`;
const fmt = (group, cents) => `${fromCents(cents)} ${group.currency}`;

// ---------------------------------------------------------------- proposals (agent side)

export function propose(group, type, params, summary) {
  const a = { id: newId(4), type, params, summary, status: 'pending', at: Date.now() };
  group.actions.push(a);
  touch(group);
  return a;
}

// What each proposal would do, computed now so the approval card shows exact numbers.
export function previewRequest(group, memberIds) {
  const b = balances(group);
  const targets = group.members.filter((m) => !m.organizer && b[m.id].due > 0 && (!memberIds?.length || memberIds.includes(m.id)));
  return targets.map((m) => ({ memberId: m.id, name: m.name, email: m.email || null, cents: b[m.id].due }));
}

// ---------------------------------------------------------------- execution (after approval)

export async function execute(group, action) {
  const p = action.params;
  if (action.type === 'request_payments') return requestPayments(group, p.memberIds, p.message);
  if (action.type === 'pay_vendor') return payVendor(group, p.expenseId, p.email);
  if (action.type === 'settle') return settle(group, p.plan);
  if (action.type === 'refund') return refund(group, p.memberId, p.cents, p.reason);
  throw new Error(`unknown action ${action.type}`);
}

export async function requestPayments(group, memberIds, message) {
  const targets = previewRequest(group, memberIds);
  const out = [];
  for (const t of targets) {
    const m = group.members.find((x) => x.id === t.memberId);
    const prev = group.requests[m.id];
    if (prev?.invoiceId && prev.status !== 'PAID') { try { await paypal.cancelInvoice(prev.invoiceId); } catch {} }
    let invoice = { id: null, payerUrl: null };
    try {
      invoice = await paypal.sendInvoice({ cents: t.cents, currency: group.currency, description: `${group.name}: your share`, groupName: group.name, recipient: { name: m.name, email: m.email }, note: message });
    } catch (e) {
      log(group, '⚠️', `Invoice for ${m.name} failed: ${e.message}`);
    }
    group.requests[m.id] = { amount: t.cents, invoiceId: invoice.id, payerUrl: invoice.payerUrl, payLink: payLink(group, m.id), status: 'SENT', at: Date.now(), reminders: 0 };
    log(group, '📨', `Payment request: ${m.name} · ${fmt(group, t.cents)}${invoice.id ? ` · PayPal invoice ${invoice.id}` : ''}`);
    out.push({ name: m.name, amount: fmt(group, t.cents), invoice: invoice.id, link: payLink(group, m.id) });
  }
  touch(group);
  return { sent: out.length, requests: out };
}

export function recordPayment(group, memberId, { cents, source, paypalId, captureId, payer }) {
  if (group.payments.some((x) => x.paypalId && x.paypalId === paypalId)) return null;
  const pay = { id: newId(4), memberId, amount: cents, source, paypalId, captureId, payer, status: 'COMPLETED', at: Date.now() };
  group.payments.push(pay);
  const req = group.requests[memberId];
  const due = balances(group)[memberId].due;
  if (req) req.status = due <= 0 ? 'PAID' : 'PARTIAL';
  const m = group.members.find((x) => x.id === memberId);
  log(group, '✅', `${m.name} paid ${fmt(group, cents)} via PayPal (${source === 'order' ? 'checkout' : 'invoice'})`);
  touch(group, 'payment');
  return pay;
}

export async function syncPayments(group) {
  const changes = [];
  for (const [memberId, req] of Object.entries(group.requests)) {
    if (!req.invoiceId || req.status === 'PAID') continue;
    try {
      const inv = await paypal.getInvoice(req.invoiceId);
      if ((inv.status === 'PAID' || inv.status === 'MARKED_AS_PAID') && !group.payments.some((x) => x.paypalId === req.invoiceId)) {
        recordPayment(group, memberId, { cents: inv.paidCents || req.amount, source: 'invoice', paypalId: req.invoiceId });
        changes.push(memberId);
      }
    } catch (e) {
      log(group, '⚠️', `Could not check invoice ${req.invoiceId}: ${e.message}`);
    }
  }
  touch(group);
  return { checked: Object.keys(group.requests).length, newlyPaid: changes.map((id) => group.members.find((m) => m.id === id)?.name) };
}

export async function remind(group, memberId, note) {
  const req = group.requests[memberId];
  const m = group.members.find((x) => x.id === memberId);
  if (!req) return { ok: false, error: `${m?.name} has no payment request yet` };
  if (req.invoiceId) { try { await paypal.remindInvoice(req.invoiceId, note); } catch (e) { log(group, '⚠️', `Reminder failed: ${e.message}`); } }
  req.reminders = (req.reminders || 0) + 1;
  log(group, '🔔', `Reminder sent to ${m.name}${req.invoiceId ? ' (PayPal invoice reminder)' : ''}`);
  touch(group);
  return { ok: true, member: m.name, reminders: req.reminders };
}

export async function payVendor(group, expenseId, emailOverride) {
  const exp = group.expenses.find((e) => e.id === expenseId);
  if (!exp) throw new Error('expense not found');
  const email = emailOverride || exp.vendor?.email;
  if (!email) throw new Error(`no PayPal email for ${exp.vendor?.name || exp.description}`);
  const s = potSummary(group);
  if (s.cash < exp.amount) throw new Error(`not enough in the pot: ${fmt(group, s.cash)} available, ${fmt(group, exp.amount)} needed`);
  const r = await paypal.sendPayout({ currency: group.currency, subject: `Payment from ${group.name} via Bote`, items: [{ email, cents: exp.amount, note: exp.description }] });
  group.payouts.push({ id: newId(4), kind: 'vendor', expenseId, email, amount: exp.amount, batchId: r.batchId, status: r.status, at: Date.now() });
  exp.vendorPaid = true;
  log(group, '🏪', `Paid ${exp.vendor?.name || 'vendor'} ${fmt(group, exp.amount)} for "${exp.description}" (PayPal Payouts ${r.batchId})`);
  touch(group);
  return { paid: exp.vendor?.name || email, amount: fmt(group, exp.amount), batch: r.batchId };
}

export async function refund(group, memberId, cents, reason) {
  const m = group.members.find((x) => x.id === memberId);
  // Prefer refunding the member's own captured PayPal payment; fall back to a payout.
  const cap = group.payments.filter((p) => p.memberId === memberId && p.captureId && p.amount >= cents).pop();
  let ref;
  if (cap) {
    const r = await paypal.refundCapture({ captureId: cap.captureId, cents, currency: group.currency, note: reason });
    ref = { method: 'refund', paypalId: r.id, status: r.status };
  } else {
    if (!m.email) throw new Error(`${m.name} has no PayPal email to send money to`);
    const r = await paypal.sendPayout({ currency: group.currency, subject: `${group.name}: money back from Bote`, items: [{ email: m.email, cents, note: reason }] });
    ref = { method: 'payout', paypalId: r.batchId, status: r.status };
  }
  group.payouts.push({ id: newId(4), kind: 'refund', memberId, amount: cents, reason, ...ref, at: Date.now() });
  log(group, '↩️', `${fmt(group, cents)} back to ${m.name} (${ref.method === 'refund' ? 'refund of their PayPal payment' : 'PayPal payout'}) · ${reason}`);
  touch(group);
  return { member: m.name, amount: fmt(group, cents), method: ref.method };
}

export async function settle(group, plan) {
  const items = plan || settlementPlan(group).map((x) => ({ memberId: x.memberId, cents: x.amount, reason: x.reason }));
  const done = [];
  for (const it of items) done.push(await refund(group, it.memberId, it.cents ?? it.amount, it.reason));
  return { settled: done };
}
