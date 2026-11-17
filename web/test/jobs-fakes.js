// A fake keyring, a fake transport with simulated nodes, and twelve plausible nodes, for the
// jobs tests and the headless screenshots. Nothing here signs with a real key or reaches a
// broker: the "handle" is a stand-in and the transport answers from a table.
import { makeResult } from '../lib/protocol/results.js';

export function fakeRing({ unlocked = true } = {}) {
  const ring = {
    open: unlocked, holds: 0, released: 0, touched: 0,
    handle: () => (ring.open ? { publicKeyHex: 'F'.repeat(64), fake: true } : null),
    hold() {
      if (!ring.open) throw new Error('The key is locked.');
      ring.holds += 1;
      let done = false;
      return () => { if (!done) { done = true; ring.released += 1; } };
    },
    touch() { ring.touched += 1; },
  };
  return ring;
}

// `behaviour[node]` = { ver, silent, forged, answer(command) -> { code, reply } | null }.
// The default answer: `ver` -> the version, `get name` -> the name, a get -> a value, anything
// else -> OK. Unknown nodes are silent.
export function fakeTransport(behaviour = {}) {
  const calls = [];
  let counter = 1000;
  const reply = (b, command) => {
    if (b.answer) { const a = b.answer(command); if (a !== undefined) return a; }
    if (command === 'ver') return { code: 0, reply: `> ${b.ver}` };
    if (command === 'get name') return b.name ? { code: 0, reply: `> ${b.name}` } : { code: 14, reply: '' };
    if (command === 'get autoreply') return { code: 0, reply: "> on #test-jkg 'test' max 8 hops, direct flood, mode flood, private off" };
    if (command.startsWith('get ')) return { code: 0, reply: '> 0.5' };
    return { code: 0, reply: 'OK' };
  };
  const answerAll = (nodes, command, c) => {
    const answers = {};
    for (const node of nodes) {
      const b = behaviour[node];
      if (!b || b.silent) continue;
      const a = reply(b, command);
      if (a === null) continue;
      answers[node] = makeResult(node, c, a.code, command, a.reply, b.forged ? false : (b.unsigned ? null : true));
    }
    return answers;
  };
  return {
    calls,
    async send(args) {
      const c = (counter += 1);
      calls.push({ kind: 'send', ...args, counter: c });
      args.progress?.(0, args.waitSecs || 1, []);
      return { payload: `fake|${c}`, answers: answerAll(args.nodesToHear, args.command, c) };
    },
    async discover(args) {
      const c = (counter += 1);
      calls.push({ kind: 'discover', ...args, counter: c });
      return Object.entries(behaviour).filter(([, b]) => b.region === args.region && !b.silent)
        .map(([node, b]) => ({ node, region: args.region, code: 0, reply: 'on', key: b.key || null, verified: b.forged ? false : (b.unsigned ? null : true) }));
    },
  };
}

const hex = (seed) => {
  let x = seed * 2654435761 >>> 0;
  let out = '';
  for (let i = 0; i < 64; i += 1) { x = (x * 1103515245 + 12345) >>> 0; out += '0123456789ABCDEF'[(x >>> 16) & 15]; }
  return out;
};

// Twelve nodes as an owner with a mixed fleet would have them: several firmware versions, two
// regions, one quiet for a day, two on low batteries, one that refused its last command, one
// whose key is only known by its prefix.
export const FIXTURE_NODES = [
  ['SE-JKG-Gisebo', 'JKG', 'v1.18.0-lou-18-arrc-observer-1a2b3c4d', 4011, 0.3],
  ['SE-JKG-Granarp', 'JKG', 'v1.18.0-lou-18-arrc-observer-1a2b3c4d', 3980, 0.5],
  ['SE-JKG-Hästskon', 'JKG', 'v1.18.0-lou-17-arrc-observer-9f8e7d6c', 3712, 1.2],
  ['SE-JKG-Högskolan', 'JKG', 'v1.18.0-lou-16-arrc-observer-55aa66bb', 4120, 0.2],
  ['SE-JKG-Jöransberg', 'JKG', 'v1.17.1-ar-13-observer-0c0ffee0', 3420, 2.5],
  ['SE-JKG-Lekeryd', 'JKG', 'v1.17.1-ar-11-observer-deadbeef', 3890, 26],
  ['SE-JKG-Mullsjö', 'JKG', 'v1.18.0-lou-18-arrc-observer-1a2b3c4d', 4050, 0.1],
  ['SE-JKG-Norrängen', 'JKG', 'v1.17.1-ar-10-observer-42f48ce9', 3360, 0.8],
  ['SE-JKG-Slottskajen', 'JKG', 'v1.18.0-lou-18-arrc-observer-1a2b3c4d', 4190, 0.4],
  ['SE-JKG-Söder', 'JKG', 'v1.18.0-lou-17-arrc-observer-9f8e7d6c', 3995, 0.6],
  ['SE-GOT-Hisingen', 'GOT', 'v1.18.0-lou-18-arrc-observer-1a2b3c4d', 4005, 0.9],
  ['SE-GOT-Majorna', 'GOT', null, null, null],
].map(([name, region, ver, mv, hoursAgo], i) => ({ name, region, ver, mv, hoursAgo, key: hex(i + 1) }));

// Fill `stores` with the twelve and some history, as of `now`.
export async function seedFixture(stores, now = Date.now()) {
  const iso = (hours) => new Date(now - hours * 3600000).toISOString();
  for (const [i, f] of FIXTURE_NODES.entries()) {
    await stores.devices.add({ node: f.key, key: i === 11 ? null : f.key, region: f.region, name: f.name });
    const node = f.key.slice(0, 8);
    const changes = { ver: f.ver };
    if (f.mv) changes.fleet = { batteryMv: f.mv, seen: iso(f.hoursAgo), firmware: f.ver, fetched: iso(0.2) };
    await stores.devices.update(node, changes);
  }
  const node = (i) => FIXTURE_NODES[i].key.slice(0, 8);
  const events = [
    [0, 'get autoreply', 0, "> on #test-jkg 'test' max 8 hops, direct flood, mode flood, private off", true, 30],
    [1, 'ver', 0, `> ${FIXTURE_NODES[1].ver}`, true, 20],
    [4, 'set autoreply.delay 300', 0, 'OK', true, 6],
    [7, 'region', 14, '', true, 3],
    [5, 'get name', null, null, null, 2.2],
    [2, 'get txdelay', 0, '> 0.5', true, 1.5],
    [9, 'region', 0, '> * F\n se-jkp F', true, 1],
    [6, 'set txdelay 0.6', 0, 'OK', true, 0.5],
  ];
  for (const [i, command, code, reply, verified, hoursAgo] of events) {
    const at = iso(hoursAgo);
    await stores.history.append({ at, node: node(i), region: FIXTURE_NODES[i].region, command, code, reply, verified,
      codeName: code === null ? null : code === 0 ? 'ok' : 'not-allowed', topic: `meshcore/${FIXTURE_NODES[i].region}/${node(i)}/cmd`, batch: 'seed' });
    await stores.devices.update(node(i), { lastSent: at, lastResult: { at, command, code, codeName: code === null ? null : code === 0 ? 'ok' : 'not-allowed', verified }, lastHeard: code === null ? undefined : at });
  }
  await stores.groups.create('canary', [node(0), node(6)]);
  await stores.groups.create('lekeryd', [node(5), node(7), node(4)]);
  await stores.sets.save('reads', ['ver', 'get name', 'get autoreply']);
}

// Behaviour for the fake transport that matches the fixture.
export function fixtureBehaviour() {
  const b = {};
  for (const f of FIXTURE_NODES) {
    b[f.key.slice(0, 8)] = { ver: f.ver || 'v1.18.0-lou-18-arrc-observer-1a2b3c4d', name: f.name, region: f.region, key: f.key,
      silent: f.hoursAgo !== null && f.hoursAgo > 24 };
  }
  return b;
}
