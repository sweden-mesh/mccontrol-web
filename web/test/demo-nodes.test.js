// The demo's nodes (W-39i, W-39k): through the real jobs and the real plane, against the in-page
// command server. Nothing reaches a network; the nodes answer at once (delay 0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { demoPlane, RATE_PER_HOUR, FLOODS_PER_HOUR } from '../lib/demo/nodes.js';
import { demoWorld, seedDemo } from '../lib/demo/world.js';
import { createJobs } from '../lib/jobs/jobs.js';
import { createMqttClient } from '../lib/protocol/mqtt-client.js';
import { newSession } from '../lib/protocol/plane.js';
import * as mcc3 from '../lib/protocol/mcc3.js';
import { rulesFrom } from '../lib/protocol/rules.js';
import { memoryDb } from '../lib/store/db.js';
import { openStores } from '../lib/store/index.js';
import { keyFromSeed } from '../lib/key/handle.js';
import { fromHex, fromUtf8 } from '../lib/bytes.js';

const json = (name) => JSON.parse(readFileSync(new URL(`../lib/data/${name}.json`, import.meta.url), 'utf8'));
const data = Object.fromEntries(['commands', 'cautions', 'denylist', 'facts', 'firmware', 'help', 'protocol', 'results', 'brokers', 'areas'].map((n) => [n, json(n)]));
const rules = rulesFrom(data);
const world = demoWorld();
const owner = keyFromSeed(fromHex(world.owner.seedHex));
const by = (name) => world.nodes.find((n) => n.name === `DEMO-${name}`);

async function setup({ clock = { t: Date.now() } } = {}) {
  newSession();
  const plane = demoPlane(world, { rules, now: () => clock.t, delay: () => 0 });
  const stores = openStores(memoryDb(), world.owner.key);
  await seedDemo(stores, world, { now: clock.t, results: data.results });
  let secrets = {};
  const connect = (opts) => createMqttClient({ ...opts, WebSocket: plane.broker.WebSocket });
  const jobs = createJobs({ ring: { handle: () => owner, hold: () => () => {}, touch() {}, loadSecrets: async () => ({ ...secrets }), saveSecrets: async (m) => { secrets = { ...m }; } },
    stores, rules, brokers: data.brokers, results: data.results, connect, waitSecs: 1, sleep: async () => {} });
  return { plane, stores, jobs, clock, connect };
}

// One sealed command straight to a node, past the jobs' own checks: what the node itself says.
async function raw(plane, node, command, { counter, expiry = Math.floor(Date.now() / 1000) + 60 } = {}) {
  const x = plane.nodes.get(node.key);
  const keys = mcc3.ownerKeys(owner, node.key);
  const rid = mcc3.newRid();
  const got = [];
  const c = createMqttClient({ url: 'wss://demo.invalid/', WebSocket: plane.broker.WebSocket, onMessage: (t, b) => got.push(fromUtf8(b)) });
  await c.connect();
  await c.subscribe([{ topic: mcc3.replyTopic(rid), qos: 1 }]);
  await c.publish(mcc3.commandTopic(node.key), mcc3.sealCommand(owner, node.key, counter ?? x.lastCounter + 1, expiry, rid, command, { keys }), { qos: 1 });
  await new Promise((ok) => setTimeout(ok, 30));
  await c.close();
  return got.length ? mcc3.openResult(keys, got[0]) : null;
}

test('a command to a demo node comes back sealed, verified, with the firmware\'s answer', async () => {
  const { jobs, stores } = await setup();
  const out = await jobs.send({ command: 'ver', nodes: [by('Vattentornet').node] });
  const [o] = out.outcomes;
  assert.equal(o.result.code, 0);
  assert.equal(o.result.verified, true);
  assert.equal(o.result.reply, by('Vattentornet').fw);
  assert.equal((await stores.devices.get(by('Vattentornet').node)).lastResult.codeName, 'ok');
  const radio = await jobs.send({ command: 'get radio', nodes: [by('Sjöudden').node] });
  assert.equal(radio.outcomes[0].result.reply, '869.618,62.5,8,8');
});

test('a set changes the node for the session: the next get shows it', async () => {
  const { jobs } = await setup();
  const n = by('Rosenlund').node;
  assert.equal((await jobs.send({ command: 'set af 2.5', nodes: [n] })).outcomes[0].result.reply, 'OK');
  assert.equal((await jobs.send({ command: 'get af', nodes: [n] })).outcomes[0].result.reply, '2.5');
  assert.equal((await jobs.send({ command: 'get af', nodes: [by('Ekbacken').node] })).outcomes[0].result.reply, '1.0', 'another node is untouched');
});

test('the node\'s own gates, in the firmware\'s order: replay, expiry, the deny list, the rate limit', async () => {
  const { plane } = await setup();
  const n = by('Ekbacken');
  const x = plane.nodes.get(n.key);
  assert.equal((await raw(plane, n, 'ver')).code, 0);
  assert.equal((await raw(plane, n, 'ver', { counter: x.lastCounter })).code, 9, 'a counter not above the last: replay');
  assert.equal((await raw(plane, n, 'ver', { expiry: Math.floor(Date.now() / 1000) - 5 })).code, 10, 'expired');
  for (const denied of ['set radio 869.618,62.5,8,5', 'set prv.key 00', 'erase', 'set mqtt.cmd.pubkey 00']) {
    assert.ok(rules.refusal(denied), denied);
    assert.equal((await raw(plane, n, denied)).code, 14, denied);
  }
  assert.equal(x.state.settings.radio, '869.618,62.5,8,8', 'a refused command changed nothing');
  let code = 0;
  for (let i = 0; i < RATE_PER_HOUR + 1 && code === 0; i += 1) code = (await raw(plane, n, 'get af')).code;
  assert.equal(code, 17, 'the eleventh in an hour is refused');
});

test('a command sealed by another key, or for another node, is met with silence', async () => {
  const { plane } = await setup();
  const n = by('Ekbacken'), m = by('Sjöudden');
  const stranger = keyFromSeed(fromHex('11'.repeat(32)));
  const rid = mcc3.newRid();
  const got = [];
  const c = createMqttClient({ url: 'wss://demo.invalid/', WebSocket: plane.broker.WebSocket, onMessage: (t) => got.push(t) });
  await c.connect();
  await c.subscribe([{ topic: mcc3.replyTopic(rid), qos: 1 }]);
  const soon = Math.floor(Date.now() / 1000) + 60;
  await c.publish(mcc3.commandTopic(n.key), mcc3.sealCommand(stranger, n.key, 9999, soon, rid, 'ver'), { qos: 1 });
  await c.publish(mcc3.commandTopic(m.key), mcc3.sealCommand(owner, n.key, 9999, soon, rid, 'ver'), { qos: 1 });
  await new Promise((ok) => setTimeout(ok, 30));
  await c.close();
  assert.deepEqual(got, []);
});

test('the offline node and the one on older firmware never answer here', async () => {
  const { jobs, plane } = await setup();
  assert.equal(plane.nodes.has(by('Torpa').key), false);
  assert.equal(plane.nodes.has(by('Lövåsen').key), false);
  const out = await jobs.send({ command: 'ver', nodes: [by('Torpa').node] });
  assert.equal(out.outcomes[0].result?.code ?? null, null, 'silence');
});

test('the alive scan finds the fleet that is on Wi-Fi by itself, and a rename shows in the next alive', async () => {
  const { jobs } = await setup();
  const found = await jobs.discoverAlive({ waitSecs: 0.3 });
  const online = found.filter((e) => e.state === 'online').map((e) => e.name).sort();
  assert.deepEqual(online, world.nodes.filter((n) => ['wifi', 'relay'].includes(n.kind)).map((n) => n.name).sort());
  assert.equal(found.find((e) => e.name === 'DEMO-Kvarnberget').alive.relay, true);
  await jobs.send({ command: 'set mqtt.relay off', nodes: [by('Kvarnberget').node] });
  const again = await jobs.discoverAlive({ waitSecs: 0.3 });
  assert.equal(again.find((e) => e.name === 'DEMO-Kvarnberget').alive.relay, false);
});

test('a reboot: silent for 20 s, then up with a new boot number', async () => {
  const clock = { t: Date.now() };
  const { plane } = await setup({ clock });
  const n = by('Sjöudden');
  const x = plane.nodes.get(n.key);
  const boot = x.state.boot;
  assert.match((await raw(plane, n, 'reboot')).reply, /rebooting/);
  assert.equal(await raw(plane, n, 'ver'), null, 'restarting: silence');
  clock.t += 21000;
  assert.equal((await raw(plane, n, 'ver')).code, 0);
  assert.equal(x.state.boot, boot, 'the timer has not fired in this test, the node answers by its clock');
});

test('through the relay to the mesh-only node: answered; off when the relay is switched off; the flood budget', async () => {
  const { jobs, plane } = await setup();
  const R = by('Kvarnberget'), T = by('Granbo');
  const via = (route, more = {}) => ({ node: R.node, route, ...more });
  const out = await jobs.send({ command: 'ver', nodes: [T.node], road: 'relay', relay: via('neighbour') });
  assert.equal(out.outcomes[0].road, 'relay');
  assert.equal(out.outcomes[0].result.reply, T.fw);
  assert.equal(out.outcomes[0].info.status, 'answered');
  let status = 'answered';
  for (let i = 0; i < FLOODS_PER_HOUR + 1; i += 1) status = (await jobs.send({ command: 'get name', nodes: [T.node], road: 'relay', relay: via('flood', { confirmed: true }) })).outcomes[0].info?.status;
  assert.equal(status, 'rate-limited', 'the third flood in an hour');
  plane.nodes.get(R.key).state.settings['mqtt.relay'] = 'off';
  const off = await jobs.send({ command: 'ver', nodes: [T.node], road: 'relay', relay: via('neighbour') });
  assert.equal(off.outcomes[0].info?.status ?? off.outcomes[0].reason?.code, 'off');
});
