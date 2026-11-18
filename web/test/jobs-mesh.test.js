// The mesh road in the jobs (W-16), as mccontrol's actions.road / send / send_mesh do it: the
// road choice, the checks before signing, the companion, mesh-closed sent again over MQTT, the
// broker unreachable taken over the mesh, silence as silence, and history keeping the road.
// A fake companion and a fake broker; nothing transmits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from '../lib/store/db.js';
import { openStores } from '../lib/store/index.js';
import { rulesFrom } from '../lib/protocol/rules.js';
import { createJobs, JobError } from '../lib/jobs/jobs.js';
import { blocker, preflight } from '../lib/jobs/checks.js';
import { chooseRoad, mqttHeardAt, startRoad } from '../lib/jobs/road.js';
import { openCompanion } from '../lib/mesh/companion.js';
import { keyFromSeed } from '../lib/key/handle.js';
import { fromHex } from '../lib/bytes.js';
import { data, V } from './protocol-helpers.js';
import { fakeTransport } from './jobs-fakes.js';
import { fakeCompanion } from './mesh-fakes.js';

const all = Object.fromEntries(['brokers', 'cautions', 'commands', 'denylist', 'facts', 'firmware', 'results'].map((n) => [n, data(n)]));
const rules = rulesFrom(all);
const owner = keyFromSeed(fromHex(V.seed));
const LOU19 = 'esp32s3-v1.18.0-lou-19-arrc-observer-1a2b3c4d';
const LOU18 = 'esp32s3-v1.18.0-lou-18-arrc-observer-1a2b3c4d';
const ONLY = 'nrf52-v1.18.0-lou-19-rc-1a2b3c4d';
const K = V.node_key;
const N = K.slice(0, 8);
const NOW = Date.parse('2026-11-17T12:00:00Z');
const ago = (mins) => new Date(NOW - mins * 60000).toISOString();

const ring = () => ({ handle: () => owner, hold: () => () => {}, touch() {} });

async function setup({ ver = LOU19, key = K, device = {}, companion = {}, broker = {}, connected = true } = {}) {
  const stores = openStores(memoryDb(), 'C'.repeat(64));
  await stores.devices.add({ node: K, key, region: 'JKG', name: 'loutest' });
  await stores.devices.update(N, { ver, ...device });
  const fake = fakeCompanion({ ownerKey: owner.publicKeyHex, contacts: { [K]: 1 }, region: rules.meshOnly(ver) ? 'mesh' : 'JKG', ...companion });
  const radio = connected ? await openCompanion(fake.link) : null;
  const transport = fakeTransport({ [N]: { ver, ...broker } });
  if (broker.down) transport.send = async () => { throw new Error('cannot reach wss://mqtt-meshcore.louie.se'); };
  const jobs = createJobs({ ring: ring(), stores, rules, brokers: all.brokers, results: all.results, transport, waitSecs: 1,
    companion: () => radio, now: () => NOW });
  return { stores, jobs, transport, fake };
}

test('the auto road: mesh only, a mesh-only command, not heard for N minutes; otherwise MQTT', () => {
  const d = (x) => ({ node: N, key: K, region: 'JKG', name: 'loutest', ver: LOU19, ...x });
  const pick = (device, command, extra = {}) => chooseRoad(rules, { device, command, via: 'auto', now: NOW, ...extra });
  assert.deepEqual(pick(d({ ver: ONLY }), 'ver'), { road: 'mesh', why: { code: 'meshOnly', vars: {} } });
  assert.equal(pick(d({}), 'set wifi.ssid HomeNet').why.code, 'meshCommand');
  assert.deepEqual(pick(d({ lastHeardMqtt: ago(20) }), 'ver'), { road: 'mesh', why: { code: 'notHeard', vars: { mins: 20 } } });
  assert.equal(pick(d({ lastHeardMqtt: ago(20) }), 'ver', { meshAfterMins: 30 }).road, 'mqtt');
  assert.equal(pick(d({ lastHeardMqtt: ago(5) }), 'ver').road, 'mqtt');
  assert.equal(pick(d({}), 'ver').road, 'mqtt', 'never heard: MQTT');
  assert.equal(pick(d({ lastHeardMqtt: ago(60) }), 'ver', { heardAt: NOW - 60000 }).road, 'mqtt', "Beacon's word first");
  assert.equal(chooseRoad(rules, { device: d({}), command: 'ver', via: 'mesh' }).road, 'mesh');
  assert.throws(() => chooseRoad(rules, { device: d({ ver: ONLY }), command: 'ver', via: 'mqtt' }), (e) => e.code === 'meshOnlyNode');
  assert.throws(() => chooseRoad(rules, { device: null, command: 'ver', via: 'mesh' }), (e) => e.code === 'meshBroadcast');
  assert.throws(() => chooseRoad(rules, { device: d({}), command: 'ver', via: 'pigeon' }), (e) => e.code === 'badRoad');
  // heard over the mesh last: the plain lastHeard no longer counts as MQTT
  assert.equal(mqttHeardAt({ lastHeard: ago(1), lastHeardMesh: ago(1) }), null);
  assert.equal(mqttHeardAt({ lastHeard: ago(1) }), NOW - 60000);
  assert.equal(mqttHeardAt({ fleet: { seen: ago(3) }, lastHeardMqtt: ago(9) }), NOW - 180000);
});

test('checks by road: the allowance, mesh-only refusals, 59 bytes, the whole key, the firmware', () => {
  const dev = { node: N, key: K, region: 'JKG', name: 'loutest', ver: LOU19 };
  assert.equal(blocker(rules, { command: 'set wifi.ssid HomeNet', device: dev }).code, 'denied');
  assert.equal(blocker(rules, { command: 'set wifi.ssid HomeNet', device: dev, road: 'mesh' }), null);
  assert.equal(blocker(rules, { command: 'set wifi.ssid HomeNet', device: dev, road: 'auto' }), null);
  assert.equal(blocker(rules, { command: 'set prv.key 00', device: dev, road: 'auto' }).code, 'denied');
  assert.equal(blocker(rules, { command: 'ota check', device: { ...dev, ver: ONLY }, road: 'mesh' }).code, 'denied');
  assert.equal(blocker(rules, { command: 'ver', device: { ...dev, ver: ONLY } }).code, 'meshOnlyNode');
  assert.equal(blocker(rules, { command: `set name ${'x'.repeat(60)}`, device: dev, road: 'mesh' }).code, 'denied');
  assert.equal(blocker(rules, { command: 'ver', device: { ...dev, key: null }, road: 'mesh' }).code, 'meshNoKey');
  assert.equal(blocker(rules, { command: 'ver', device: { ...dev, ver: LOU18 }, road: 'mesh' }).code, 'meshOldFirmware');
  assert.equal(blocker(rules, { command: 'ver', device: { ...dev, ver: null }, road: 'mesh' }), null, 'an unknown version may try');
  assert.equal(blocker(rules, { command: 'ver', region: 'JKG', road: 'mesh' }).code, 'meshBroadcast');
  const p = preflight(rules, { command: 'set wifi.pwd s3cret', device: dev, road: 'auto' });
  assert.equal(p.road.road, 'mesh');
  assert.equal(p.v2, false);
});

test('send by mesh: signed, through the companion, answered, recorded with its road', async () => {
  const { jobs, stores, transport, fake } = await setup();
  const out = await jobs.send({ command: 'set wifi.ssid HomeNet', nodes: [N], road: 'mesh' });
  const [o] = out.outcomes;
  assert.equal(o.road, 'mesh');
  assert.equal(o.result.code, 0);
  assert.equal(o.result.verified, true);
  assert.equal(o.info.path, 'direct, 1 hop(s)');
  assert.equal(transport.calls.length, 0, 'nothing over MQTT');
  assert.equal(fake.written.filter((f) => f[0] === 57).length, 1);
  const [e] = await stores.history.list();
  assert.equal(e.road, 'mesh');
  assert.equal(e.topic, `meshcore/JKG/${K}/cmd`);
  const d = await stores.devices.get(N);
  assert.ok(d.lastHeardMesh);
  assert.equal(d.lastHeardMqtt, undefined);
});

test('a mesh-only node goes over the mesh, signed for the region named mesh', async () => {
  const { jobs, stores } = await setup({ ver: ONLY });
  const out = await jobs.send({ command: 'get name', nodes: [N], road: 'auto' });
  assert.equal(out.outcomes[0].road, 'mesh');
  assert.equal(out.outcomes[0].why.code, 'meshOnly');
  assert.equal(out.outcomes[0].result.code, 0);
  assert.equal((await stores.history.list())[0].topic, `meshcore/mesh/${K}/cmd`);
  await assert.rejects(jobs.send({ command: 'get name', nodes: [N], road: 'mqtt' }), (e) => e.code === 'meshOnlyNode');
});

test('auto: mesh-closed is recorded and the command sent again over MQTT', async () => {
  const { jobs, stores, transport } = await setup({ device: { lastHeardMqtt: ago(30) }, companion: { answer: () => ({ code: 19 }) } });
  const out = await jobs.send({ command: 'ver', nodes: [N], road: 'auto' });
  assert.equal(out.outcomes[0].road, 'mqtt');
  assert.equal(out.outcomes[0].why.code, 'meshClosed');
  assert.equal(transport.calls.length, 1);
  const events = await stores.history.list();
  assert.deepEqual(events.map((e) => [e.road, e.code]).sort(), [['mesh', 19], ['mqtt', 0]]);
});

test('mesh-closed on the mesh road alone is the answer, not a resend', async () => {
  const { jobs, transport } = await setup({ companion: { answer: () => ({ code: 19 }) } });
  const out = await jobs.send({ command: 'ver', nodes: [N], road: 'mesh' });
  assert.equal(out.outcomes[0].result.code, 19);
  assert.equal(transport.calls.length, 0);
});

test('auto: the broker unreachable, the mesh after all', async () => {
  const { jobs } = await setup({ broker: { down: true } });
  const out = await jobs.send({ command: 'ver', nodes: [N], road: 'auto' });
  assert.equal(out.outcomes[0].road, 'mesh');
  assert.equal(out.outcomes[0].why.code, 'mqttUnreachable');
  assert.equal(out.outcomes[0].result.code, 0);
});

test('silence over the mesh is silence: no code, recorded as such', async () => {
  const { jobs, stores } = await setup({ companion: { answer: () => null } });
  const out = await jobs.send({ command: 'ver', nodes: [N], road: 'mesh' });
  assert.equal(out.outcomes[0].result, null);
  assert.equal(out.answered, 0);
  const [e] = await stores.history.list();
  assert.equal(e.code, null);
  assert.equal(e.road, 'mesh');
  assert.equal((await stores.devices.get(N)).lastHeard, null);
});

test('no companion connected, or a check fails: nothing signed, nothing sent', async () => {
  const off = await setup({ connected: false });
  await assert.rejects(off.jobs.send({ command: 'ver', nodes: [N], road: 'mesh' }), (e) => e instanceof JobError && e.code === 'noCompanion');
  const old = await setup({ ver: LOU18 });
  await assert.rejects(old.jobs.send({ command: 'ver', nodes: [N], road: 'mesh' }), (e) => e.code === 'meshOldFirmware');
  await assert.rejects(old.jobs.send({ command: `set name ${'y'.repeat(60)}`, nodes: [N], road: 'mesh' }), (e) => e.code === 'denied');
  assert.equal(old.fake.written.filter((f) => f[0] === 57).length, 0);
  await assert.rejects(old.jobs.send({ command: 'ver', region: 'JKG', road: 'mesh' }), (e) => e.code === 'meshBroadcast');
});

test('importing history keeps a road and refuses a made-up one', async () => {
  const { stores } = await setup();
  const base = { at: '2026-11-17T10:00:00.000Z', command: 'ver', node: N };
  const r = await stores.history.import([{ ...base, id: 'a1', road: 'mesh' }, { ...base, id: 'a2', road: 'pigeon' }, { ...base, id: 'a3' }]);
  assert.equal(r.added, 2);
  const roads = Object.fromEntries((await stores.history.list()).map((e) => [e.id, e.road]));
  assert.deepEqual(roads, { a1: 'mesh', a3: 'mqtt' });
});

// W-26b, W-26c: the selector starts on the node's remembered road, else the mesh with a companion.
test('the road the selector starts on: remembered, else mesh with a companion, else MQTT', () => {
  assert.equal(startRoad({}), 'mqtt');
  assert.equal(startRoad({ companion: true }), 'mesh');
  assert.equal(startRoad({ meshOnly: true }), 'auto');
  assert.equal(startRoad({ remembered: 'mqtt', companion: true }), 'mqtt');
  assert.equal(startRoad({ remembered: 'auto' }), 'auto');
  assert.equal(startRoad({ remembered: 'mqtt', meshOnly: true, companion: true }), 'mesh');
  assert.equal(startRoad({ remembered: 'bogus' }), 'mqtt');
});
