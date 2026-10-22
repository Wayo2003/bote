// Groups live in memory and are written to data/groups.json. Listeners get every change (SSE).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { fileURLToPath } from 'node:url';

const FILE = path.resolve(process.env.BOTE_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'groups.json'));
fs.mkdirSync(path.dirname(FILE), { recursive: true });

let groups = {};
try { groups = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { groups = {}; }

const listeners = new Map(); // groupId -> Set<fn>
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(FILE, JSON.stringify(groups), () => {}), 300);
}

export const newId = (n = 6) => crypto.randomBytes(n).toString('hex');

export function createGroup({ name, currency = 'EUR', organizer }) {
  const id = newId(5);
  const orgId = newId(4);
  groups[id] = {
    id, name: name || 'Our group', currency, created: Date.now(),
    members: [{ id: orgId, name: organizer?.name || 'Organizer', email: organizer?.email || null, organizer: true }],
    expenses: [], payments: [], payouts: [], requests: {}, actions: [], activity: [], chat: [], agent: [],
  };
  persist();
  return groups[id];
}

export const getGroup = (id) => groups[id] || null;
export const allGroups = () => Object.values(groups);

export function touch(group, kind = 'update') {
  persist();
  for (const fn of listeners.get(group.id) || []) fn(kind);
}

export function subscribe(id, fn) {
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id).add(fn);
  return () => listeners.get(id).delete(fn);
}

export function log(group, icon, text, extra = {}) {
  group.activity.unshift({ at: Date.now(), icon, text, ...extra });
  group.activity.length = Math.min(group.activity.length, 200);
}

export function say(group, role, text, extra = {}) {
  group.chat.push({ id: newId(4), at: Date.now(), role, text, ...extra });
}
