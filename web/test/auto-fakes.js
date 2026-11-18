// Fakes for discovery and refresh: a clock whose time and timers the test moves, a jobs object
// that answers discovery from a table, and a Beacon that answers from a map. Nothing reaches a
// broker, Beacon or a radio.
import { memoryDb } from '../lib/store/db.js';
import { openStores } from '../lib/store/index.js';
import { data } from './protocol-helpers.js';

export const OWNER = 'C'.repeat(64);
export const T0 = Date.parse('2026-11-17T12:00:00Z');
export const MIN = 60000;
export const HOUR = 60 * MIN;
export const areasTable = data('areas');

export function fakeClock(start = T0) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout(fn, ms) { seq += 1; timers.set(seq, { at: now + ms, fn }); return seq; },
    clearTimeout(id) { timers.delete(id); },
    pending: () => [...timers.values()].map((t) => t.at).sort((a, b) => a - b),
    // Move time on, firing every timer due on the way, in order; waits for what they start.
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
  return clock;
}

export const settle = async () => { for (let i = 0; i < 50; i += 1) await new Promise((r) => setImmediate(r)); };

export function memStores(clock) {
  return openStores(memoryDb(), OWNER, { now: () => clock.now() });
}

const key = (node) => `${node}${'0'.repeat(56)}`;

// `answers[region]` = [{ node, name, verified?, key? }] or an Error to throw.
export function fakeJobs(stores, answers = {}) {
  const calls = [];
  const jobs = {
    calls,
    async discoverAlive({ onProgress }) {
      calls.push(['alive']);
      const a = answers['*alive'] || [];
      if (a instanceof Error) throw a;
      onProgress?.({ elapsed: 10, total: 10, answered: a.length });
      const known = new Map((await stores.devices.list()).map((d) => [d.node, d]));
      return a.map((e) => ({ node: e.key.slice(0, 8), key: e.key, name: e.name || '', version: 'lou-20', state: e.state || 'online',
        knownAs: known.get(e.key.slice(0, 8)) ? (known.get(e.key.slice(0, 8)).name || e.key.slice(0, 8)) : null,
        alive: { state: e.state || 'online', region: e.region || '' } }));
    },
    async discover({ region, onProgress }) {
      calls.push(['discover', region]);
      const a = answers[region] || [];
      if (a instanceof Error) throw a;
      onProgress?.({ elapsed: 20, total: 20, answered: a.length });
      const known = new Map((await stores.devices.list()).map((d) => [d.node, d]));
      return a.map((e) => {
        const mine = known.get(e.node);
        return { node: e.node, region, code: 0, reply: '> on', key: e.key ?? key(e.node), verified: e.verified ?? true,
          keyChanged: Boolean(mine && mine.key && e.key && mine.key !== e.key), knownAs: mine ? (mine.name || mine.node) : null, name: e.name || '' };
      });
    },
    async adopt(entry) {
      calls.push(['adopt', entry.node]);
      const d = await stores.devices.add({ node: entry.node, key: entry.verified === false ? null : entry.key, region: entry.region, name: entry.name || '' });
      return entry.alive ? stores.devices.update(d.node, { alive: entry.alive }) : d;
    },
    async send({ command, nodes }) {
      calls.push(['send', command, ...nodes]);
      for (const n of nodes) {
        await stores.history.append({ node: n, region: 'JKG', command, topic: 't', code: 0, reply: '> v', verified: true });
        if (command === 'ver') await stores.devices.rememberRead(n, 'ver', '> v', true);
      }
      return { outcomes: nodes.map((n) => ({ node: n, sent: true, result: { ok: true, code: 0 } })) };
    },
  };
  return jobs;
}

// A Beacon client answering from `nodes[prefix]` = { item, observer } (either may be missing).
export function fakeBeacon(nodes = {}, { down = false } = {}) {
  const calls = [];
  return {
    calls,
    async findNode(id) {
      calls.push(['find', id]);
      if (down) throw Object.assign(new Error('Beacon unreachable: offline'), { code: 'unreachable' });
      const n = nodes[String(id).slice(0, 8).toUpperCase()];
      if (!n?.item) throw Object.assign(new Error(`Beacon does not know ${id}`), { code: 'unknown' });
      return n.item;
    },
    async observer(oid) {
      calls.push(['observer', oid]);
      const n = Object.values(nodes).find((v) => v.item?.observerId === oid);
      if (!n?.observer) throw Object.assign(new Error('Beacon answered 404'), { code: 'unreachable' });
      return n.observer;
    },
  };
}
