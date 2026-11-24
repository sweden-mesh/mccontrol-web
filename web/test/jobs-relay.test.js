// The relay road in the jobs (OTM-9e): a forward through the real plane.js and the in-memory
// broker with a fake relay and the target behind it; each status of a forward result; the taught
// path kept and used; the zero-hop flag; what auto may and may not take; the bulk paths that
// never relay; the neighbours reading. Nothing reaches a network and nothing transmits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from '../lib/store/db.js';
import { openStores } from '../lib/store/index.js';
import { rulesFrom } from '../lib/protocol/rules.js';
import { createJobs } from '../lib/jobs/jobs.js';
import { blocker, preflight } from '../lib/jobs/checks.js';
import { chooseRoad, startRoad } from '../lib/jobs/road.js';
import {
  FORWARD_TTL_SECS, autoRelay, hearsTarget, noRelayWhy, parseNeighbors, parseRelayState, pathHops, relayCandidates,
  relayRefusal, relaying, routesFor,
} from '../lib/jobs/relay.js';
import { newSession } from '../lib/protocol/plane.js';
import * as mcc3 from '../lib/protocol/mcc3.js';
import { openCompanion } from '../lib/mesh/companion.js';
import { data } from './protocol-helpers.js';
import { fakeTransport } from './jobs-fakes.js';
import { fakeCompanion } from './mesh-fakes.js';
import { connectVia, mcc3Broker, nodeKey, otherNodeKey, ownerKey } from './mcc3-fakes.js';
import { relayForSend } from '../ui/screens/road-kit.js';
import { relayMark } from '../ui/screens/history.js';
import { explainEvent } from '../ui/screens/node-kit.js';
import { translator } from '../i18n/i18n.js';
import { readFileSync } from 'node:fs';

const all = Object.fromEntries(['brokers', 'cautions', 'commands', 'denylist', 'facts', 'firmware', 'results'].map((n) => [n, data(n)]));
const rules = rulesFrom(all);
const owner = ownerKey();
const relayNode = nodeKey();
const targetNode = otherNodeKey();
const RELAY = relayNode.publicKeyHex;
const TARGET = targetNode.publicKeyHex;
const R = RELAY.slice(0, 8);
const T = TARGET.slice(0, 8);
const THIRD = `CCCC0003${'3'.repeat(56)}`;
const OBSERVER20 = 'v1.18.0-lou-20-arrc-observer-1a2b3c4d';
const ONLY20 = 'nrf52-v1.18.0-lou-20-rc-1a2b3c4d';
const ONLY19 = 'nrf52-v1.18.0-lou-19-rc-1a2b3c4d';
const iso = (minsAgo = 0) => new Date(Date.now() - minsAgo * 60000).toISOString();
// An Observer lou-20 node that says it relays: flags 0x1B (old scheme, uplink, clock, relay).
const aliveNow = (over = {}) => ({ state: 'online', at: iso(1), flags: 0x1b, relay: true, version: OBSERVER20, interval: 900, ...over });

const ring = () => {
  let secrets = {};
  return { handle: () => owner, hold: () => () => {}, touch() {}, loadSecrets: async () => ({ ...secrets }), saveSecrets: async (m) => { secrets = { ...m }; } };
};

// The relay and one target behind it; `target` and `relay` change the devices, `radio` the fake relay.
async function setup({ target = {}, relay = {}, radio = {}, behind = {}, companion = null, plane = undefined, extra = [] } = {}) {
  newSession();
  const stores = openStores(memoryDb(), 'C'.repeat(64));
  await stores.devices.add({ node: RELAY, key: RELAY, region: '', name: 'relay' });
  const { answer = undefined, ...relayDevice } = relay;
  await stores.devices.update(R, { ver: OBSERVER20, alive: aliveNow(), ...relayDevice });
  await stores.devices.add({ node: TARGET, key: TARGET, region: '', name: 'target' });
  await stores.devices.update(T, { ver: ONLY20, ...target });
  for (const d of extra) { await stores.devices.add({ node: d.key, key: d.key, region: '', name: d.name }); await stores.devices.update(d.key.slice(0, 8), d.set); }
  const fakeRelay = { handle: relayNode, commandKey: owner.publicKeyHex,
    targets: [{ handle: targetNode, answer: (c) => ({ code: 0, reply: `> ${c}` }), ...behind }], ...radio };
  const broker = mcc3Broker({ relays: radio === null ? [] : [fakeRelay],
    nodes: [{ handle: relayNode, commandKey: owner.publicKeyHex, answer }] });
  const transport = fakeTransport({});
  const link = companion ? await openCompanion(companion.link) : null;
  const jobs = createJobs({ ring: ring(), stores, rules, brokers: all.brokers, results: all.results, transport,
    connect: connectVia(broker), waitSecs: 1, companion: () => link, sleep: async () => {}, ...(plane ? { plane } : {}) });
  return { stores, jobs, broker, transport, fakeRelay };
}
const via = (route, more = {}) => ({ node: R, route, ...more });

test('through a relay: the request sealed for the target, forwarded to the relay, answered, kept with relay, route and SNR', async () => {
  const { jobs, stores, broker } = await setup();
  const before = Math.floor(Date.now() / 1000);
  const out = await jobs.send({ command: 'get radio', nodes: [T], road: 'relay', relay: via('neighbour') });
  const [o] = out.outcomes;
  assert.equal(o.road, 'relay');
  assert.equal(o.result.reply, '> get radio');
  assert.equal(o.result.verified, true);
  assert.deepEqual(o.info, { relay: R, relayName: 'relay', route: 'neighbour', status: 'answered', sent: 1, snr: 5.5 });
  const publishes = broker.received.filter((p) => p.type === 'publish');
  assert.deepEqual(publishes.map((p) => p.topic), [`mcc/cmd/${RELAY}`], 'one publish, to the relay');
  const [f] = broker.forwards;
  assert.equal(f.target, TARGET);
  assert.equal(f.route, mcc3.ROUTES.direct);
  assert.equal(f.pathLen, 0);
  assert.equal(f.body.length, 132);
  assert.equal(FORWARD_TTL_SECS, 150);
  assert.ok(f.expiry - before >= 150 && f.expiry - before <= 155, 'well inside the relay\'s 300 s, whichever clock is behind');
  // the two counters are stored, and apart: the relay's command counter is untouched
  const r = await stores.devices.get(R);
  const t = await stores.devices.get(T);
  assert.equal(r.forwardCounter, f.counter);
  assert.equal(r.counter, undefined);
  assert.equal(t.counter, f.requests[0].counter);
  assert.ok(t.lastHeardMesh, 'heard, but not over MQTT');
  assert.equal(t.lastHeardMqtt, undefined);
  const [e] = await stores.history.list({ node: T });
  assert.equal(e.road, 'relay');
  assert.deepEqual(e.relay, { node: R, route: 'neighbour', status: 'answered', sent: 1, snr: 5.5 });
  assert.equal(e.topic, `mcc/cmd/${RELAY}`);
  // the next forward counts on
  await jobs.send({ command: 'get radio', nodes: [T], road: 'relay', relay: via('neighbour') });
  assert.ok(broker.forwards[1].counter > f.counter);
  assert.equal(broker.forwards[1].status, 'answered', 'not a replay');
});

test('the zero-hop flag: only with no hops and a 0xC2 target', async () => {
  const stored = { relayPaths: { [R]: { pathLen: 2, path: 'A1B2', at: iso() } } };
  const { jobs, broker } = await setup({ target: stored });
  for (const route of ['neighbour', 'path', 'flood', 'flood-wide']) {
    await jobs.send({ command: 'get radio', nodes: [T], road: 'relay', relay: via(route, { confirmed: true }) });
  }
  assert.deepEqual(broker.forwards.map((f) => [f.route, f.pathLen, f.body[1], f.requests[0].flags]),
    [[0, 0, 2, 2], [0, 2, 0, 0], [1, 0, 0, 0], [2, 0, 0, 0]]);
  // lou-19 behind the relay: the 0xC1 request, which has no flags, answered in the clear
  const old = await setup({ target: { ver: ONLY19 }, behind: { lou20: false } });
  const out = await old.jobs.send({ command: 'get name', nodes: [T], road: 'relay', relay: via('neighbour') });
  assert.equal(old.broker.forwards[0].body[0], 0xc1);
  assert.equal(old.broker.forwards[0].body.length, 73 + 'get name'.length);
  assert.equal(out.outcomes[0].result.reply, '> get name');
  assert.equal(out.outcomes[0].info.status, 'answered');
});

test('each status of a forward result; no answer is silence, never a refusal', async () => {
  const cases = [
    ['no-answer', { behind: { answer: () => null } }, 1],
    ['off', { radio: { on: false } }, 0],
    ['expired', { radio: { clock: () => Math.floor(Date.now() / 1000) + 3600 } }, 0],
    ['replay', { radio: { lastForward: 0xfffffff0 } }, 0],
    ['busy', { radio: { busy: true } }, 0],
    ['rate-limited', { radio: { forwardsLeft: 0 } }, 0],
    ['clock-unset', { radio: { clock: () => 0 } }, 0],
    ['send-failed', { radio: { sendFails: true } }, 0],
  ];
  for (const [status, opts, sent] of cases) {
    const { jobs, stores } = await setup(opts);
    const out = await jobs.send({ command: 'get radio', nodes: [T], road: 'relay', relay: via('neighbour') });
    const [o] = out.outcomes;
    assert.equal(o.sent, true, status);
    assert.equal(o.result, null, status);
    assert.equal(o.info.status, status);
    assert.equal(o.info.sent, sent, status);
    const [e] = await stores.history.list({ node: T });
    assert.equal(e.code, null, `${status}: no code, so never "refused"`);
    assert.equal(e.relay.status, status);
    assert.equal((await stores.devices.get(T)).lastHeard, null, status);
  }
  // the fake's body rule is the protocol's: mccontrol never builds one a relay answers bad-body
  assert.equal(mcc3.FORWARD_STATUSES[5], 'bad-body');
  // a relay that says nothing (older firmware, offline): no status at all
  const quiet = await setup({ radio: null });
  const out = await quiet.jobs.send({ command: 'get radio', nodes: [T], road: 'relay', relay: via('neighbour') });
  assert.equal(out.outcomes[0].result, null);
  assert.equal(out.outcomes[0].info.status, null);
  // off: the relay's own word replaces what its alive said
  const off = await setup({ radio: { on: false } });
  await off.jobs.send({ command: 'get radio', nodes: [T], road: 'relay', relay: via('neighbour') });
  assert.equal((await off.stores.devices.get(R)).alive.relay, false);
  // a flood beyond the two an hour
  const spent = await setup({ radio: { floodsLeft: 0 } });
  const f = await spent.jobs.send({ command: 'get radio', nodes: [T], road: 'relay', relay: via('flood', { confirmed: true }) });
  assert.equal(f.outcomes[0].info.status, 'rate-limited');
});

test('a taught path is kept on the target per relay and offered as the direct route next time', async () => {
  const { jobs, stores, broker } = await setup({ behind: { taught: { pathLen: 2, path: 'A1B2' }, answer: () => ({ code: 0, reply: 'OK' }) } });
  let t = await stores.devices.get(T);
  assert.deepEqual(routesFor(relayCandidates(rules, await stores.devices.list(), t)[0]), ['neighbour', 'flood', 'flood-wide']);
  await assert.rejects(jobs.send({ command: 'get radio', nodes: [T], road: 'relay', relay: via('path') }), (e) => e.code === 'relayNoPath');
  const out = await jobs.send({ command: 'get radio', nodes: [T], road: 'relay', relay: via('flood', { confirmed: true }) });
  assert.equal(out.outcomes[0].info.sent, 2);
  t = await stores.devices.get(T);
  assert.equal(t.relayPaths[R].pathLen, 2);
  assert.equal(t.relayPaths[R].path, 'A1B2');
  const [c] = relayCandidates(rules, await stores.devices.list(), t);
  assert.deepEqual(routesFor(c), ['neighbour', 'path', 'flood', 'flood-wide']);
  assert.equal(pathHops(c.path), 2);
  await jobs.send({ command: 'get radio', nodes: [T], road: 'relay', relay: via('path') });
  const f = broker.forwards[1];
  assert.deepEqual([f.route, f.pathLen, f.path], [0, 2, 'A1B2']);
  // a path is taught by silence too (F4), and is the relay's own: another relay has none
  assert.equal(t.relayPaths[THIRD.slice(0, 8)], undefined);
});

test('a flood is the owner\'s word each time: unconfirmed, nothing is signed, stored or sent', async () => {
  const { jobs, stores, broker } = await setup();
  for (const route of ['flood', 'flood-wide']) {
    await assert.rejects(jobs.send({ command: 'get radio', nodes: [T], road: 'relay', relay: via(route) }), (e) => e.code === 'relayFloodConfirm');
    await assert.rejects(jobs.send({ command: 'get radio', nodes: [T], road: 'relay', relay: via(route, { confirmed: 'yes' }) }), (e) => e.code === 'relayFloodConfirm');
  }
  await assert.rejects(jobs.send({ command: 'get radio', nodes: [T], road: 'relay', relay: via('pigeon') }), (e) => e.code === 'relayRoute');
  await assert.rejects(jobs.send({ command: 'get radio', nodes: [T], road: 'relay' }), (e) => e.code === 'relayMissing');
  assert.equal(broker.received.filter((p) => p.type === 'publish').length, 0);
  assert.equal((await stores.devices.get(R)).forwardCounter, undefined);
  assert.equal((await stores.devices.get(T)).counter, undefined);
  assert.equal((await stores.history.list()).length, 0);
});

test('both counters are stored before the forward is sent', async () => {
  let atSend = null;
  const holder = {};
  const plane = { forward: async (args) => {
    atSend = { relay: (await holder.stores.devices.get(R)).forwardCounter, target: (await holder.stores.devices.get(T)).counter, sent: args.counter };
    throw new Error('cannot reach the command server');
  } };
  Object.assign(holder, await setup({ plane }));
  await assert.rejects(holder.jobs.send({ command: 'get radio', nodes: [T], road: 'relay', relay: via('neighbour') }), /cannot reach/);
  assert.equal(atSend.relay, atSend.sent, 'the forward counter was in the store when the forward left');
  assert.ok(atSend.target > 0);
  // the next one is above it although the first never arrived
  let next = null;
  holder.jobs = null;
  const again = await setup({ plane: { forward: async (args) => { next = args.counter; return { topic: 't', payload: '', result: null }; } } });
  await again.stores.devices.update(R, { forwardCounter: 0xfffffff0 });
  await again.jobs.send({ command: 'get radio', nodes: [T], road: 'relay', relay: via('neighbour') });
  assert.equal(next, 0xfffffff1, 'max(now, last + 1)');
});

test('who can relay: yours, fresh, an Observer lou-20, relaying, and not the target itself', async () => {
  const now = Date.now();
  const dev = (over = {}, alive = {}) => ({ node: R, key: RELAY, name: 'relay', ver: OBSERVER20, alive: aliveNow(alive), ...over });
  const target = { node: T, key: TARGET, name: 'target', ver: ONLY20 };
  const why = (d, t = target) => relayRefusal(rules, d, t, now)?.code ?? null;
  assert.equal(why(dev()), null);
  assert.equal(why(null), 'relayMissing');
  assert.equal(why(dev(), { node: R }), 'relaySelf');
  assert.equal(why(dev({}, { relay: false })), 'relayOff');
  // an alive kept before `relay` was read: the flag itself; the node's later OK to the switch wins
  assert.equal(why(dev({}, { relay: undefined })), null);
  assert.equal(why(dev({}, { relay: undefined, flags: 0x0b })), 'relayOff');
  assert.equal(relaying({ state: 'online', flags: 0x1b, relay: false }), false);
  assert.equal(relaying({ state: 'not-yours', flags: 0x1b, relay: true }), null);
  assert.equal(relaying({ state: 'offline' }), null);
  assert.equal(relaying(null), null);
  assert.equal(why(dev({}, { state: 'offline' })), 'relayNotHeard');
  assert.equal(why(dev({}, { state: 'not-yours' })), 'relayNotHeard');
  assert.equal(why(dev({}, { at: iso(32) })), 'relayNotHeard', 'two intervals and a minute');
  assert.equal(why(dev({}, { at: iso(29) })), null);
  assert.equal(why(dev({ alive: null })), 'relayNotHeard');
  assert.equal(why(dev({ key: null })), 'relayNotHeard');
  assert.equal(why(dev({}, { flags: 0x19 })), 'relayCannot', 'no uplink build');
  assert.equal(why(dev({}, { version: 'v1.18.0-lou-19-arrc-observer-1a2b3c4d' })), 'relayCannot');
  assert.equal(why(dev({}, { version: ONLY20 })), 'relayCannot', 'mesh only');
  assert.equal(rules.canRelay(OBSERVER20), true);
  assert.equal(rules.canRelay(null), null);
  // why none: the most telling reason; the target alone is no reason
  assert.equal(noRelayWhy(rules, [dev(), target], target, now), null);
  assert.equal(noRelayWhy(rules, [dev({}, { relay: false }), target], target, now).code, 'none.relayOff');
  assert.equal(noRelayWhy(rules, [dev({}, { state: 'offline' }), target], target, now).code, 'none.relayNotHeard');
  assert.equal(noRelayWhy(rules, [target], target, now).code, 'none.relayCannot');
  // candidates: known to hear the target first, then a stored path, then unknown, then known not to
  const k = (n) => `${n}${n}${n}${n}000${n}${String(n).repeat(56)}`;
  const many = ['A', 'B', 'D', 'E'].map((n) => dev({ node: k(n).slice(0, 8), key: k(n), name: n }));
  const t = { ...target, relayHears: { [many[2].node]: { hears: true, at: iso() }, [many[0].node]: { hears: false, at: iso() } },
    relayPaths: { [many[3].node]: { pathLen: 1, path: 'A1', at: iso() } } };
  assert.deepEqual(relayCandidates(rules, [...many, t], t, now).map((c) => c.device.name), ['D', 'E', 'B', 'A']);
  assert.deepEqual(routesFor(relayCandidates(rules, [...many, t], t, now)[3]), ['flood', 'flood-wide', 'neighbour'], 'not listed as a neighbour: the zero-hop route stays, last');
});

test('auto takes a relay only for a node without MQTT or silent on it, with no companion, and never floods', async () => {
  const hears = { relayHears: { [R]: { hears: true, at: iso() } } };
  // mesh only, the relay hears it: the neighbour route
  const a = await setup({ target: hears });
  const out = await a.jobs.send({ command: 'get radio', nodes: [T], road: 'auto' });
  assert.equal(out.outcomes[0].road, 'relay');
  assert.equal(out.outcomes[0].why.code, 'meshOnly');
  assert.deepEqual([a.broker.forwards[0].route, a.broker.forwards[0].pathLen], [0, 0]);
  // only a stored path: direct along it
  const b = await setup({ target: { relayPaths: { [R]: { pathLen: 1, path: 'A1', at: iso() } } } });
  assert.equal((await b.jobs.send({ command: 'get radio', nodes: [T], road: 'auto' })).outcomes[0].info.route, 'path');
  assert.deepEqual([b.broker.forwards[0].route, b.broker.forwards[0].path], [0, 'A1']);
  // nothing known: no flood, no guess; as before, the mesh road with no companion
  const c = await setup();
  await assert.rejects(c.jobs.send({ command: 'get radio', nodes: [T], road: 'auto' }), (e) => e.code === 'noCompanion');
  assert.equal(c.broker.forwards.length, 0);
  // known NOT to hear it: the same
  const d = await setup({ target: { relayHears: { [R]: { hears: false, at: iso() } } } });
  await assert.rejects(d.jobs.send({ command: 'get radio', nodes: [T], road: 'auto' }), (e) => e.code === 'noCompanion');
  assert.equal(d.broker.forwards.length, 0);
  assert.equal(autoRelay(rules, await d.stores.devices.list(), await d.stores.devices.get(T)), null);
  // a companion is connected: the mesh road, not the relay
  const radio = fakeCompanion({ ownerKey: owner.publicKeyHex, contacts: { [TARGET]: 1 }, mcc3: { node: targetNode } });
  const e = await setup({ target: hears, companion: radio });
  assert.equal((await e.jobs.send({ command: 'get radio', nodes: [T], road: 'auto' })).outcomes[0].road, 'mesh');
  assert.equal(e.broker.forwards.length, 0);
});

test('auto never takes a relay for a node that is on MQTT', async () => {
  const hears = { relayHears: { [R]: { hears: true, at: iso() } } };
  const on = (over) => ({ ver: OBSERVER20, alive: aliveNow({ relay: false }), ...hears, ...over });
  // heard over MQTT a minute ago: MQTT (the fake broker has no such node: silence, but no forward)
  const a = await setup({ target: on({ lastHeardMqtt: iso(1) }) });
  const out = await a.jobs.send({ command: 'get radio', nodes: [T], road: 'auto' });
  assert.equal(out.outcomes[0].road, 'mqtt');
  assert.equal(a.broker.forwards.length, 0);
  // a repair only the mesh admits, to a node on MQTT: the mesh road's own rule, never a relay
  const b = await setup({ target: on({ lastHeardMqtt: iso(1) }) });
  await assert.rejects(b.jobs.send({ command: 'set wifi.ssid HomeNet', nodes: [T], road: 'auto' }), (e) => e.code === 'noCompanion');
  assert.equal(b.broker.forwards.length, 0);
  // silent on MQTT for the 15 minutes: now it may
  const c = await setup({ target: on({ lastHeardMqtt: iso(20) }) });
  const late = await c.jobs.send({ command: 'get radio', nodes: [T], road: 'auto' });
  assert.equal(late.outcomes[0].road, 'relay');
  assert.equal(late.outcomes[0].why.code, 'notHeard');
  // and when the node answers mesh-closed (its MQTT works after all) it goes again over MQTT
  const d = await setup({ target: on({ lastHeardMqtt: iso(20) }), behind: { answer: () => ({ code: 19, reply: '' }) } });
  const closed = await d.jobs.send({ command: 'get radio', nodes: [T], road: 'auto' });
  assert.equal(closed.outcomes[0].road, 'mqtt');
  assert.equal(closed.outcomes[0].why.code, 'meshClosed');
  assert.deepEqual((await d.stores.history.list({ node: T })).map((x) => x.road).sort(), ['mqtt', 'relay']);
});

test('never in bulk: a group, several nodes, an area, a set and a refresh do not go through a relay', async () => {
  const hears = { relayHears: { [R]: { hears: true, at: iso() } } };
  const third = { key: THIRD, name: 'third', set: { ver: ONLY20, ...hears, alive: { state: 'online', region: 'se-jkp' } } };
  const { jobs, stores, broker } = await setup({ target: { ...hears, alive: { state: 'online', region: 'se-jkp' } }, extra: [third] });
  await stores.groups.create('far', [T]);
  const relay = via('neighbour');
  await assert.rejects(jobs.send({ command: 'ver', group: 'far', road: 'relay', relay }), (e) => e.code === 'relayOne');
  await assert.rejects(jobs.send({ command: 'ver', nodes: [T, 'CCCC0003'], road: 'relay', relay }), (e) => e.code === 'relayOne');
  await assert.rejects(jobs.send({ command: 'ver', area: 'se-jkp', road: 'relay', relay }), (e) => e.code === 'relayOne');
  assert.equal(blocker(rules, { command: 'ver', area: 'se-jkp', road: 'relay' }).code, 'relayOne');
  assert.throws(() => chooseRoad(rules, { device: null, command: 'ver', via: 'relay' }), (e) => e.code === 'relayOne');
  // auto to a group of one and to two nodes: each is left to the mesh road, which has no companion
  for (const target of [{ group: 'far' }, { nodes: [T, 'CCCC0003'] }]) {
    const out = await jobs.send({ command: 'ver', ...target, road: 'auto' });
    assert.equal(out.outcomes.every((o) => !o.sent && o.reason.code === 'noCompanion'), true);
  }
  const set = await jobs.runSet({ steps: ['ver'], nodes: [T] });
  assert.equal(set.runs[0].stoppedAt, 0);
  const fresh = await jobs.refresh({ nodes: [T] });
  assert.equal(fresh.outcomes.every((o) => o.result === null), true);
  assert.equal(broker.forwards.length, 0, 'no forward left this page');
  assert.equal((await stores.devices.get(R)).forwardCounter, undefined);
});

test('the relay road carries what the mesh road carries: its checks, before anything is signed', async () => {
  const dev = { node: T, key: TARGET, name: 'target', ver: ONLY20 };
  assert.equal(blocker(rules, { command: 'set wifi.ssid HomeNet', device: { ...dev, ver: OBSERVER20 }, road: 'relay' }), null);
  assert.equal(blocker(rules, { command: 'set prv.key 00', device: dev, road: 'relay' }).code, 'denied');
  assert.equal(blocker(rules, { command: `set name ${'x'.repeat(60)}`, device: dev, road: 'relay' }).code, 'denied');
  assert.equal(blocker(rules, { command: 'ver', device: { ...dev, key: null }, road: 'relay' }).code, 'mcc3NoKey');
  assert.equal(blocker(rules, { command: 'ver', device: { ...dev, ver: 'v1.18.0-lou-18-arrc-observer-1a2b3c4d', region: 'JKG' }, road: 'relay' }).code, 'meshOldFirmware');
  assert.equal(preflight(rules, { command: 'ver', device: dev, road: 'relay' }).road.road, 'relay');
  assert.equal(startRoad({ remembered: 'relay', relay: true }), 'relay');
  assert.equal(startRoad({ remembered: 'relay' }), 'mqtt', 'no relay to take: not started on');
  assert.equal(startRoad({ remembered: 'relay', meshOnly: true, companion: true }), 'mesh');
  const { jobs, broker } = await setup();
  await assert.rejects(jobs.send({ command: 'get radio', nodes: [T], road: 'relay', relay: { node: T, route: 'neighbour' } }), (e) => e.code === 'relaySelf');
  await assert.rejects(jobs.send({ command: 'ver', nodes: [R], road: 'relay', relay: via('neighbour') }), (e) => e.code === 'relaySelf');
  await assert.rejects(jobs.send({ command: 'ota check', nodes: [T], road: 'relay', relay: via('neighbour') }), (e) => e.code === 'denied');
  assert.equal(broker.forwards.length, 0);
});

test('the neighbours reply: there, not there, or not known', () => {
  const key = TARGET;
  const p = T.toLowerCase();
  assert.deepEqual(hearsTarget(`> 4AC61A7F:12:22\n${p}:340:-9`, key), { hears: true, snr: -2.25 });
  assert.deepEqual(hearsTarget('4AC61A7F:12:22', key), { hears: false, snr: null });
  assert.deepEqual(hearsTarget('> -none-', key), { hears: false, snr: null });
  const full = Array.from({ length: 8 }, (_, i) => `AAAA000${i}:${i}:20`).join('\n');
  assert.equal(hearsTarget(full, key), null, 'a full list may have pushed it out');
  assert.equal(hearsTarget(`${full}\n${p}:9:8`, key).hears, true);
  assert.equal(hearsTarget('', key), null);
  assert.equal(hearsTarget('Err - unknown command', key), null);
  assert.equal(hearsTarget('4AC61A7F:12:22\nsomething else', key), null, 'a line it cannot read: not a whole list');
  assert.equal(hearsTarget(`${p}:12:22`, 'nonsense'), null);
  assert.equal(parseNeighbors(`${p}:12:22`)[0].prefix, T);
  assert.deepEqual(parseRelayState('> own, forwarded 3, answered 2, refused 0, burst, 39.9 s airtime left, floods today 1 of 100'),
    { on: true, phase: 'burst', left: 39.9, floods: 1 });
  assert.deepEqual(parseRelayState('> own, forwarded 0, answered 0, refused 0, idle, 45.0 s airtime left, floods today 0 of 100'),
    { on: true, phase: 'idle', left: 45, floods: 0 });
  assert.deepEqual(parseRelayState('> off'), { on: false });
  assert.deepEqual(parseRelayState('> own'), { on: true, phase: null, left: null, floods: null });
  assert.equal(parseRelayState('Err - unknown'), null);
});

test('Check neighbours: one read to the relay over MQTT, the finding kept on the target with its time', async () => {
  const { jobs, stores, broker } = await setup({ relay: { answer: (c) => (c === 'neighbors' ? { code: 0, reply: `${T}:30:24` } : { code: 0, reply: 'OK' }) } });
  const out = await jobs.checkNeighbours({ relay: R, target: T });
  assert.equal(out.hears, true);
  assert.deepEqual(broker.opened.map((o) => o.command), ['neighbors']);
  assert.equal(broker.forwards.length, 0, 'nothing transmitted');
  const kept = (await stores.devices.get(T)).relayHears[R];
  assert.equal(kept.hears, true);
  assert.equal(kept.snr, 6);
  assert.ok(Date.now() - Date.parse(kept.at) < 5000);
  // a reply that proves nothing leaves the finding as it was
  const vague = await setup({ target: { relayHears: { [R]: { hears: true, at: iso(60) } } }, relay: { answer: () => ({ code: 14, reply: '' }) } });
  assert.equal((await vague.jobs.checkNeighbours({ relay: R, target: T })).hears, null);
  assert.equal((await vague.stores.devices.get(T)).relayHears[R].hears, true);
});

test('set relay off|own: the node\'s OK is its word until the next alive', async () => {
  const { jobs, stores } = await setup();
  await jobs.send({ command: 'set relay off', nodes: [R] });
  assert.equal((await stores.devices.get(R)).alive.relay, false);
  assert.equal(relayRefusal(rules, await stores.devices.get(R), { node: T }).code, 'relayOff');
  await jobs.send({ command: 'set relay own', nodes: [R] });
  assert.equal((await stores.devices.get(R)).alive.relay, true);
  assert.equal(rules.refusal('set relay own'), null, 'not on the deny list');
});

test('importing history keeps a relay event and refuses a made-up one', async () => {
  const { stores } = await setup();
  const base = { at: '2026-11-20T10:00:00.000Z', command: 'ver', node: T, road: 'relay' };
  const relay = { node: R, route: 'flood', status: 'no-answer', sent: 2, snr: null };
  const r = await stores.history.import([{ ...base, id: 'r1', relay }, { ...base, id: 'r2', relay: { node: 'not hex' } },
    { ...base, id: 'r3', relay: { ...relay, extra: 'x'.repeat(5000), status: '<b>' } }]);
  assert.equal(r.added, 2);
  const by = Object.fromEntries((await stores.history.list()).map((e) => [e.id, e.relay]));
  assert.deepEqual(by, { r1: relay, r3: { ...relay, status: null } });
});

test('the screens ask before a flood: only the dialog\'s own yes makes a send confirmed', async () => {
  const asked = [];
  const picker = (route, answer) => ({ choice: () => ({ node: R, route }), confirmFlood: async (c) => { asked.push([route, c]); return answer; } });
  assert.deepEqual(await relayForSend(picker('neighbour', true), 'ver'), { node: R, route: 'neighbour', confirmed: false });
  assert.deepEqual(await relayForSend(picker('path', true), 'ver'), { node: R, route: 'path', confirmed: false });
  assert.equal(asked.length, 0, 'no question for a direct send');
  assert.equal(await relayForSend(picker('flood', false), 'ver'), null, 'cancelled: nothing to send');
  assert.equal(await relayForSend(picker('flood-wide', false), 'ver'), null);
  assert.deepEqual(await relayForSend(picker('flood', true), 'ver'), { node: R, route: 'flood', confirmed: true });
  assert.deepEqual(asked.map(([r]) => r), ['flood', 'flood-wide', 'flood']);
  assert.equal(await relayForSend({ choice: () => null }, 'ver'), null);
});

test('history in words: which relay, the route, the SNR; the relay\'s status in the spec\'s text, never "refused"', () => {
  for (const lang of ['en', 'sv']) {
    const strings = JSON.parse(readFileSync(new URL(`../i18n/${lang}.json`, import.meta.url), 'utf8'));
    const ctx = { t: translator(strings), lang };
    const svc = { data: { results: all.results }, rules };
    const e = (status, more = {}) => ({ node: T, command: 'ver', code: null, road: 'relay', relay: { node: R, route: 'flood', status, sent: 2, snr: null, ...more } });
    assert.match(relayMark(ctx, e('answered', { snr: 5.5 }), { [R]: 'Gisebo' }), /Gisebo.*5\.5 dB$/);
    for (const [code, name] of Object.entries(all.results.forward.statuses).slice(1)) {
      const x = explainEvent(ctx, svc, e(name));
      assert.equal(x.kind, 'silent', name);
      assert.equal(x.help, lang === 'sv' ? all.results.forward.help_sv[code] : all.results.forward.help[code], name);
    }
    assert.equal(explainEvent(ctx, svc, e(null)).help, strings['road.relaySilent']);
    assert.equal(explainEvent(ctx, svc, e('answered')).help, strings['road.relayUnread']);
    // every key the screens build from a route, a reason or a refusal exists
    for (const k of ['neighbour', 'path', 'flood', 'flood-wide']) assert.ok(strings[`road.route.${k}`] && strings[`road.routeShort.${k}`], k);
    for (const k of ['relayOff', 'relayNotHeard', 'relayCannot']) assert.ok(strings[`road.relayNone.${k}`], k);
    for (const k of ['relayOne', 'relayMissing', 'relaySelf', 'relayNotHeard', 'relayCannot', 'relayOff', 'relayRoute', 'relayFloodConfirm', 'relayNoPath']) {
      assert.ok(strings[`send.why.${k}`], k);
    }
  }
});

test("a version as an alive names it (no board prefix) reads like ver's answer", () => {
  const short = 'lou-20rc-arrc-observer-60407864';
  assert.equal(rules.canRelay(short), true);
  assert.equal(rules.meshOnly('lou-20rc-rc-1f80c095'), true);
  assert.equal(rules.meshOnly(short), false);
  assert.equal(rules.speaksMesh(short), true);
  assert.equal(rules.canRelay('lou-19-arrc-observer-1a2b3c4d'), false);
});
