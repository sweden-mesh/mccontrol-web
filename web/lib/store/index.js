// The screens' memory for one key: devices, groups, command sets, history and meta, each a
// small API over lib/store/db.js. A port of mccontrol/store.py's devices, groups (RM-4), sets
// and history, with records shaped for a later encrypted sync:
//
//   every record   { owner, id, created, updated, ... }   owner = the key's public key (64 hex)
//   device         id = node (8 hex); key (64 hex or null), name, region, notes, ver,
//                  lastSent, lastHeard, lastHeardMqtt, lastHeardMesh (which road it last answered
//                  on), meshOnly (true | false | absent: the version decides),
//                  road ('auto' | 'mqtt' | 'mesh' | absent: the node view's last choice, W-26c),
//                  lastResult { at, command, code, codeName, verified },
//                  reads { command: { reply, at, verified } }, fleet { batteryMv, seen, firmware,
//                  fetched } | null, observerId
//   group          id = name (one word, lower case); members [node]
//   set            id = name; steps [command]; an empty list is a removed set (the shipped one too)
//   history event  id = time-sortable and random, never reused; append-only: an event is written
//                  once and never changed (created === updated). { v: 1, at, batch, node | null,
//                  region, command, topic, code | null, codeName | null, reply | null,
//                  verified: true | false | null, note, road: 'mqtt' | 'mesh' }. Silence is code
//                  null with no reply. An event from before the mesh road (W-16) went over MQTT.
//   meta           id = a name ('lastVisit', 'releases'); value
//
//   const stores = openStores(db, publicKeyHex, { defaultSets });
import { STORES } from './db.js';

export const SCHEMA = 1;
export const SET_STEPS = 6;
const NODE = /^[0-9A-F]{8}$/;
const KEY = /^[0-9A-F]{64}$/;

export function validRegion(region) {
  const r = String(region || '').trim().toUpperCase();
  return /^[A-Z0-9]{2,8}$/.test(r) ? r : null;
}

// A group's or set's name: one word of letters, digits, - _ . in lower case, or null.
export function validName(name) {
  const n = String(name || '').trim().toLowerCase();
  return /^[\p{L}\p{N}_.-]{1,40}$/u.test(n) ? n : null;
}

const randomHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

// An id that sorts by time and never collides between two browsers: base-36 milliseconds and
// 64 random bits.
export function eventId(ms) {
  return `${Math.floor(ms).toString(36).padStart(9, '0')}-${randomHex(8)}`;
}

export function openStores(db, owner, { now = () => Date.now(), defaultSets = {} } = {}) {
  if (!KEY.test(String(owner || '').toUpperCase())) throw new Error('the stores belong to a key: its 64-hex public key');
  const me = owner.toUpperCase();
  const iso = () => new Date(now()).toISOString();
  const stamp = (record, existing) => {
    const at = iso();
    return { ...record, owner: me, created: existing?.created || record.created || at, updated: at };
  };

  // -- devices -------------------------------------------------------------------------------

  const devices = Object.freeze({
    async list() {
      return (await db.list('devices', me)).sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
    },
    get: (node) => db.get('devices', me, String(node || '').toUpperCase()),

    async add({ node, key = null, name = '', region, notes = '' }) {
      const whole = String(key || (String(node).length === 64 ? node : '') || '').toUpperCase() || null;
      const id = String(node || '').toUpperCase().slice(0, 8);
      if (!NODE.test(id)) throw new Error('A node is named by the first 8 hex characters of its public key.');
      if (whole && !KEY.test(whole)) throw new Error('A public key is 64 hex characters.');
      // mcc3 (lou-20 and later) is keyed by the node alone: a whole key needs no region. A
      // region (IATA) is only for the old scheme of lou-19 and older (IATA-2).
      const r = String(region || '').trim() === '' && whole ? '' : validRegion(region);
      if (r === null) throw new Error('A node needs its whole public key (64 hex), or for lou-19 and older its IATA code, e.g. JKG.');
      const all = await devices.list();
      const clean = String(name || '').trim();
      if (all.some((d) => d.id === id)) throw new Error('That node is already in the list.');
      if (clean && all.some((d) => d.name.toLowerCase() === clean.toLowerCase())) {
        throw new Error(`A node named ${clean} already exists.`);
      }
      const record = stamp({
        id, node: id, key: whole, name: clean, region: r, notes: String(notes || '').trim(), ver: null,
        lastSent: null, lastHeard: null, lastResult: null, reads: {}, fleet: null, observerId: null,
      });
      await db.put('devices', record);
      return record;
    },

    async update(node, changes) {
      const existing = await devices.get(node);
      if (!existing) throw new Error('No such node.');
      const next = { ...existing, ...changes, id: existing.id, node: existing.node };
      if ('region' in changes) {
        next.region = String(changes.region || '').trim() === '' && next.key ? '' : validRegion(changes.region);
        if (next.region === null) throw new Error('A region is its IATA code: 2 to 8 letters or digits.');
      }
      if ('name' in changes) {
        next.name = String(changes.name || '').trim();
        const others = (await devices.list()).filter((d) => d.id !== existing.id);
        if (next.name && others.some((d) => d.name.toLowerCase() === next.name.toLowerCase())) {
          throw new Error(`A node named ${next.name} already exists.`);
        }
      }
      const record = stamp(next, existing);
      await db.put('devices', record);
      return record;
    },

    // The mcc3 counter for the node's next command, stored before it is sent:
    // max(now in seconds, highest known + 1), the highest from what was sent and from its alive.
    async nextCounter(node, nowSecs = Math.floor(now() / 1000)) {
      const d = await devices.get(node);
      if (!d) throw new Error('No such node.');
      const known = Math.max(Number(d.counter) || 0, Number(d.alive?.last_counter) || 0);
      const counter = Math.max(nowSecs, known + 1);
      await devices.update(node, { counter });
      return counter;
    },

    // A forgotten node leaves its groups too.
    async remove(node) {
      const id = String(node || '').toUpperCase();
      await db.remove('devices', me, id);
      for (const g of await db.list('groups', me)) {
        if (g.members.includes(id)) await db.put('groups', stamp({ ...g, members: g.members.filter((m) => m !== id) }, g));
      }
    },

    // Keep what a node answered to a read. A refusal, a bad signature or silence is never
    // stored and clears nothing: the last good answer stays, with its age.
    async rememberRead(node, command, reply, verified = null) {
      const existing = await devices.get(node);
      if (!existing) throw new Error('No such node.');
      const key = String(command).split(/\s+/).filter(Boolean).join(' ');
      const reads = { ...(existing.reads || {}), [key]: { reply, at: iso(), verified } };
      return devices.update(node, { reads });
    },
  });

  // -- groups (RM-4): a send to a group is one signed per-node command each, never a broadcast

  const groups = Object.freeze({
    async list() {
      const known = new Set((await devices.list()).map((d) => d.id));
      return (await db.list('groups', me))
        .map((g) => ({ ...g, members: g.members.filter((m) => known.has(m)) }))
        .sort((a, b) => (a.id < b.id ? -1 : 1));
    },
    async get(name) {
      return (await groups.list()).find((g) => g.id === validName(name)) || null;
    },
    async create(name, members = []) {
      const id = validName(name);
      if (!id) throw new Error("A group's name is one word: letters, digits, - _ .");
      if (await db.get('groups', me, id)) throw new Error(`A group named ${id} already exists.`);
      const record = stamp({ id, members: [...new Set(members.map((m) => String(m).toUpperCase()))] });
      await db.put('groups', record);
      return record;
    },
    async change(name, { add = [], remove = [] } = {}) {
      const existing = await db.get('groups', me, validName(name));
      if (!existing) throw new Error(`No group named ${name}.`);
      const out = new Set(remove.map((m) => String(m).toUpperCase()));
      const members = [...new Set([...existing.members, ...add.map((m) => String(m).toUpperCase())])].filter((m) => !out.has(m));
      const record = stamp({ ...existing, members }, existing);
      await db.put('groups', record);
      return record;
    },
    async remove(name) {
      const id = validName(name);
      if (!id || !(await db.get('groups', me, id))) throw new Error(`No group named ${name}.`);
      await db.remove('groups', me, id);
    },
  });

  // -- command sets ----------------------------------------------------------------------------

  const cleanSteps = (steps) => steps.map((s) => String(s).trim()).filter(Boolean);
  const sets = Object.freeze({
    // { name: [steps] }: the shipped sets until removed or replaced, then the owner's.
    async list() {
      const stored = await db.list('sets', me);
      const out = {};
      for (const [name, steps] of Object.entries(defaultSets)) out[name] = cleanSteps(steps);
      for (const s of stored) out[s.id] = cleanSteps(s.steps);
      return Object.fromEntries(Object.entries(out).filter(([, steps]) => steps.length)
        .sort(([a], [b]) => (a < b ? -1 : 1)));
    },
    async save(name, steps) {
      const id = validName(name);
      if (!id) throw new Error("A set's name is one word: letters, digits, - _ .");
      const clean = cleanSteps(steps);
      if (!clean.length) throw new Error('A set needs at least one command.');
      if (clean.length > SET_STEPS) throw new Error(`A set has at most ${SET_STEPS} commands.`);
      const existing = await db.get('sets', me, id);
      const record = stamp({ id, steps: clean }, existing);
      await db.put('sets', record);
      return record;
    },
    async remove(name) {
      const id = validName(name);
      if (!id || !(id in await sets.list())) throw new Error(`No set named ${name}.`);
      const existing = await db.get('sets', me, id);
      await db.put('sets', stamp({ id, steps: [] }, existing));
    },
  });

  // -- history ---------------------------------------------------------------------------------

  const FIELDS = ['at', 'batch', 'node', 'region', 'command', 'topic', 'code', 'codeName', 'reply', 'verified', 'note', 'road'];
  const shape = (event) => {
    const out = { v: SCHEMA };
    for (const f of FIELDS) out[f] = event[f] ?? null;
    out.note = out.note || '';
    out.road = out.road === 'mesh' ? 'mesh' : 'mqtt';
    if (out.node) out.node = String(out.node).toUpperCase();
    return out;
  };
  // An imported event, or null when a field is not what this app writes (W-12): a crafted file
  // cannot put a non-boolean `verified`, a node id that is not 8 hex, or kilobytes of text into
  // the history the node screen derives its facts from.
  const str = (v, max) => v === null || v === undefined || (typeof v === 'string' && v.length <= max);
  const importable = (r) => {
    if (!r || typeof r !== 'object') return null;
    if (typeof r.id !== 'string' || !/^[\w.-]{1,64}$/.test(r.id)) return null;
    if (typeof r.at !== 'string' || !/^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)$/.test(r.at)) return null;
    if (typeof r.command !== 'string' || r.command.length > 400) return null;
    if (r.node != null && !NODE.test(String(r.node).toUpperCase())) return null;
    if (r.code != null && !(Number.isInteger(r.code) && r.code >= 0)) return null;
    if (![true, false, null, undefined].includes(r.verified)) return null;
    if (![null, undefined, 'mqtt', 'mesh'].includes(r.road)) return null;
    if (!(str(r.reply, 4000) && str(r.note, 400) && str(r.region, 8) && str(r.topic, 200)
      && str(r.codeName, 60) && str(r.batch, 64))) return null;
    return r;
  };
  const newestFirst = (a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : (a.at < b.at ? 1 : -1));

  const history = Object.freeze({
    // One event, written once. Returns it with its id.
    async append(event) {
      const ms = now();
      const at = event.at || new Date(ms).toISOString();
      const record = { ...shape({ ...event, at }), owner: me, id: eventId(ms), created: at, updated: at };
      if (typeof record.command !== 'string') throw new Error('A history event names its command.');
      await db.put('history', record);
      return record;
    },
    // Newest first. `node` (8 hex, or 'all' for the region-wide summaries), `result`
    // ('ok' | 'refused' | 'silent' | 'forged'), `since` (ISO), `limit`.
    async list({ node = null, result = null, since = null, limit = null } = {}) {
      let rows = (await db.list('history', me)).sort(newestFirst);
      if (node === 'all') rows = rows.filter((r) => r.node === null);
      else if (node) rows = rows.filter((r) => r.node === String(node).toUpperCase());
      if (result) rows = rows.filter((r) => resultKind(r) === result);
      if (since) rows = rows.filter((r) => r.at > since);
      return limit ? rows.slice(0, limit) : rows;
    },
    // Merge another export: events already here (same id) are skipped, never overwritten.
    // Returns { added, skipped, foreign } (foreign: events of another key, left out).
    async import(records) {
      if (!Array.isArray(records)) throw new Error('A history file holds a list of events.');
      let added = 0; let skipped = 0; let foreign = 0;
      for (const r of records) {
        if (!importable(r)) {
          skipped += 1;
          continue;
        }
        if (r.owner && String(r.owner).toUpperCase() !== me) { foreign += 1; continue; }
        if (await db.get('history', me, r.id)) { skipped += 1; continue; }
        await db.put('history', { ...shape(r), owner: me, id: r.id, created: r.at, updated: r.at });
        added += 1;
      }
      return { added, skipped, foreign };
    },
  });

  // -- meta ------------------------------------------------------------------------------------

  const meta = Object.freeze({
    async get(id) { return (await db.get('meta', me, id))?.value; },
    async set(id, value) {
      const existing = await db.get('meta', me, id);
      await db.put('meta', stamp({ id, value }, existing));
    },
  });

  return Object.freeze({ owner: me, devices, groups, sets, history, meta, stores: STORES });
}

// What an event says: 'ok', 'refused', 'silent' (no answer), 'forged' (a bad signature), or
// 'summary' for a region-wide send's count line.
export function resultKind(event) {
  if (event.node === null && event.code === null && event.note) return 'summary';
  if (event.verified === false) return 'forged';
  if (event.code === null || event.code === undefined) return 'silent';
  return event.code === 0 ? 'ok' : 'refused';
}

// (facts, raw) from a device's reads and its history, as facts.derive does: the newest answer
// per key wins; nothing is taken from an answer whose signature failed; an unsigned one counts
// and says so. `parseFacts` is rules.parseFacts.
export function deriveFacts(device, events, parseFacts) {
  const answers = Object.entries(device?.reads || {}).map(([command, r]) => [r.at, command, r.reply, r.verified, true]);
  for (const e of events) {
    if (e.code === 0 && e.command) answers.push([e.at, e.command, e.reply || 'OK', e.verified, false]);
  }
  answers.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const facts = {};
  const raw = {};
  for (const [at, cmd, reply, verified, kept] of answers) {
    if (verified === false) continue;
    const command = cmd.split(/\s+/).filter(Boolean).join(' ');
    const parsed = parseFacts(command, reply);
    if (parsed === null) {
      if (kept) raw[command] = { reply, at, verified };
      continue;
    }
    for (const [key, value] of Object.entries(parsed)) facts[key] = { value, at, source: command, verified };
  }
  return { facts, raw };
}
