// Bote server: tiny HTTP API + server-sent events. No framework.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './src/store.js';
import * as paypal from './src/paypal.js';
import * as actions from './src/actions.js';
import { respond, PROVIDER } from './src/agent.js';
import { potSummary, describe, balances, fromCents } from './src/ledger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(here, 'public');
const PORT = Number(process.env.PORT || 3500);

// One agent turn at a time per group, in arrival order.
const queues = new Map();
const thinking = new Map();
function enqueue(group, text) {
  const prev = queues.get(group.id) || Promise.resolve();
  const next = prev.then(async () => {
    thinking.set(group.id, true); store.touch(group, 'thinking');
    try { await respond(group, text); } catch (e) { console.error(e); store.say(group, 'bote', `⚠️ ${e.message}`); }
    finally { thinking.set(group.id, false); store.touch(group, 'thinking'); }
  });
  queues.set(group.id, next.catch(() => {}));
  return next;
}

function view(group) {
  const s = potSummary(group);
  const b = balances(group);
  return {
    id: group.id, name: group.name, currency: group.currency, mode: paypal.MODE, thinking: !!thinking.get(group.id),
    members: group.members.map((m) => ({ ...m, ...b[m.id], request: group.requests[m.id] || null, payLink: actions.payLink(group, m.id) })),
    expenses: group.expenses.map((e) => ({ ...e, paidByName: group.members.find((m) => m.id === e.paidBy)?.name || null })),
    pot: { total: s.total, toCollect: s.toCollect, collected: s.collected, outstanding: s.outstanding, vendorsDue: s.vendorsDue, vendorPaid: s.vendorPaid, refunded: s.refunded, cash: s.cash, owedToMembers: s.owedToMembers },
    actions: group.actions.slice(-20), activity: group.activity.slice(0, 40), chat: group.chat.slice(-80),
  };
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const readBody = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
});
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (url.pathname === '/api/config') return send(res, 200, { mode: paypal.MODE, clientId: paypal.CLIENT_ID, ai: PROVIDER });

    if (url.pathname === '/api/groups' && req.method === 'POST') {
      const b = await readBody(req);
      const g = store.createGroup({ name: b.name, currency: b.currency || 'EUR', organizer: { name: b.organizerName, email: b.organizerEmail } });
      store.say(g, 'bote', `Hi ${g.members[0].name}! I'm Bote, the treasurer for "${g.name}". Tell me the plan in your own words: who's in, what it costs and who already paid something. I'll do the maths, collect with PayPal, pay the vendors and give back whatever is left.`);
      store.touch(g);
      return send(res, 200, { id: g.id });
    }

    if (parts[0] === 'api' && parts[1] === 'groups' && parts[2]) {
      const g = store.getGroup(parts[2]);
      if (!g) return send(res, 404, { error: 'group not found' });
      const sub = parts[3];
      if (!sub) return send(res, 200, view(g));
      if (sub === 'stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const push = () => res.write(`data: ${JSON.stringify(view(g))}\n\n`);
        push();
        const off = store.subscribe(g.id, push);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { off(); clearInterval(ping); });
        return;
      }
      if (sub === 'chat' && req.method === 'POST') {
        const b = await readBody(req);
        const text = String(b.text || '').trim().slice(0, 4000);
        if (!text) return send(res, 400, { error: 'empty' });
        store.say(g, 'organizer', text);
        store.touch(g);
        enqueue(g, text);
        return send(res, 202, { ok: true });
      }
      if (sub === 'actions' && parts[4] && req.method === 'POST') {
        const a = g.actions.find((x) => x.id === parts[4]);
        if (!a || a.status !== 'pending') return send(res, 409, { error: 'action not pending' });
        if (parts[5] === 'reject') {
          a.status = 'rejected'; store.log(g, '✋', `Organizer declined: ${a.summary}`); store.touch(g);
          enqueue(g, `[event] The organizer declined: ${a.summary}.`);
          return send(res, 200, { ok: true });
        }
        a.status = 'running'; store.touch(g);
        try {
          a.result = await actions.execute(g, a);
          a.status = 'done';
          store.touch(g);
          enqueue(g, `[event] The organizer approved "${a.summary}". Result: ${JSON.stringify(a.result)}`);
          return send(res, 200, { ok: true, result: a.result });
        } catch (e) {
          a.status = 'failed'; a.error = e.message; store.log(g, '⚠️', `${a.summary} failed: ${e.message}`); store.touch(g);
          enqueue(g, `[event] "${a.summary}" failed: ${e.message}`);
          return send(res, 200, { ok: false, error: e.message });
        }
      }
      if (sub === 'sync' && req.method === 'POST') return send(res, 200, await actions.syncPayments(g));
    }

    // Member payment page API
    if (parts[0] === 'api' && parts[1] === 'pay' && parts[2] && parts[3]) {
      const g = store.getGroup(parts[2]);
      const m = g?.members.find((x) => x.id === parts[3]);
      if (!g || !m) return send(res, 404, { error: 'not found' });
      const b = balances(g)[m.id];
      if (!parts[4]) {
        return send(res, 200, { group: g.name, currency: g.currency, member: m.name, organizer: g.members.find((x) => x.organizer)?.name, due: Math.max(0, b.due), share: b.share, fronted: b.fronted, paidIn: b.paidIn,
          items: b.items, mode: paypal.MODE, clientId: paypal.CLIENT_ID, invoiceUrl: g.requests[m.id]?.payerUrl || null, status: b.status });
      }
      if (parts[4] === 'order' && req.method === 'POST') {
        if (b.due <= 0) return send(res, 409, { error: 'nothing to pay' });
        const o = await paypal.createOrder({ cents: b.due, currency: g.currency, description: `${g.name}: ${m.name}'s share`, customId: `${g.id}:${m.id}` });
        return send(res, 200, o);
      }
      if (parts[4] === 'capture' && req.method === 'POST') {
        const body = await readBody(req);
        const c = await paypal.captureOrder(body.orderId);
        if (c.status !== 'COMPLETED') return send(res, 400, { error: `payment ${c.status}` });
        actions.recordPayment(g, m.id, { cents: c.cents, source: 'order', paypalId: body.orderId, captureId: c.captureId, payer: c.payer });
        enqueue(g, `[event] ${m.name} just paid ${fromCents(c.cents)} ${g.currency} through their PayPal pay link.`);
        return send(res, 200, { ok: true });
      }
    }
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message });
  }

  let file = url.pathname;
  if (file === '/') file = '/index.html';
  else if (/^\/g\/[^/]+$/.test(file)) file = '/group.html';
  else if (/^\/pay\/[^/]+\/[^/]+$/.test(file)) file = '/pay.html';
  const full = path.normalize(path.join(PUB, file));
  if (!full.startsWith(PUB)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(full, (e, buf) => (e ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, buf, TYPES[path.extname(full)] || 'application/octet-stream')));
});

server.listen(PORT, () => console.log(`Bote on http://localhost:${PORT} · PayPal: ${paypal.MODE} · AI: ${PROVIDER}`));
