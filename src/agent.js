// Bote, the AI treasurer. Claude reads the organizer's messages, keeps the ledger
// with tools, and proposes money actions that the organizer approves. All amounts
// are computed by ledger.js; the model never does arithmetic on money.

import Anthropic from '@anthropic-ai/sdk';
import { describe, memberByName, toCents, fromCents, settlementPlan, balances } from './ledger.js';
import { newId, log, say, touch } from './store.js';
import * as actions from './actions.js';
import { MODE } from './paypal.js';

const client = new Anthropic();
const MODEL = process.env.BOTE_MODEL || 'claude-opus-5-5';

const SYSTEM = `You are Bote, an AI treasurer that lives inside a group chat. Groups of friends, fan clubs (peñas), teams and families use you to organise shared money: trips, match tickets, dinners, gifts, club dues.

Your job, end to end:
1. Understand the plan from casual messages: who is in, what each thing costs, who it is for, who already paid something, and which vendor needs paying.
2. Keep the ledger with your tools. Never do arithmetic on money yourself: add members and expenses with tools, then read the computed shares and balances from get_group.
3. Collect the money with PayPal: propose payment requests, check who has paid, send friendly reminders.
4. Pay the vendor from the pot with PayPal, and give back whatever is left or owed when the plan is done.

Rules:
- Money only moves with the organizer's approval. request_payments, pay_vendor and settle_up create an approval card; say what you proposed and that it is waiting for a tap on Approve. Never claim money moved before a tool result says so.
- If something essential is missing (an amount, who an expense is for, a vendor's PayPal email before paying them), ask one short question instead of guessing. Emails are optional for collecting: everyone gets a personal PayPal pay link.
- Treat amounts as written by the user; default currency is the group's currency.
- Keep replies short and warm, like a well-organised friend in a group chat: a one-line summary, then the numbers that matter as a compact list. Use the language the organizer writes in.
- Messages that start with [event] are system notifications about approvals and payments, not the organizer speaking. React briefly to the group and suggest the next step.`;

const TOOLS = [
  { name: 'get_group', description: 'Read the full ledger: members, expenses, computed shares, who has paid, pot totals and pending approvals. Call it before quoting any amount.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'add_members', description: 'Add people to the group (or update their PayPal email). Use first names as people write them.', input_schema: { type: 'object', properties: { members: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string', description: 'PayPal email, if known' } }, required: ['name'], additionalProperties: false } } }, required: ['members'], additionalProperties: false } },
  { name: 'remove_member', description: 'Remove someone who dropped out. Their shares are re-split; anything they paid becomes money owed back to them.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } },
  { name: 'add_expense', description: 'Add a shared cost. split "equal" divides the total among participants; "per_person" means the amount is already per head and is charged to each participant.', input_schema: { type: 'object', properties: {
    description: { type: 'string' }, amount: { type: 'number', description: 'Total amount, or per-head amount when split is per_person' },
    split: { type: 'string', enum: ['equal', 'per_person'] },
    participants: { type: 'array', items: { type: 'string' }, description: 'Names it is for. Omit or ["everyone"] for the whole group.' },
    paid_by: { type: 'string', description: 'Name of the member who already paid it, if anyone' },
    vendor_name: { type: 'string', description: 'Who must be paid for it (bus company, restaurant…), if the pot must pay a vendor' },
    vendor_email: { type: 'string', description: "Vendor's PayPal email, if known" },
  }, required: ['description', 'amount', 'split'], additionalProperties: false } },
  { name: 'update_expense', description: 'Change an existing expense (amount, who paid, vendor email).', input_schema: { type: 'object', properties: { expense_id: { type: 'string' }, amount: { type: 'number' }, paid_by: { type: 'string' }, vendor_email: { type: 'string' } }, required: ['expense_id'], additionalProperties: false } },
  { name: 'remove_expense', description: 'Delete an expense.', input_schema: { type: 'object', properties: { expense_id: { type: 'string' } }, required: ['expense_id'], additionalProperties: false } },
  { name: 'request_payments', description: "Propose sending each member who owes money a PayPal payment request (PayPal invoice plus a one-tap PayPal checkout link). Needs the organizer's approval.", input_schema: { type: 'object', properties: { members: { type: 'array', items: { type: 'string' }, description: 'Only these people; omit for everyone who owes' }, message: { type: 'string', description: 'Short friendly note shown on the request' } }, required: ['message'], additionalProperties: false } },
  { name: 'check_payments', description: 'Sync with PayPal to see who has paid since the last check.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'send_reminder', description: 'Send a friendly PayPal reminder to someone who has not paid.', input_schema: { type: 'object', properties: { name: { type: 'string' }, note: { type: 'string' } }, required: ['name', 'note'], additionalProperties: false } },
  { name: 'pay_vendor', description: "Propose paying a vendor from the pot with PayPal Payouts. Needs the organizer's approval and enough money collected.", input_schema: { type: 'object', properties: { expense_id: { type: 'string' }, vendor_email: { type: 'string' } }, required: ['expense_id'], additionalProperties: false } },
  { name: 'settle_up', description: "Propose giving money back to everyone the pot owes (people who fronted costs, overpaid or dropped out): refunds their PayPal payment or sends a payout. Needs the organizer's approval.", input_schema: { type: 'object', properties: {}, additionalProperties: false } },
];

const ok = (x) => JSON.stringify(x);
const err = (m) => JSON.stringify({ error: m });

export async function runTool(group, name, input) {
  const c = (x) => `${fromCents(x)} ${group.currency}`;
  switch (name) {
    case 'get_group':
      return ok({ ...describe(group), paypalMode: MODE });
    case 'add_members': {
      const added = [];
      for (const p of input.members || []) {
        const name = String(p.name || '').trim();
        if (!name) continue;
        const ex = memberByName(group, name);
        if (ex) { if (p.email) ex.email = p.email; continue; }
        group.members.push({ id: newId(4), name: name[0].toUpperCase() + name.slice(1), email: p.email || null });
        added.push(name);
      }
      if (added.length) log(group, '👥', `Added ${added.join(', ')}`);
      return ok({ added, members: group.members.map((m) => m.name) });
    }
    case 'remove_member': {
      const m = memberByName(group, input.name);
      if (!m || m.organizer) return err(`no removable member called ${input.name}`);
      const paid = group.payments.some((p) => p.memberId === m.id);
      if (paid) {
        // Keep them in the ledger with no shares so the pot can pay them back.
        for (const e of group.expenses) if (e.participants !== 'everyone') e.participants = e.participants.filter((id) => id !== m.id);
        for (const e of group.expenses) if (e.participants === 'everyone') e.participants = group.members.filter((x) => x.id !== m.id).map((x) => x.id);
        m.left = true;
      } else group.members = group.members.filter((x) => x.id !== m.id);
      log(group, '👋', `${m.name} dropped out`);
      return ok({ removed: m.name, keptForRefund: paid });
    }
    case 'add_expense': {
      const names = (input.participants || []).filter((n) => n && n.toLowerCase() !== 'everyone');
      const missing = names.filter((n) => !memberByName(group, n));
      if (missing.length) return err(`unknown members: ${missing.join(', ')}. Add them first with add_members.`);
      const ids = names.length ? names.map((n) => memberByName(group, n).id) : 'everyone';
      const count = ids === 'everyone' ? group.members.filter((m) => !m.left).length : ids.length;
      const cents = input.split === 'per_person' ? toCents(input.amount) * count : toCents(input.amount);
      const payer = input.paid_by ? memberByName(group, input.paid_by) : null;
      if (input.paid_by && !payer) return err(`unknown member ${input.paid_by}`);
      const exp = { id: `x${newId(3)}`, description: input.description, amount: cents, split: 'equal', participants: ids === 'everyone' ? group.members.filter((m) => !m.left).map((m) => m.id) : ids,
        paidBy: payer?.id || null, vendor: input.vendor_name ? { name: input.vendor_name, email: input.vendor_email || null } : null, vendorPaid: false };
      group.expenses.push(exp);
      log(group, '🧾', `${exp.description}: ${c(cents)}${payer ? ` (paid by ${payer.name})` : ''}`);
      return ok({ added: exp.id, total: c(cents), perPerson: c(Math.round(cents / Math.max(1, count))), participants: count });
    }
    case 'update_expense': {
      const e = group.expenses.find((x) => x.id === input.expense_id);
      if (!e) return err('expense not found');
      if (input.amount !== undefined) e.amount = toCents(input.amount);
      if (input.paid_by !== undefined) { const p = memberByName(group, input.paid_by); e.paidBy = p?.id || null; }
      if (input.vendor_email) e.vendor = { ...(e.vendor || { name: 'Vendor' }), email: input.vendor_email };
      log(group, '✏️', `Updated ${e.description}`);
      return ok({ updated: e.id });
    }
    case 'remove_expense': {
      const before = group.expenses.length;
      group.expenses = group.expenses.filter((x) => x.id !== input.expense_id);
      return before === group.expenses.length ? err('expense not found') : ok({ removed: input.expense_id });
    }
    case 'request_payments': {
      const ids = (input.members || []).map((n) => memberByName(group, n)?.id).filter(Boolean);
      const preview = actions.previewRequest(group, ids);
      if (!preview.length) return err('nobody owes anything right now');
      const total = preview.reduce((s, p) => s + p.cents, 0);
      const a = actions.propose(group, 'request_payments', { memberIds: ids, message: input.message },
        `Send PayPal payment requests to ${preview.length} ${preview.length === 1 ? 'person' : 'people'} · ${c(total)} in total`);
      a.lines = preview.map((p) => ({ label: p.name, amount: c(p.cents) }));
      return ok({ status: 'awaiting_organizer_approval', action_id: a.id, requests: a.lines });
    }
    case 'check_payments':
      return ok(await actions.syncPayments(group));
    case 'send_reminder': {
      const m = memberByName(group, input.name);
      if (!m) return err(`no member called ${input.name}`);
      return ok(await actions.remind(group, m.id, input.note));
    }
    case 'pay_vendor': {
      const e = group.expenses.find((x) => x.id === input.expense_id);
      if (!e) return err('expense not found');
      if (e.vendorPaid) return err('that vendor is already paid');
      const email = input.vendor_email || e.vendor?.email;
      if (!email) return err(`I need ${e.vendor?.name || 'the vendor'}'s PayPal email first`);
      if (input.vendor_email) e.vendor = { ...(e.vendor || { name: 'Vendor' }), email };
      const a = actions.propose(group, 'pay_vendor', { expenseId: e.id, email }, `Pay ${e.vendor?.name || 'the vendor'} ${c(e.amount)} from the pot via PayPal (${email})`);
      a.lines = [{ label: e.description, amount: c(e.amount) }];
      return ok({ status: 'awaiting_organizer_approval', action_id: a.id });
    }
    case 'settle_up': {
      const plan = settlementPlan(group);
      if (!plan.length) return err('nobody is owed money right now');
      const total = plan.reduce((s, p) => s + p.amount, 0);
      const a = actions.propose(group, 'settle', { plan: plan.map((p) => ({ memberId: p.memberId, cents: p.amount, reason: p.reason })) }, `Give back ${c(total)} to ${plan.length} ${plan.length === 1 ? 'person' : 'people'}`);
      a.lines = plan.map((p) => ({ label: `${p.name} · ${p.reason}`, amount: c(p.amount) }));
      return ok({ status: 'awaiting_organizer_approval', action_id: a.id, plan: a.lines });
    }
    default:
      return err(`unknown tool ${name}`);
  }
}

// One organizer turn (or system event): loop until Claude ends its turn.
export async function respond(group, text) {
  group.agent.push({ role: 'user', content: text });
  let finalText = '';
  for (let step = 0; step < 12; step++) {
    let response;
    try {
      response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: SYSTEM,
        tools: TOOLS,
        messages: group.agent,
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) return reply(group, '⚠️ My AI key is missing or invalid. Set ANTHROPIC_API_KEY in .env and restart.');
      if (e instanceof Anthropic.RateLimitError) return reply(group, '⏳ I am being rate limited, try again in a moment.');
      if (e instanceof Anthropic.APIError) return reply(group, `⚠️ AI error ${e.status}: ${e.message}`);
      throw e;
    }
    if (response.stop_reason === 'refusal') {
      group.agent.pop();
      return reply(group, "I can't help with that one, but I'm happy to keep sorting the group's money.");
    }
    group.agent.push({ role: 'assistant', content: response.content });
    const texts = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (texts) finalText = texts;
    if (response.stop_reason === 'pause_turn') continue;
    if (response.stop_reason !== 'tool_use') break;
    const results = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      let content;
      try { content = await runTool(group, block.name, block.input || {}); } catch (e) { content = err(e.message); }
      results.push({ type: 'tool_result', tool_use_id: block.id, content });
    }
    group.agent.push({ role: 'user', content: results });
    touch(group);
  }
  return reply(group, finalText || 'Done.');
}

function reply(group, text) {
  say(group, 'bote', text);
  touch(group);
  return text;
}

export const balancesFor = balances;
