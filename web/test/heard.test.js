// A node without Wi-Fi announces itself, and an Observer node of the same owner publishes what it
// caught on `mcc/heard/<KEY>/<slot>` (lou-21, L21-D8). The spec's malive-vectors.json, written by the
// firmware's own generator, is rebuilt and opened here byte for byte and every refusal is dropped;
// the discovery reads the entries from the in-memory broker: the newest (boot, sequence) per node,
// a forged entry never a device, and with no entries everything as before. Then what the screens
// show, and the demo, which publishes a real sealed entry. Nothing reaches a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mcc3 from '../lib/protocol/mcc3.js';
import { newestHeard, newSession, openHeardWith } from '../lib/protocol/plane.js';
import { keyFromSeed } from '../lib/key/handle.js';
import { fromHex, toHex } from '../lib/bytes.js';
import { b64url, unb64url } from '../lib/protocol/text.js';
import { memoryDb } from '../lib/store/db.js';
import { openStores } from '../lib/store/index.js';
import { rulesFrom } from '../lib/protocol/rules.js';
import { createJobs } from '../lib/jobs/jobs.js';
import { batteryReading, lastHeard, needsAttention } from '../lib/jobs/overview.js';
import { demoPlane } from '../lib/demo/nodes.js';
import { demoWorld, seedDemo } from '../lib/demo/world.js';
import { createMqttClient } from '../lib/protocol/mqtt-client.js';
import { data } from './protocol-helpers.js';
import { aliveFields, connectVia, mcc3Broker } from './mcc3-fakes.js';

const V = JSON.parse(readFileSync(new URL('./malive-vectors.json', import.meta.url), 'utf8'));
const C = V.constants;
const SEEDS = V.keys.seeds;
const PUB = V.keys.public;
const handleOf = (name) => keyFromSeed(fromHex(SEEDS[name]));
const owner = handleOf('owner');
const OWNER = PUB.owner;
const NODE = PUB.node;
const CATCHER = PUB.catcher;
const K_MALIVE = { node: mcc3.maliveKey(owner.sharedSecret(NODE), NODE), catcher: mcc3.maliveKey(owner.sharedSecret(CATCHER), CATCHER) };
const K_HEARD = mcc3.heardKey(owner.sharedSecret(CATCHER), CATCHER);
const ANNOUNCES = Object.fromEntries(V.announces.map((a) => [a.name, a]));
const [A1] = V.announces;
const [H1, H2] = V.heard;
const NO_ADVERT = { advert_heard_at: 0, advert_snr: 0, advert_hops: 0 };

// -- the bytes -------------------------------------------------------------------------------

test('the constants and the keys are the vectors', () => {
  assert.deepEqual([mcc3.KIND_ANNOUNCE, mcc3.KIND_HEARD, mcc3.ANNOUNCE_SIZE, mcc3.ANNOUNCE_SEALED, mcc3.ANNOUNCE_TAG, mcc3.ANNOUNCE_KEPT],
    [C.kind, C.kind_heard, C.payload_bytes, C.sealed_bytes, C.tag_bytes, C.kept_bytes]);
  assert.deepEqual([mcc3.HEARD_PLAIN, mcc3.HEARD_SIZE, mcc3.HEARD_SLOTS, mcc3.ANNOUNCE_MAX.version, mcc3.ANNOUNCE_MAX.name],
    [C.heard_plain_bytes, C.heard_bytes, C.table_slots, C.max_version, C.max_name]);
  assert.deepEqual([mcc3.INFO_MALIVE, mcc3.INFO_HEARD, mcc3.OWN_LABEL], [C.label_malive, C.label_heard, C.label_owner_tag]);
  for (const name of ['owner', 'node', 'catcher', 'other_owner']) assert.equal(handleOf(name).publicKeyHex, PUB[name], name);
  assert.equal(toHex(owner.sharedSecret(NODE), true), V.keys.shared_node_owner);
  assert.equal(toHex(owner.sharedSecret(CATCHER), true), V.keys.shared_catcher_owner);
  assert.equal(toHex(K_MALIVE.node, true), V.keys.k_malive_node);
  assert.equal(toHex(K_MALIVE.catcher, true), V.keys.k_malive_catcher);
  assert.equal(toHex(K_HEARD, true), V.keys.k_heard_catcher);
  // the node's side gives the same key: its identity and the owner's public key
  assert.equal(toHex(mcc3.maliveKey(handleOf('node').sharedSecret(OWNER), NODE), true), V.keys.k_malive_node);
});

for (const a of V.announces) {
  test(`announce ${a.name}: built and opened byte for byte`, () => {
    const node = PUB[a.node];
    assert.equal(toHex(mcc3.ownerTag(OWNER, node, a.fields.boot, a.fields.sequence), true), a.owner_tag);
    const raw = mcc3.sealAnnounce(K_MALIVE[a.node], OWNER, node, a.fields);
    assert.equal(raw.length, a.bytes);
    assert.equal(toHex(raw, true), a.payload);
    const { node_key: key, ...opened } = mcc3.openAnnounce(K_MALIVE[a.node], OWNER, fromHex(a.payload));
    assert.equal(key, node);
    assert.deepEqual(opened, a.opened);
  });
}

for (const h of V.heard) {
  test(`heard entry ${h.name}: built and opened byte for byte, then the announce inside`, () => {
    const a = ANNOUNCES[h.announce];
    const fields = Object.fromEntries(['heard_at', 'snr', 'hops', 'advert_heard_at', 'advert_snr', 'advert_hops'].map((k) => [k, h.opened[k]]));
    assert.equal(mcc3.sealHeard(K_HEARD, PUB[a.node], fromHex(a.payload), fields, { nonce: fromHex(h.nonce) }), h.payload);
    assert.equal(mcc3.heardTopic(CATCHER, h.slot), h.topic);
    assert.deepEqual(mcc3.heardFromTopic(h.topic), { key: CATCHER, slot: h.slot });
    const { announce, ...opened } = mcc3.openHeard(K_HEARD, h.payload);
    const { announce: want, ...rest } = h.opened;
    assert.equal(toHex(announce, true), want);
    assert.equal(want, a.payload);
    assert.deepEqual(opened, rest);
    const whole = openHeardWith(owner, {}, CATCHER, h.payload);
    for (const [k, v] of Object.entries(a.opened)) assert.deepEqual(whole[k], v, k);
    for (const [k, v] of Object.entries(fields)) assert.equal(whole[k], v, k);
    assert.equal(whole.node_key, NODE);
    assert.equal(whole.by, CATCHER);
  });
}

for (const r of V.refusals) {
  test(`refusal: ${r.name} is ${r.outcome}`, () => {
    assert.throws(() => mcc3.openAnnounce(K_MALIVE.node, OWNER, fromHex(r.input)), (e) => e instanceof mcc3.Refused && e.outcome === r.outcome);
    // inside a good heard entry (the catching node cannot tell): dropped by the tool
    if (r.input.length === C.payload_bytes * 2) {
      const raw = fromHex(r.input);
      const entry = mcc3.sealHeard(K_HEARD, toHex(raw.subarray(1, 33), true), raw, { heard_at: 1, snr: 0, hops: 0, ...NO_ADVERT });
      assert.equal(openHeardWith(owner, {}, CATCHER, entry), null);
    }
  });
}

const entryOf = (announce, { node = NODE, key = K_HEARD, heardAt = 1795000050, snr = -22, hops = 2 } = {}) =>
  mcc3.sealHeard(key, node, announce, { heard_at: heardAt, snr, hops, ...NO_ADVERT });
const forgedAnnounce = (over = {}) => mcc3.sealAnnounce(new Uint8Array(32), OWNER, NODE, { ...A1.fields, ...over });

test('an entry that does not open, or one of another owner or another node, is dropped', () => {
  const raw = unb64url(H1.payload);
  for (const at of [0, 1, 13, raw.length - 1]) {
    const bent = Uint8Array.from(raw);
    bent[at] ^= 1;
    assert.equal(openHeardWith(owner, {}, CATCHER, b64url(bent)), null, `byte ${at}`);
  }
  assert.equal(openHeardWith(owner, {}, CATCHER, b64url(raw.subarray(0, raw.length - 1))), null);
  assert.equal(openHeardWith(owner, {}, CATCHER, 'not base64 !'), null);
  assert.equal(openHeardWith(handleOf('other_owner'), {}, CATCHER, H1.payload), null, "another owner's tool");
  assert.equal(openHeardWith(owner, {}, NODE, H1.payload), null, "another node's slot");
  assert.equal(openHeardWith(owner, {}, CATCHER, H1.payload).battery_mv, 3987);
});

test('the cut tag is checked: an announce sealed under another key with a right owner tag never opens', () => {
  const forged = forgedAnnounce({ battery_mv: 1 });
  assert.equal(toHex(forged.subarray(0, 46), true), A1.payload.slice(0, 92), 'the clear part is the real one');
  assert.throws(() => mcc3.openAnnounce(K_MALIVE.node, OWNER, forged), (e) => e.outcome === 'does-not-open');
  assert.equal(openHeardWith(owner, {}, CATCHER, entryOf(forged)), null);
});

test('the newest (boot, sequence) wins, whoever caught it', () => {
  const a1 = openHeardWith(owner, {}, CATCHER, H1.payload);
  const a2 = openHeardWith(owner, {}, CATCHER, H2.payload);
  assert.equal(newestHeard([a1, a2])[NODE].sequence, 2);
  assert.equal(newestHeard([a2, a1, null])[NODE].sequence, 2);
  assert.equal(newestHeard([a2, { ...a1, boot: 8, sequence: 1 }])[NODE].boot, 8);
  assert.deepEqual(newestHeard([]), {});
});

test('a topic that is no heard slot names none', () => {
  for (const t of [`mcc/heard/${CATCHER}`, `mcc/heard/${CATCHER}/16`, `mcc/heard/${CATCHER}/01`, `mcc/heard/${CATCHER}/-1`,
    `mcc/heard/${CATCHER}/0/x`, `mcc/heard/${CATCHER.toLowerCase()}/0`, 'mcc/heard/ABCD/0', `mcc/alive/${CATCHER}`]) {
    assert.equal(mcc3.heardFromTopic(t), null, t);
  }
});

// -- the discovery ---------------------------------------------------------------------------

const rules = rulesFrom(Object.fromEntries(['brokers', 'cautions', 'commands', 'denylist', 'facts', 'firmware', 'results'].map((n) => [n, data(n)])));
const catcherAlive = (by = owner, over = {}) => mcc3.sealAlive(mcc3.ownerKeys(by, CATCHER), aliveFields({ name: 'DEMO-Observer', ...over }));

async function setup(retained, devices = []) {
  newSession();
  const stores = openStores(memoryDb(), 'C'.repeat(64));
  for (const d of devices) await stores.devices.add(d);
  const broker = mcc3Broker({ retained });
  let secrets = {};
  const jobs = createJobs({
    ring: { handle: () => owner, hold: () => () => {}, touch() {}, loadSecrets: async () => ({ ...secrets }), saveSecrets: async (m) => { secrets = { ...m }; } },
    stores, rules, brokers: data('brokers'), results: data('results'), connect: connectVia(broker), waitSecs: 1, sleep: async () => {},
  });
  return { stores, jobs, broker, secrets: () => secrets };
}

test('an announced node is found, listed as heard, and adopted as a node without Wi-Fi with its battery; nothing sent', async () => {
  const { jobs, broker, stores } = await setup({ [mcc3.aliveTopic(CATCHER)]: catcherAlive(), [H1.topic]: H1.payload });
  const found = await jobs.discoverAlive({ waitSecs: 0.4 });
  assert.deepEqual(found.map((e) => [e.key, e.state]).sort(), [[CATCHER, 'online'], [NODE, 'heard']].sort());
  const e = found.find((x) => x.key === NODE);
  assert.equal(e.name, A1.opened.name);
  assert.equal(e.version, A1.opened.version);
  assert.equal(e.knownAs, null);
  assert.equal(e.heard.batteryMv, 3987);
  assert.deepEqual([e.heard.by, e.heard.byName, e.heard.snr, e.heard.hops, e.heard.boot, e.heard.sequence, e.heard.uptime],
    [CATCHER.slice(0, 8), 'DEMO-Observer', -5.5, 2, 7, 1, 42]);
  assert.equal(e.heard.at, new Date(1795000050 * 1000).toISOString());
  assert.equal(e.heard.atRead, false);
  assert.equal(broker.received.filter((p) => p.type === 'publish').length, 0, 'a read: nothing sent');
  assert.ok(broker.received.some((p) => p.type === 'subscribe' && p.topics.some((t) => t.topic === mcc3.HEARD_FILTER)));
  assert.equal(await stores.devices.get(NODE.slice(0, 8)), undefined, 'adopting is the caller\'s');
  const d = await jobs.adopt({ node: e.key, key: e.key, region: '', name: e.name, heard: e.heard });
  assert.equal(d.key, NODE);
  assert.equal(d.meshOnly, true);
  assert.equal(d.ver, 'lou-21-arrc');
  assert.equal(d.heard.batteryMv, 3987);
  assert.equal(rules.deviceMeshOnly(d), true);
  // two hops: the catching node does not hear it itself, so it is not kept as a relay that hears it
  assert.equal(d.relayHears, undefined);
});

test('with no heard entries (lou-20) everything is as before', async () => {
  const { jobs, stores } = await setup({ [mcc3.aliveTopic(CATCHER)]: catcherAlive() });
  const found = await jobs.discoverAlive({ waitSecs: 0.4 });
  assert.deepEqual(found.map((e) => [e.key, e.state]), [[CATCHER, 'online']]);
  assert.equal(found[0].heard, undefined);
  assert.deepEqual(await stores.devices.list(), []);
});

test('only the slots of our own Observer nodes are opened', async () => {
  const stranger = `mcc/heard/${PUB.other_owner}/0`;
  const { jobs, secrets } = await setup({ [mcc3.aliveTopic(CATCHER)]: catcherAlive(handleOf('other_owner')), [H1.topic]: H1.payload, [stranger]: H1.payload });
  assert.deepEqual(await jobs.discoverAlive({ waitSecs: 0.4 }), []);
  assert.equal(secrets()[NODE], undefined, 'no key agreement spent on an announce of a node not ours');
});

test('a forged entry never reaches the node list', async () => {
  const raw = unb64url(H1.payload);
  const bent = Uint8Array.from(raw);
  bent[raw.length - 1] ^= 1;
  const otherOwnersTag = mcc3.sealAnnounce(K_MALIVE.node, PUB.other_owner, NODE, A1.fields);
  const { jobs, stores } = await setup({
    [mcc3.aliveTopic(CATCHER)]: catcherAlive(),
    [mcc3.heardTopic(CATCHER, 1)]: entryOf(forgedAnnounce({ name: 'DEMO-Forged' })),
    [mcc3.heardTopic(CATCHER, 2)]: entryOf(otherOwnersTag),
    [mcc3.heardTopic(CATCHER, 3)]: b64url(bent),
    [mcc3.heardTopic(CATCHER, 4)]: 'x'.repeat(188),
    [`mcc/heard/${CATCHER}/16`]: H1.payload,
  }, [{ node: NODE, key: NODE, region: '', name: 'cabin' }]);
  const found = await jobs.discoverAlive({ waitSecs: 0.4 });
  assert.deepEqual(found.map((e) => e.key), [CATCHER]);
  assert.equal((await stores.devices.get(NODE.slice(0, 8))).heard, undefined);
});

test('the newest announce is kept on a node you have, a name you typed stays, a direct one makes the catcher a relay that hears it', async () => {
  const { jobs, stores } = await setup({ [mcc3.aliveTopic(CATCHER)]: catcherAlive(), [H1.topic]: H1.payload, [H2.topic]: H2.payload },
    [{ node: NODE, key: NODE, region: '', name: 'cabin' }]);
  const found = await jobs.discoverAlive({ waitSecs: 0.4 });
  const e = found.find((x) => x.key === NODE);
  assert.deepEqual([e.state, e.knownAs], ['heard', 'cabin']);
  const d = await stores.devices.get(NODE.slice(0, 8));
  assert.equal(d.name, 'cabin');
  assert.equal(d.meshOnly, true);
  assert.deepEqual([d.heard.boot, d.heard.sequence, d.heard.batteryMv, d.heard.atRead], [7, 2, null, true], 'A2: no battery, the catching clock unset');
  assert.deepEqual(d.relayHears[CATCHER.slice(0, 8)], { hears: true, snr: 47 / 4, at: d.heard.at }, 'H2 came with no hop');
  assert.equal(batteryReading(d), null);
  // an older announce read later (the newer slot was emptied) does not replace it
  const later = await setup({ [mcc3.aliveTopic(CATCHER)]: catcherAlive(), [H1.topic]: H1.payload });
  await later.stores.devices.add({ node: NODE, key: NODE, region: '', name: 'cabin' });
  await later.stores.devices.update(NODE.slice(0, 8), { heard: d.heard });
  await later.jobs.discoverAlive({ waitSecs: 0.4 });
  assert.equal((await later.stores.devices.get(NODE.slice(0, 8))).heard.sequence, 2);
});

// -- what the screens show -------------------------------------------------------------------

const NOW = Date.parse('2026-11-27T12:00:00Z');
const heardRec = { at: '2026-11-27T03:00:00.000Z', atRead: false, by: CATCHER.slice(0, 8), byName: 'DEMO-Observer', snr: 3.25, hops: 0, batteryMv: 3710 };
const fleet = { batteryMv: 4011, seen: '2026-11-27T11:30:00.000Z' };

test('the battery shown is the newer of Beacon\'s and the announce\'s', () => {
  assert.equal(batteryReading({}), null);
  assert.deepEqual(batteryReading({ heard: heardRec }), { mv: 3710, at: Date.parse(heardRec.at), source: 'heard', by: heardRec.by, byName: 'DEMO-Observer' });
  assert.equal(batteryReading({ fleet, heard: heardRec }).source, 'beacon');
  assert.equal(batteryReading({ fleet: { ...fleet, seen: '2026-11-26T11:30:00.000Z' }, heard: heardRec }).source, 'heard');
  assert.equal(batteryReading({ fleet: { batteryMv: 0, seen: fleet.seen }, heard: heardRec }).source, 'heard', '0 mV is no reading');
  assert.equal(lastHeard({ heard: heardRec }), Date.parse(heardRec.at));
});

test('low battery: the newest reading whatever its age, and a node without Wi-Fi is never "not heard on MQTT"', () => {
  const opts = { now: NOW, hours: 2, thresholdMv: 3800, rules };
  const old = { node: 'AAAA0001', name: 'DEMO-Old', meshOnly: true, heard: { ...heardRec, at: '2026-11-20T03:00:00.000Z' } };
  assert.deepEqual(needsAttention([old], opts).map((r) => [r.kind, r.vars.volts]), [['battery', '3.71']]);
  assert.deepEqual(needsAttention([{ ...old, fleet }], opts), [], 'Beacon\'s reading is newer and not low');
  assert.deepEqual(needsAttention([{ ...old, heard: { ...old.heard, batteryMv: 3900 } }], opts), []);
  // the same threshold as a node on Wi-Fi
  assert.deepEqual(needsAttention([{ node: 'AAAA0002', fleet: { batteryMv: 3710, seen: fleet.seen } }], opts).map((r) => r.kind), ['battery']);
});

test('the words: volts, age and source; who heard it and when', async () => {
  const { batteryWords, heardWords } = await import('../ui/screens/node-kit.js');
  const en = JSON.parse(readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
  const sv = JSON.parse(readFileSync(new URL('../i18n/sv.json', import.meta.url), 'utf8'));
  const ctxOf = (lang, strings) => ({ lang, t: (k, vars = {}) => String(strings[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => vars[n] ?? '') });
  const ctx = ctxOf('en', en);
  const d = { heard: heardRec };
  assert.match(batteryWords(ctx, d, NOW), /^3\.71 V, 9 hr?\.? ago, heard by DEMO-Observer$/);
  assert.match(heardWords(ctx, d, NOW), /^heard by DEMO-Observer 9 hr?\.? ago$/);
  assert.match(batteryWords(ctx, { fleet, heard: heardRec }, NOW), /^4\.01 V, 30 min\.? ago, from Beacon$/);
  assert.match(batteryWords(ctx, { heard: { ...heardRec, at: '2026-11-20T12:00:00.000Z' } }, NOW), /^3\.71 V, 7 days? ago, heard by DEMO-Observer$/, 'old, and said so');
  assert.equal(batteryWords(ctx, {}, NOW), '');
  assert.equal(heardWords(ctx, { fleet }, NOW), '');
  assert.match(batteryWords(ctxOf('sv', sv), d, NOW), /^3\.71 V, för 9 tim\.? sedan, hörd av DEMO-Observer$/);
  assert.match(heardWords(ctxOf('sv', sv), d, NOW), /^hörd av DEMO-Observer för 9 tim\.? sedan$/);
  for (const strings of [en, sv]) {
    for (const k of ['battery.heardBy', 'battery.fromBeacon', 'heard.byAgo', 'heard.tip', 'heard.atRead', 'alive.heard']) {
      assert.ok(strings[k] && !/—|–|seed/i.test(strings[k]), k);
    }
  }
});

// -- the demo --------------------------------------------------------------------------------

test('the demo: an Observer node publishes a real sealed heard entry, and discovery adds the node with its battery', async () => {
  newSession();
  const world = demoWorld();
  const [a] = world.announced;
  assert.match(a.name, /^DEMO-/);
  assert.ok(!world.nodes.some((n) => n.key === a.key), 'not in the list at the start');
  const plane = demoPlane(world, { rules, delay: () => 0 });
  const by = world.nodes.find((n) => n.name === a.by);
  assert.ok(plane.broker.retained.has(mcc3.heardTopic(by.key, 0)));
  const stores = openStores(memoryDb(), world.owner.key);
  await seedDemo(stores, world, { results: data('results') });
  const demoOwner = keyFromSeed(fromHex(world.owner.seedHex));
  let secrets = {};
  const jobs = createJobs({
    ring: { handle: () => demoOwner, hold: () => () => {}, touch() {}, loadSecrets: async () => ({ ...secrets }), saveSecrets: async (m) => { secrets = { ...m }; } },
    stores, rules, brokers: data('brokers'), results: data('results'), connect: (o) => createMqttClient({ ...o, WebSocket: plane.broker.WebSocket }), waitSecs: 1, sleep: async () => {},
  });
  const found = await jobs.discoverAlive({ waitSecs: 0.3 });
  const e = found.find((x) => x.key === a.key);
  assert.equal(e.state, 'heard');
  assert.equal(e.name, a.name);
  assert.equal(e.heard.batteryMv, a.mv);
  assert.equal(e.heard.byName, a.by);
  const d = await jobs.adopt({ node: e.key, key: e.key, region: '', name: e.name, heard: e.heard });
  assert.equal(d.meshOnly, true);
  assert.deepEqual(needsAttention([d], { now: Date.now(), hours: 2, thresholdMv: 3500, rules }), [], 'mesh only: never "not heard"');
  // it answers over the mesh through the demo's relay, as any node without Wi-Fi there
  assert.ok(plane.nodes.has(a.key));
});
