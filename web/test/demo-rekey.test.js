// The key replacement (`rekey`) in the demo: the whole round against the simulated nodes, through
// the real keyring, the real jobs and the real plane, with the demo's own invented keys. Nothing
// reaches a network; the nodes answer at once (delay 0) and keep the demo's clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { demoPlane, REKEY_OK, REKEY_SAME, REKEY_USE, REKEY_WAIT_MS } from '../lib/demo/nodes.js';
import { demoNextSeedHex, demoWorld, seedDemo } from '../lib/demo/world.js';
import { createJobs } from '../lib/jobs/jobs.js';
import {
  META_ID, STATES, abortRefusal, finishRefusal, keyText, offerCommand, provedNodes, rotate, start, summary, view,
} from '../lib/jobs/rekey.js';
import { createMqttClient } from '../lib/protocol/mqtt-client.js';
import { newSession } from '../lib/protocol/plane.js';
import * as mcc3 from '../lib/protocol/mcc3.js';
import { fromUtf8 } from '../lib/bytes.js';
import { rulesFrom } from '../lib/protocol/rules.js';
import { memoryDb } from '../lib/store/db.js';
import { copyStores, openStores } from '../lib/store/index.js';
import { createKeyring } from '../lib/key/keyring.js';
import { memoryStorage } from '../lib/key/storage.js';

const json = (name) => JSON.parse(readFileSync(new URL(`../lib/data/${name}.json`, import.meta.url), 'utf8'));
const data = Object.fromEntries(['commands', 'cautions', 'denylist', 'facts', 'firmware', 'help', 'protocol', 'results', 'brokers', 'areas'].map((n) => [n, json(n)]));
const rules = rulesFrom(data);
const world = demoWorld();
const by = (name) => world.nodes.find((n) => n.name === `DEMO-${name}`);

// The demo as the page builds it (ui/demo/start.js, ui/screens/node-services.js): the invented key
// in a keyring in memory, the fleet in memory stores, two sets of jobs over the same stores.
async function setup() {
  newSession();
  const clock = { t: Date.now() };
  const plane = demoPlane(world, { rules, now: () => clock.t, delay: () => 0 });
  const db = memoryDb();
  const stores = openStores(db, world.owner.key);
  await seedDemo(stores, world, { now: clock.t, results: data.results });
  const ring = createKeyring({ storage: memoryStorage(), iterations: 1000 });
  await ring.importKey(world.owner.seedHex, world.owner.passphrase);
  await ring.setAutoLock(null);
  const connect = (opts) => createMqttClient({ ...opts, WebSocket: plane.broker.WebSocket });
  const proved = async (s) => provedNodes(await s.meta.get(META_ID));
  const build = (s, keys, hopHandle) => createJobs({ ring: { hold: () => ring.hold(), touch() {}, ...keys }, hopHandle,
    stores: s, rules, brokers: data.brokers, results: data.results, connect, waitSecs: 0.2, sleep: async () => {} });
  let oldSecrets = {}; let nextSecrets = {};
  const jobs = build(stores, { handle: () => ring.handle(), loadSecrets: async () => ({ ...oldSecrets }), saveSecrets: async (m) => { oldSecrets = { ...m }; } },
    async (via) => ((await proved(stores)).has(via.node) ? ring.rekeyHandle() : null));
  const nextJobs = build(stores, { handle: () => ring.rekeyHandle(), loadSecrets: async () => ({ ...nextSecrets }), saveSecrets: async (m) => { nextSecrets = { ...m }; } },
    async (via) => ((await proved(stores)).has(via.node) ? null : ring.handle()));
  const next = await ring.rekeyStart(world.owner.passphrase, { seedHex: demoNextSeedHex(0) });
  await stores.meta.set(META_ID, start({ inUse: world.owner.key, next, now: clock.t }));
  const sent = [];
  // One node, by its road: MQTT, or for the node without Wi-Fi through the relay next to it.
  const go = async (name, more = {}) => {
    const n = by(name);
    const device = await stores.devices.get(n.node);
    return rotate({ load: () => stores.meta.get(META_ID), save: (r) => stores.meta.set(META_ID, r), rules, device, now: () => clock.t, ...more,
      send: async (signer, command, d) => {
        sent.push(`${signer} ${command.split(' ')[0]} ${d.name}`);
        const road = n.kind === 'mesh' ? { road: 'relay', relay: { node: by('Kvarnberget').node, route: 'neighbour' } } : {};
        return (signer === 'new' ? nextJobs : jobs).send({ command, nodes: [d.node], ...road }).then((out) => out.outcomes[0]);
      } });
  };
  const round = () => stores.meta.get(META_ID);
  const sum = async () => summary(await round(), rules, await stores.devices.list(), clock.t);
  return { clock, plane, db, stores, ring, jobs, nextJobs, next, go, sent, round, sum, build, x: (name) => plane.nodes.get(by(name).key) };
}

test('the demo\'s next keys are invented, fixed, and never the owner\'s key', () => {
  assert.equal(demoNextSeedHex(0), demoNextSeedHex(0));
  assert.notEqual(demoNextSeedHex(0), demoNextSeedHex(1));
  assert.notEqual(demoNextSeedHex(0), world.owner.seedHex);
});

test('a demo node takes rekey as the firmware does: the key waits, and the first command it signed makes it the key', async () => {
  const { jobs, nextJobs, next, x } = await setup();
  const n = by('Vattentornet');
  const node = x('Vattentornet');
  const offer = await jobs.send({ command: offerCommand(next), nodes: [n.node] });
  assert.equal(offer.outcomes[0].result.reply, REKEY_OK);
  assert.equal(node.owner, world.owner.key, 'the key in use stays the key');
  assert.equal(node.pending.key, next);
  assert.equal((await jobs.send({ command: 'get af', nodes: [n.node] })).outcomes[0].result.reply, '1.0', 'and still commands the node');
  assert.equal(node.pending.key, next, 'a command the old key signed changes nothing');
  const proof = await nextJobs.send({ command: 'ver', nodes: [n.node] });
  assert.equal(proof.outcomes[0].result.verified, true, 'the answer is sealed to the new key');
  assert.equal(proof.outcomes[0].result.reply, n.fw);
  assert.equal(node.owner, next);
  assert.equal(node.pending, null);
  assert.equal((await jobs.send({ command: 'ver', nodes: [n.node] })).outcomes[0].result, null, 'the old key now meets silence');
  assert.equal((await nextJobs.send({ command: 'get af', nodes: [n.node] })).outcomes[0].result.reply, '1.0');
});

test('a key that is not the form, or is the key in use, changes nothing; a key nobody holds never takes over', async () => {
  const { jobs, nextJobs, next, x } = await setup();
  const n = by('Ekbacken');
  const say = async (command) => (await jobs.send({ command, nodes: [n.node] })).outcomes[0].result.reply;
  assert.equal(await say(`rekey ${next}`), REKEY_USE, 'hex is not the form');
  assert.equal(await say('rekey'), REKEY_USE);
  assert.equal(await say(offerCommand(world.owner.key)), REKEY_SAME);
  assert.equal(x('Ekbacken').pending, null);
  assert.equal(await say(`rekey ${keyText('7E'.repeat(32))}`), REKEY_OK, 'a key nobody holds is taken as an offer');
  assert.equal((await nextJobs.send({ command: 'ver', nodes: [n.node] })).outcomes[0].result, null, 'but no command it signed ever comes');
  assert.equal(x('Ekbacken').owner, world.owner.key);
});

// One sealed command straight to a node with an expiry on the demo's clock (the jobs stamp their
// own with this computer's): the result as `handle` opens it, or null for silence.
async function raw(plane, clock, handle, node, command) {
  const x = plane.nodes.get(node.key);
  const keys = mcc3.ownerKeys(handle, node.key);
  const rid = mcc3.newRid();
  const got = [];
  const c = createMqttClient({ url: 'wss://demo.invalid/', WebSocket: plane.broker.WebSocket, onMessage: (t, b) => got.push(fromUtf8(b)) });
  await c.connect();
  await c.subscribe([{ topic: mcc3.replyTopic(rid), qos: 1 }]);
  await c.publish(mcc3.commandTopic(node.key), mcc3.sealCommand(handle, node.key, x.lastCounter + 1, Math.floor(clock.t / 1000) + 60, rid, command, { keys }), { qos: 1 });
  await new Promise((ok) => setTimeout(ok, 30));
  await c.close();
  try { return got.length ? mcc3.openResult(keys, got[0]) : null; } catch { return null; }
}

test('the 60 minutes run on the demo\'s clock: a proof that comes too late meets silence', async () => {
  const { clock, plane, ring, next, x } = await setup();
  const n = by('Rosenlund');
  const node = x('Rosenlund');
  assert.equal((await raw(plane, clock, ring.handle(), n, offerCommand(next))).reply, REKEY_OK);
  clock.t += REKEY_WAIT_MS - 1000;
  assert.equal((await raw(plane, clock, ring.handle(), n, 'ver')).code, 0);
  assert.equal(node.pending.key, next, 'still waiting a second before the hour');
  clock.t += 1000;
  assert.equal(await raw(plane, clock, ring.rekeyHandle(), n, 'ver'), null, 'the node forgot the key');
  assert.equal(node.owner, world.owner.key);
  assert.equal(node.pending, null);
  assert.equal((await raw(plane, clock, ring.handle(), n, 'ver')).code, 0, 'and the key in use still works');
  // Offered again, the hour starts again, and a proof inside it takes.
  assert.equal((await raw(plane, clock, ring.handle(), n, offerCommand(next))).reply, REKEY_OK);
  clock.t += REKEY_WAIT_MS - 1000;
  assert.equal((await raw(plane, clock, ring.rekeyHandle(), n, 'ver')).code, 0);
  assert.equal(node.owner, next);
  ring.lock();
});

test('a restart forgets the key that waits', async () => {
  const { clock, jobs, nextJobs, next, x } = await setup();
  const n = by('Sjöudden');
  await jobs.send({ command: offerCommand(next), nodes: [n.node] });
  assert.ok(x('Sjöudden').pending);
  await jobs.send({ command: 'reboot', nodes: [n.node] });
  clock.t += 21000;
  assert.equal((await nextJobs.send({ command: 'ver', nodes: [n.node] })).outcomes[0].result, null);
  assert.equal(x('Sjöudden').owner, world.owner.key);
});

test('the whole round: behind the relay first, the relays last, the silent and the old left behind, then finish', async () => {
  const { clock, plane, db, stores, ring, next, go, sent, round, sum, build, x } = await setup();
  assert.equal((await ring.status()).rekey.backup, null);
  await ring.rekeyBackup(world.owner.passphrase);                    // the demo counts its invented key as saved
  // 1. The node without Wi-Fi, through the relay, both still on the key in use.
  assert.equal((await go('Granbo')).state, STATES.proved);
  assert.equal(x('Granbo').owner, next);
  // 2. The nodes on Wi-Fi.
  for (const name of ['Vattentornet', 'Rosenlund', 'Ekbacken', 'Sjöudden']) assert.equal((await go(name)).state, STATES.proved, name);
  // 3. The relay last.
  assert.equal((await go('Kvarnberget')).state, STATES.proved);
  // The offline node is offered once and says nothing; the old and the never-heard are not sent to.
  assert.equal((await go('Torpa')).state, STATES.failed);
  await assert.rejects(go('Lövåsen'), (e) => e.code === 'usb');
  await assert.rejects(go('Hagen'), (e) => e.code === 'noVersion');
  assert.deepEqual(sent.filter((s) => /Torpa|Lövåsen|Hagen/.test(s)), ['old rekey DEMO-Torpa']);
  assert.equal(sent.length, 6 * 2 + 1, 'two sends a node, none repeated');
  // The relay is on the new key now; a command to the node behind it still gets there, the hop
  // sealed with the key the relay is on.
  const s = await sum();
  assert.deepEqual(s.proved.map((d) => d.name).sort(), ['DEMO-Ekbacken', 'DEMO-Granbo', 'DEMO-Kvarnberget', 'DEMO-Rosenlund', 'DEMO-Sjöudden', 'DEMO-Vattentornet']);
  assert.deepEqual(s.pending.map((d) => d.name), ['DEMO-Torpa']);
  assert.deepEqual(s.cannot.map((c) => `${c.device.name} ${c.why}`), ['DEMO-Lövåsen usb', 'DEMO-Hagen noVersion']);
  assert.deepEqual(abortRefusal(s)?.code, 'taken', 'abort is shut: nodes are on the new key');
  assert.deepEqual(finishRefusal(s), { code: 'left', names: ['DEMO-Torpa'] });
  assert.equal(finishRefusal(s, true), null);
  // Finish, leaving Torpa behind: the data follows the key, then the key changes.
  await copyStores(db, world.owner.key, next, { skipMeta: [META_ID] });
  const handle = await ring.rekeyFinish();
  await stores.meta.set(META_ID, null);
  assert.equal(handle.publicKeyHex, next);
  assert.equal((await ring.status()).publicKeyHex, next);
  assert.deepEqual((await ring.status()).replaced.map((r) => r.publicKeyHex), [world.owner.key]);
  assert.equal(await round(), null);
  // The page after finish: the new key's own stores and jobs, nothing else.
  const mine = openStores(db, next);
  let secrets = {};
  const after = build(mine, { handle: () => ring.handle(), loadSecrets: async () => ({ ...secrets }), saveSecrets: async (m) => { secrets = { ...m }; } }, null);
  assert.equal((await mine.devices.list()).length, world.nodes.length);
  const ver = await after.send({ command: 'ver', nodes: [by('Ekbacken').node] });
  assert.equal(ver.outcomes[0].result.reply, by('Ekbacken').fw, 'the counter went on: no replay');
  const found = await after.discoverAlive({ waitSecs: 0.3 });
  assert.deepEqual(found.filter((e) => e.state === 'online').map((e) => e.name).sort(),
    ['DEMO-Ekbacken', 'DEMO-Kvarnberget', 'DEMO-Rosenlund', 'DEMO-Sjöudden', 'DEMO-Vattentornet'], 'their alive is sealed to the new key');
  for (const e of found.filter((f) => f.state === 'online')) await mine.devices.update(e.node, { alive: e.alive });
  const far = await after.send({ command: 'ver', nodes: [by('Granbo').node], road: 'relay', relay: { node: by('Kvarnberget').node, route: 'neighbour' } });
  assert.equal(far.outcomes[0].result.reply, by('Granbo').fw);
  assert.ok(clock.t && plane);
  ring.lock();
});

test('the mixed case: with the relay already on the new key, the node behind it is still offered and proved through it', async () => {
  const { go, x, next, sent } = await setup();
  assert.equal((await go('Kvarnberget')).state, STATES.proved);
  const out = await go('Granbo');
  assert.equal(out.state, STATES.proved, 'the offer is signed by the old key for the target, the hop sealed with the relay\'s new one');
  assert.equal(out.steps[0].outcome.info.status, 'answered');
  assert.equal(x('Granbo').owner, next);
  assert.deepEqual(sent, ['old rekey DEMO-Kvarnberget', 'new ver DEMO-Kvarnberget', 'old rekey DEMO-Granbo', 'new ver DEMO-Granbo']);
});

test('abort before any proof: the nodes keep the key in use and the next key is gone', async () => {
  const { ring, jobs, next, stores, sum, x } = await setup();
  await jobs.send({ command: offerCommand(next), nodes: [by('Ekbacken').node] });
  assert.equal(abortRefusal(await sum()), null);
  await ring.rekeyAbort();
  await stores.meta.set(META_ID, null);
  assert.equal(ring.rekeyHandle(), null);
  assert.equal((await ring.status()).publicKeyHex, world.owner.key);
  assert.equal(x('Ekbacken').owner, world.owner.key);
  assert.equal((await jobs.send({ command: 'ver', nodes: [by('Ekbacken').node] })).outcomes[0].result.code, 0);
  const v = view(start({ inUse: world.owner.key, next, now: 0 }), rules, await stores.devices.get(by('Ekbacken').node), 0);
  assert.equal(v.state, STATES.waiting);
  ring.lock();
});
