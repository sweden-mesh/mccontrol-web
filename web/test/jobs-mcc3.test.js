// The jobs on both planes (IATA2-MC3/MC4/MC5), as mccontrol-cli b52384b does it: the scheme per
// node, the sealed command through the real plane.js and the in-memory broker with a lou-20 node,
// the counter stored before sending, an area act (one command per node, shuffled, spaced, no
// transmit, no mesh), discovery from alive (online, offline, not yours), the old scheme for
// lou-19 and older (ota update included) and the mesh road's 0xC2. Nothing reaches a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from '../lib/store/db.js';
import { openStores } from '../lib/store/index.js';
import { rulesFrom } from '../lib/protocol/rules.js';
import { createJobs } from '../lib/jobs/jobs.js';
import { blocker } from '../lib/jobs/checks.js';
import { areaOf, oldLoginSuspected, oldRegion, scheme, shuffled } from '../lib/jobs/scheme.js';
import { newSession } from '../lib/protocol/plane.js';
import * as mcc3 from '../lib/protocol/mcc3.js';
import { openCompanion } from '../lib/mesh/companion.js';
import { data } from './protocol-helpers.js';
import { fakeTransport } from './jobs-fakes.js';
import { fakeCompanion } from './mesh-fakes.js';
import { M, aliveFields, connectVia, mcc3Broker, nodeKey, otherNodeKey, otherOwnerKey, ownerKey } from './mcc3-fakes.js';

const all = Object.fromEntries(['brokers', 'cautions', 'commands', 'denylist', 'facts', 'firmware', 'results'].map((n) => [n, data(n)]));
const rules = rulesFrom(all);
const owner = ownerKey();
const node = nodeKey();
const NODE = node.publicKeyHex;
const N = NODE.slice(0, 8);
const LOU19 = 'v1.18.0-lou-19-arrc-observer-1a2b3c4d';
const LOU20 = 'v1.18.0-lou-20-arrc-observer-1a2b3c4d';

function ring() {
  let secrets = {};
  const r = {
    saves: 0,
    handle: () => owner, hold: () => () => {}, touch() {},
    loadSecrets: async () => ({ ...secrets }),
    saveSecrets: async (m) => { r.saves += 1; secrets = { ...m }; },
    secrets: () => secrets,
  };
  return r;
}

async function setup({ nodes = [{ handle: node, commandKey: owner.publicKeyHex }], retained = {}, devices = null, sleeps = [], random = Math.random, companion = null } = {}) {
  newSession();
  const stores = openStores(memoryDb(), 'C'.repeat(64));
  for (const d of devices || [{ node: NODE, key: NODE, region: '', name: 'loutest', ver: LOU20 }]) {
    const { ver, alive, ...rest } = d;
    await stores.devices.add(rest);
    if (ver || alive) await stores.devices.update(rest.node.slice(0, 8), { ...(ver ? { ver } : {}), ...(alive ? { alive } : {}) });
  }
  const broker = mcc3Broker({ nodes, retained });
  const transport = fakeTransport({ CCCC0003: { ver: LOU19 } });
  const r = ring();
  const radio = companion ? await openCompanion(companion.link) : null;
  const jobs = createJobs({
    ring: r, stores, rules, brokers: all.brokers, results: all.results, transport, connect: connectVia(broker), waitSecs: 1,
    sleep: async (ms) => { sleeps.push(ms); }, random, companion: () => radio,
  });
  return { stores, jobs, broker, transport, ring: r };
}

test('the scheme per node: an alive that opens, or lou-20 and later, is mcc3; else the old IATA scheme', () => {
  assert.equal(scheme(rules, { ver: LOU20 }), 'mcc3');
  // a lou-20 Wi-Fi node found by the old scheme, with no alive of its own ever seen: its command
  // slot is most likely still on the old login, and only the old scheme reaches it
  assert.equal(scheme(rules, { ver: LOU20, region: 'JKG' }), 'old');
  assert.equal(oldLoginSuspected(rules, { ver: LOU20, region: 'JKG' }), true);
  assert.equal(scheme(rules, { ver: LOU20, region: 'JKG', alive: { state: 'online' } }), 'mcc3');
  assert.equal(scheme(rules, { ver: LOU20.replace('lou-20', 'lou-21'), region: 'JKG' }), 'mcc3');   // lou-21 repairs itself
  assert.equal(oldLoginSuspected(rules, { ver: LOU20, region: '' }), false);
  assert.equal(scheme(rules, { ver: LOU19 }), 'old');
  assert.equal(scheme(rules, { ver: null }), 'old');
  assert.equal(scheme(rules, { ver: LOU19, alive: { state: 'online' } }), 'mcc3');
  assert.equal(scheme(rules, { ver: LOU19, alive: { state: 'offline' } }), 'mcc3');
  assert.equal(scheme(rules, { ver: LOU19, alive: { state: 'not-yours' } }), 'old');
  assert.equal(oldRegion({ region: 'jkg' }), 'JKG');
  assert.equal(oldRegion({ region: '', fleet: { iatas: ['GOT'] } }), 'GOT', "Beacon's IATA when none is stored");
  assert.equal(oldRegion({ region: '' }), null);
  assert.equal(areaOf({ alive: { state: 'online', region: 'SE-JKP' } }), 'se-jkp');
  assert.equal(areaOf({ alive: { state: 'not-yours', region: 'se-jkp' } }), null);
  assert.equal(blocker(rules, { command: 'ver', device: { node: N, ver: LOU20 } }).code, 'mcc3NoKey');
  assert.equal(blocker(rules, { command: 'ver', device: { node: N, ver: LOU19, key: NODE } }).code, 'noRegion');
  assert.equal(blocker(rules, { command: 'set name Väster', device: { node: N, ver: LOU20, key: NODE } }), null);
});

test('a lou-20 node: one sealed command on mcc/cmd/<KEY>, no region, the counter stored before sending, S cached', async () => {
  const { stores, jobs, broker, ring: r } = await setup();
  const before = Math.floor(Date.now() / 1000);
  const out = await jobs.send({ command: 'get name', nodes: [N] });
  const [o] = out.outcomes;
  assert.equal(o.sent, true);
  assert.equal(o.result.verified, true);
  assert.equal(o.event.topic, `mcc/cmd/${NODE}`);
  assert.equal(o.event.region, null);
  assert.equal(broker.opened.length, 1);
  const sent = broker.opened[0].counter;
  assert.ok(sent >= before);
  assert.equal((await stores.devices.get(N)).counter, sent, 'stored');
  assert.deepEqual(Object.keys(r.secrets()), [NODE]);
  assert.equal(r.secrets()[NODE], M.keys.shared_secret);
  // the next one: max(now, highest + 1), also above what the alive says
  await stores.devices.update(N, { alive: { state: 'online', last_counter: sent + 50 } });
  await jobs.send({ command: 'ver', nodes: [N] });
  assert.equal(broker.opened[1].counter, sent + 51);
  assert.equal(r.saves, 1, 'S computed once');
  assert.equal(broker.connects.every((c) => c.username !== `v1_${owner.publicKeyHex}`), true);
});

test('a lou-19 node keeps the old per-node IATA scheme, ota update included; its next alive moves it to mcc3', async () => {
  const devices = [{ node: NODE, key: NODE, region: '', name: 'loutest', ver: LOU20 },
    { node: `CCCC0003${'3'.repeat(56)}`, key: `CCCC0003${'3'.repeat(56)}`, region: 'GOT', name: 'old', ver: LOU19 }];
  const { jobs, transport, broker, stores } = await setup({ devices });
  const out = await jobs.send({ command: 'ota update', nodes: ['CCCC0003'] });
  assert.equal(out.outcomes[0].sent, true);
  assert.equal(transport.calls[0].topic, `meshcore/GOT/CCCC0003${'3'.repeat(56)}/cmd`);
  assert.equal(broker.opened.length, 0);
  await stores.devices.update('CCCC0003', { alive: { state: 'online' } });
  assert.equal(scheme(rules, await stores.devices.get('CCCC0003')), 'mcc3');
});

test('an area act: one sealed command per node, shuffled, spaced 10-90 s (5-30 min for a restart); never a broadcast', async () => {
  const other = otherNodeKey();
  const OTHER = other.publicKeyHex;
  const devices = [
    { node: NODE, key: NODE, region: '', name: 'a', ver: LOU20, alive: { state: 'online', region: 'se-jkp' } },
    { node: OTHER, key: OTHER, region: '', name: 'b', ver: LOU20, alive: { state: 'offline', region: 'se-jkp' } },
    { node: `CCCC0003${'3'.repeat(56)}`, key: `CCCC0003${'3'.repeat(56)}`, region: '', name: 'c', ver: LOU20, alive: { state: 'online', region: 'se-vgr' } },
  ];
  const sleeps = [];
  const { jobs, broker, stores } = await setup({ devices, sleeps, random: () => 0.5,
    nodes: [{ handle: node, commandKey: owner.publicKeyHex }, { handle: other, commandKey: owner.publicKeyHex }] });
  const out = await jobs.send({ command: 'get radio', area: 'SE-JKP' });
  assert.equal(out.asked, 2);
  assert.equal(out.answered, 2);
  assert.deepEqual(broker.opened.map((o) => o.node).sort(), [NODE, OTHER].sort());
  assert.equal(broker.received.filter((p) => p.type === 'publish').every((p) => /^mcc\/cmd\/[0-9A-F]{64}$/.test(p.topic)), true);
  assert.deepEqual(sleeps, [50000], 'one pause between two nodes: 10 + 0.5 x 80 s');
  const [summary] = await stores.history.list({ node: 'all' });
  assert.equal(summary.topic, 'area/se-jkp/act');
  assert.equal(summary.note, '2 of 2 answered');
  sleeps.length = 0;
  await jobs.send({ command: 'reboot', area: 'se-jkp' });
  assert.deepEqual(sleeps, [(300 + 0.5 * 1500) * 1000]);
  await assert.rejects(jobs.send({ command: 'trigger test', area: 'se-jkp' }), (e) => e.code === 'broadcastTransmit');
  await assert.rejects(jobs.send({ command: 'ver', area: 'se-jkp', road: 'mesh' }), (e) => e.code === 'meshBroadcast');
  await assert.rejects(jobs.send({ command: 'ver', area: 'se-sth' }), (e) => e.code === 'emptyArea');
  assert.deepEqual(shuffled([1, 2, 3], () => 0), [2, 3, 1]);
});

test('discovery from alive: ours online (added by the caller), offline by its will, not yours once rekeyed; reads only', async () => {
  const other = otherNodeKey();
  const OTHER = other.publicKeyHex;
  const GONE = `DDDD0004${'4'.repeat(56)}`;
  const retained = {
    [mcc3.aliveTopic(NODE)]: M.alive[0].payload,                                                  // ours, not in the list
    [mcc3.aliveTopic(OTHER)]: mcc3.sealAlive(mcc3.ownerKeys(otherOwnerKey(), OTHER), aliveFields()),  // rekeyed away
    [mcc3.aliveTopic(GONE)]: '',                                                                   // the will
    [mcc3.aliveTopic('E'.repeat(64))]: mcc3.sealAlive(mcc3.ownerKeys(otherOwnerKey(), 'E'.repeat(64)), aliveFields()),
  };
  const devices = [
    { node: OTHER, key: OTHER, region: '', name: 'was mine', ver: LOU20, alive: { state: 'online', boot: 1, sequence: 1 } },
    { node: GONE, key: GONE, region: '', name: 'gone', ver: LOU20 },
  ];
  const { jobs, broker, stores, ring: r } = await setup({ retained, devices });
  const found = await jobs.discoverAlive({ waitSecs: 0.4 });
  const by = Object.fromEntries(found.map((e) => [e.key, e]));
  assert.equal(by[NODE].state, 'online');
  assert.equal(by[NODE].knownAs, null);
  assert.equal(by[NODE].name, 'SE-JKG-LOUTEST');
  assert.equal(by[OTHER].state, 'not-yours');
  assert.equal(by[GONE].state, 'offline');
  assert.equal(by['E'.repeat(64)], undefined, "someone else's node: nothing to say");
  assert.equal((await stores.devices.get(OTHER.slice(0, 8))).alive.state, 'not-yours');
  assert.equal(scheme(rules, await stores.devices.get(OTHER.slice(0, 8))), 'mcc3', 'its version still says lou-20');
  assert.equal(broker.received.filter((p) => p.type === 'publish').length, 0);
  assert.equal(Object.keys(r.secrets()).length, 3, 'every key seen, ours or not');
  const d = await jobs.adopt({ node: NODE, key: NODE, region: '', name: by[NODE].name, alive: by[NODE].alive });
  assert.equal(d.region, '');
  assert.equal(d.ver, 'lou-20');
  assert.equal(areaOf(d), 'se-jkp');
  // a stale (lower boot, sequence) alive does not replace a newer one
  await stores.devices.update(N, { alive: { ...d.alive, boot: 9 } });
  await jobs.discoverAlive({ waitSecs: 0.3 });
  assert.equal((await stores.devices.get(N)).alive.boot, 9);
});

test('a device added by its whole key needs no region; an old one by id needs its IATA', async () => {
  const stores = openStores(memoryDb(), 'C'.repeat(64));
  const d = await stores.devices.add({ node: NODE, key: NODE, name: 'x' });
  assert.equal(d.region, '');
  await assert.rejects(stores.devices.add({ node: 'AAAA0001', name: 'y' }), /IATA/);
  assert.equal((await stores.devices.update(N, { region: '' })).region, '');
});

test('the mesh road to a lou-20 node: 0xC2, 57 bytes, sealed both ways, the topic names the node only', async () => {
  const fake = fakeCompanion({ ownerKey: owner.publicKeyHex, contacts: { [NODE]: 1 }, mcc3: { node },
    answer: (c) => ({ code: 0, reply: `> ${c}` }) });
  const { jobs, stores } = await setup({ companion: fake });
  const out = await jobs.send({ command: 'set wifi.ssid HomeNet', nodes: [N], road: 'mesh' });
  const [o] = out.outcomes;
  assert.equal(o.road, 'mesh');
  assert.equal(o.result.reply, '> set wifi.ssid HomeNet');
  assert.equal(o.event.topic, `mcc/cmd/${NODE}`);
  assert.equal(fake.opened[0].counter, (await stores.devices.get(N)).counter);
  const frame = fake.written.find((f) => f[0] === 57);
  assert.equal(frame.length, 1 + 32 + 132);
  await assert.rejects(jobs.send({ command: `set wifi.pwd ${'x'.repeat(45)}`, nodes: [N], road: 'mesh' }), (e) => e.code === 'denied' || e.code === 'meshTooLong');
});

test('a sealed answer over MQTT that opens clears "no longer yours" without waiting for a scan', async () => {
  const devices = [{ node: NODE, key: NODE, region: '', name: 'loutest', ver: LOU20, alive: { state: 'not-yours', boot: 1, sequence: 1, region: 'se-jkp' } }];
  const { jobs, stores } = await setup({ devices });
  await jobs.send({ command: 'ver', nodes: [NODE.slice(0, 8)] });
  const d = await stores.devices.get(NODE.slice(0, 8));
  assert.equal(d.lastResult.verified, true);
  assert.equal(d.alive.state, 'online');
  assert.equal(d.alive.region, 'se-jkp');
});

test('a node added by its key, with no version and no IATA code, takes mcc3: the old scheme could not be tried', () => {
  const key = 'B'.repeat(64);
  assert.equal(scheme(rules, { node: 'BBBBBBBB', key, region: '' }), 'mcc3');
  assert.equal(scheme(rules, { node: 'BBBBBBBB', key, region: 'JKG' }), 'old');
  assert.equal(scheme(rules, { node: 'BBBBBBBB', key, region: '', fleet: { iatas: ['JKG'] } }), 'mcc3', "Beacon's IATA is where it was heard, not its scheme");
  assert.equal(scheme(rules, { node: 'BBBBBBBB', key: null, region: '' }), 'old');
  assert.equal(scheme(rules, { node: 'BBBBBBBB', key, region: '', ver: LOU19 }), 'old');
});
