// Group money ledger. The AI decides *what* the plan is; this file does all the
// arithmetic, in integer cents, so a language model never adds up money.

export const toCents = (v) => Math.round(Number(v) * 100);
export const fromCents = (c) => (c / 100).toFixed(2);

export function memberByName(group, name) {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  return group.members.find((m) => m.name.toLowerCase() === n)
    || group.members.find((m) => m.name.toLowerCase().split(' ')[0] === n.split(' ')[0])
    || null;
}

// Split `cents` across `ids` as evenly as possible; leftover cents go to the first members.
function splitEven(cents, ids) {
  const out = {};
  if (!ids.length) return out;
  const base = Math.floor(cents / ids.length);
  let rest = cents - base * ids.length;
  for (const id of ids) {
    out[id] = base + (rest > 0 ? 1 : 0);
    if (rest > 0) rest--;
  }
  return out;
}

export function participantsOf(group, exp) {
  if (!exp.participants || exp.participants === 'everyone') return group.members.map((m) => m.id);
  return exp.participants.filter((id) => group.members.some((m) => m.id === id));
}

// Per member: what they owe in shares, what they fronted, paid in, and got back.
export function balances(group) {
  const rows = Object.fromEntries(group.members.map((m) => [m.id, {
    id: m.id, name: m.name, email: m.email || null, organizer: !!m.organizer,
    share: 0, fronted: 0, paidIn: 0, refunded: 0, items: [],
  }]));
  for (const exp of group.expenses) {
    const ids = participantsOf(group, exp);
    const shares = exp.split === 'custom' && exp.custom ? exp.custom : splitEven(exp.amount, ids);
    for (const [id, c] of Object.entries(shares)) {
      if (!rows[id]) continue;
      rows[id].share += c;
      rows[id].items.push({ expense: exp.description, cents: c });
    }
    if (exp.paidBy && rows[exp.paidBy]) rows[exp.paidBy].fronted += exp.amount;
  }
  for (const p of group.payments) if (p.status === 'COMPLETED' && rows[p.memberId]) rows[p.memberId].paidIn += p.amount;
  for (const r of group.payouts) if (r.kind === 'refund' && r.status !== 'FAILED' && rows[r.memberId]) rows[r.memberId].refunded += r.amount;
  for (const row of Object.values(rows)) {
    // The organizer holds the pot, so their own share is settled by definition.
    const effectiveShare = row.organizer ? 0 : row.share;
    const effectiveFronted = row.organizer ? 0 : row.fronted;
    row.due = effectiveShare - effectiveFronted - row.paidIn + row.refunded; // > 0 owes the pot, < 0 the pot owes them
    row.status = row.organizer ? 'organizer' : row.due > 0 ? (row.paidIn > 0 ? 'partial' : 'pending') : row.due < 0 ? 'owed' : 'settled';
  }
  return rows;
}

export function potSummary(group) {
  const b = balances(group);
  const total = group.expenses.reduce((s, e) => s + e.amount, 0);
  const collected = group.payments.filter((p) => p.status === 'COMPLETED').reduce((s, p) => s + p.amount, 0);
  const vendorPaid = group.payouts.filter((p) => p.kind === 'vendor' && p.status !== 'FAILED').reduce((s, p) => s + p.amount, 0);
  const refunded = group.payouts.filter((p) => p.kind === 'refund' && p.status !== 'FAILED').reduce((s, p) => s + p.amount, 0);
  const outstanding = Object.values(b).filter((r) => r.due > 0).reduce((s, r) => s + r.due, 0);
  const owedToMembers = Object.values(b).filter((r) => r.due < 0).reduce((s, r) => s - r.due, 0);
  const toCollect = Object.values(b).filter((r) => !r.organizer).reduce((s, r) => s + Math.max(0, r.share - r.fronted), 0);
  const vendorsDue = group.expenses.filter((e) => e.vendor && !e.vendorPaid && !e.paidBy).reduce((s, e) => s + e.amount, 0);
  return { total, collected, vendorPaid, refunded, outstanding, owedToMembers, toCollect, vendorsDue, cash: collected - vendorPaid - refunded, balances: b };
}

// Leftover cash after every vendor is paid, shared back by each member's share.
export function settlementPlan(group) {
  const s = potSummary(group);
  const plan = [];
  for (const r of Object.values(s.balances)) if (r.due < 0) plan.push({ memberId: r.id, name: r.name, amount: -r.due, reason: r.fronted ? 'reimburse what they fronted' : 'overpaid' });
  return plan;
}

export function describe(group) {
  const s = potSummary(group);
  const c = (x) => `${fromCents(x)} ${group.currency}`;
  return {
    group: group.name, currency: group.currency, organizer: group.members.find((m) => m.organizer)?.name,
    members: group.members.map((m) => ({ name: m.name, email: m.email || null, organizer: !!m.organizer })),
    expenses: group.expenses.map((e) => ({ id: e.id, description: e.description, amount: c(e.amount), split: e.split,
      participants: e.participants === 'everyone' ? 'everyone' : e.participants.map((id) => group.members.find((m) => m.id === id)?.name),
      paidBy: e.paidBy ? group.members.find((m) => m.id === e.paidBy)?.name : null,
      vendor: e.vendor ? { name: e.vendor.name, email: e.vendor.email || null, paid: !!e.vendorPaid } : null })),
    balances: Object.values(s.balances).map((r) => ({ name: r.name, share: c(r.share), fronted: c(r.fronted), paidIn: c(r.paidIn), refunded: c(r.refunded), due: c(r.due), status: r.status,
      paymentRequest: group.requests[r.id] ? { status: group.requests[r.id].status, amount: c(group.requests[r.id].amount) } : null })),
    pot: { total: c(s.total), toCollect: c(s.toCollect), collected: c(s.collected), outstanding: c(s.outstanding), vendorsDue: c(s.vendorsDue), vendorPaid: c(s.vendorPaid), refunded: c(s.refunded), cashInPot: c(s.cash), owedToMembers: c(s.owedToMembers) },
    pendingApprovals: group.actions.filter((a) => a.status === 'pending').map((a) => ({ id: a.id, summary: a.summary })),
  };
}
