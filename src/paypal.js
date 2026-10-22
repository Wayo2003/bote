// PayPal REST client (sandbox) with a faithful mock for running without credentials.
// APIs used: OAuth2, Orders v2 (checkout + capture), Payments v2 (refunds),
// Invoicing v2 (invoices + reminders) and Payouts v1 (vendor payments, reimbursements).

import crypto from 'node:crypto';

const BASE = process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
export const MODE = process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET ? 'sandbox' : 'mock';
export const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';

let token = null;
let tokenExp = 0;

async function auth() {
  if (token && Date.now() < tokenExp - 60_000) return token;
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`PayPal auth failed: ${j.error_description || r.status}`);
  token = j.access_token;
  tokenExp = Date.now() + j.expires_in * 1000;
  return token;
}

async function pp(method, path, body, extraHeaders = {}) {
  const t = await auth();
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': crypto.randomUUID(), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const j = text ? JSON.parse(text) : {};
  if (!r.ok) {
    const detail = j.details?.map((d) => d.description || d.issue).join('; ') || j.message || j.name || r.status;
    throw new Error(`PayPal ${method} ${path} failed: ${detail}`);
  }
  return j;
}

const money = (cents, currency) => ({ currency_code: currency, value: (cents / 100).toFixed(2) });
const mockId = (p) => `${p}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
const mock = { orders: new Map(), invoices: new Map(), payouts: new Map() };

// ---------------------------------------------------------------- Orders: one-click pay-in

export async function createOrder({ cents, currency, description, customId }) {
  if (MODE === 'mock') {
    const id = mockId('ORDER');
    mock.orders.set(id, { id, cents, currency, status: 'CREATED', customId });
    return { id, status: 'CREATED' };
  }
  const j = await pp('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{ amount: money(cents, currency), description: description.slice(0, 127), custom_id: customId }],
  });
  return { id: j.id, status: j.status };
}

export async function captureOrder(orderId) {
  if (MODE === 'mock') {
    const o = mock.orders.get(orderId);
    if (!o) throw new Error('order not found');
    o.status = 'COMPLETED';
    return { status: 'COMPLETED', captureId: mockId('CAPTURE'), cents: o.cents, payer: { email: 'buyer@example.com', name: 'Mock Buyer' } };
  }
  const j = await pp('POST', `/v2/checkout/orders/${orderId}/capture`, {});
  const cap = j.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    status: j.status, captureId: cap?.id, cents: cap ? Math.round(Number(cap.amount.value) * 100) : 0,
    payer: { email: j.payer?.email_address, name: [j.payer?.name?.given_name, j.payer?.name?.surname].filter(Boolean).join(' ') },
  };
}

export async function refundCapture({ captureId, cents, currency, note }) {
  if (MODE === 'mock') return { id: mockId('REFUND'), status: 'COMPLETED' };
  const j = await pp('POST', `/v2/payments/captures/${captureId}/refund`, { amount: money(cents, currency), note_to_payer: note?.slice(0, 255) });
  return { id: j.id, status: j.status };
}

// ---------------------------------------------------------------- Invoicing: formal requests + reminders

export async function sendInvoice({ cents, currency, description, groupName, recipient, note }) {
  if (MODE === 'mock') {
    const id = mockId('INV2');
    mock.invoices.set(id, { id, status: 'SENT', cents });
    return { id, status: 'SENT', payerUrl: null };
  }
  const [given, ...rest] = (recipient.name || 'Friend').split(' ');
  const draft = await pp('POST', '/v2/invoicing/invoices', {
    detail: { currency_code: currency, note: note?.slice(0, 4000), memo: `Bote · ${groupName}`, payment_term: { term_type: 'DUE_ON_RECEIPT' } },
    primary_recipients: recipient.email ? [{ billing_info: { name: { given_name: given, surname: rest.join(' ') || undefined }, email_address: recipient.email } }] : undefined,
    items: [{ name: description.slice(0, 200), quantity: '1', unit_amount: money(cents, currency), unit_of_measure: 'AMOUNT' }],
    configuration: { allow_tip: false, partial_payment: { allow_partial_payment: false } },
  });
  const id = draft.id || draft.href?.split('/').pop();
  const sent = await pp('POST', `/v2/invoicing/invoices/${id}/send`, { send_to_recipient: !!recipient.email, send_to_invoicer: false });
  const payerUrl = sent.links?.find((l) => l.rel === 'payer-view')?.href || sent.href || null;
  return { id, status: 'SENT', payerUrl };
}

export async function getInvoice(id) {
  if (MODE === 'mock') return mock.invoices.get(id) || { id, status: 'SENT' };
  const j = await pp('GET', `/v2/invoicing/invoices/${id}`);
  const paid = j.payments?.paid_amount ? Math.round(Number(j.payments.paid_amount.value) * 100) : 0;
  return { id, status: j.status, paidCents: paid, transactions: j.payments?.transactions || [] };
}

export async function remindInvoice(id, note) {
  if (MODE === 'mock') return { ok: true };
  await pp('POST', `/v2/invoicing/invoices/${id}/remind`, { note: note?.slice(0, 4000), send_to_recipient: true, send_to_invoicer: false });
  return { ok: true };
}

export async function cancelInvoice(id) {
  if (MODE === 'mock') { const i = mock.invoices.get(id); if (i) i.status = 'CANCELLED'; return { ok: true }; }
  await pp('POST', `/v2/invoicing/invoices/${id}/cancel`, { send_to_recipient: false, send_to_invoicer: false });
  return { ok: true };
}

export function mockMarkInvoicePaid(id) {
  const i = mock.invoices.get(id);
  if (i) i.status = 'PAID';
}

// ---------------------------------------------------------------- Payouts: pay vendors, reimburse members

export async function sendPayout({ items, currency, subject }) {
  const batchId = `BOTE-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  if (MODE === 'mock') {
    const id = mockId('PAYOUT');
    mock.payouts.set(id, { id, status: 'SUCCESS' });
    return { batchId: id, status: 'SUCCESS' };
  }
  const j = await pp('POST', '/v1/payments/payouts', {
    sender_batch_header: { sender_batch_id: batchId, email_subject: subject.slice(0, 255), email_message: subject.slice(0, 1000) },
    items: items.map((it, i) => ({ recipient_type: 'EMAIL', receiver: it.email, amount: { currency, value: (it.cents / 100).toFixed(2) }, note: it.note?.slice(0, 4000), sender_item_id: `${batchId}-${i}` })),
  });
  return { batchId: j.batch_header?.payout_batch_id, status: j.batch_header?.batch_status };
}

export async function getPayout(batchId) {
  if (MODE === 'mock') return { status: 'SUCCESS' };
  const j = await pp('GET', `/v1/payments/payouts/${batchId}`);
  return { status: j.batch_header?.batch_status, items: j.items?.map((i) => ({ status: i.transaction_status, receiver: i.payout_item?.receiver })) };
}
