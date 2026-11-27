// The shared node store and relaying through anyone's Observer (lou-21, L21-G9). A node without
// Wi-Fi signs its announce; any lou-21 Observer hands it to the command server, which keeps one
// entry per node, retained on `mcc/node/<KEY>`. Here: the bytes (the first 101 still pinned by the
// firmware's malive-vectors.json, the signature, the entry and the guest forward by vectors of
// this file with fixed keys, which mccontrol-cli's test_node_store.py pins the same), the
// discovery against the in-memory broker (tag, signature, seal, the tried cache, a node removed
// stays out), the relay choice and a guest forward through a stranger's relay, what the screens
// say, and the demo. Nothing reaches a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mcc3 from '../lib/protocol/mcc3.js';
import { newSession, openNodeWith } from '../lib/protocol/plane.js';
import { keyFromSeed } from '../lib/key/handle.js';
import { fromHex, toHex } from '../lib/bytes.js';
import { b64url, unb64url } from '../lib/protocol/text.js';
import { memoryDb } from '../lib/store/db.js';
import { openStores } from '../lib/store/index.js';
import { rulesFrom } from '../lib/protocol/rules.js';
import { TRIED, createJobs } from '../lib/jobs/jobs.js';
import { autoRelay, DEMOTE_AFTER, rankCatchers, relayCandidates, relayMisses, routesFor } from '../lib/jobs/relay.js';
import { ANNOUNCE_SILENT_HOURS, batteryReading, lastHeard, needsAttention } from '../lib/jobs/overview.js';
import { createDiscovery, keepOut } from '../lib/discovery/index.js';
import { demoPlane } from '../lib/demo/nodes.js';
import { demoWorld, seedDemo } from '../lib/demo/world.js';
import { demoBeacon } from '../lib/demo/beacon-world.js';
import { createMqttClient } from '../lib/protocol/mqtt-client.js';
import { data } from './protocol-helpers.js';
import { aliveFields, connectVia, mcc3Broker } from './mcc3-fakes.js';

const V = JSON.parse(readFileSync(new URL('./malive-vectors.json', import.meta.url), 'utf8'));
const C = V.constants;
const SEEDS = V.keys.seeds;
const PUB = V.keys.public;
const handleOf = (name) => keyFromSeed(fromHex(SEEDS[name]));
const owner = handleOf('owner');
const nodeHandle = handleOf('node');
const OWNER = PUB.owner;
const NODE = PUB.node;
const CATCHER = PUB.catcher;
const STRANGER = PUB.other_owner;          // as an Observer key: someone else's node
const K_MALIVE = mcc3.maliveKey(owner.sharedSecret(NODE), NODE);
const [A1] = V.announces;

// The vectors of this file: the malive vectors' keys and A1, signed by the node; an entry with two
// catchers; a guest forward with a fixed nonce. mccontrol-cli's tests/test_node_store.py holds the
// same hex. X.signed is also the firmware's A1 in planning/firmware/malive-vectors-20261127.json (lou-21,
// regenerated with the signature), cross-checked 2026-11-28.
const X = Object.freeze({
  signed: '4F4FD099CCD47D7893DFE9EC24414ECB0D9B5420232AAD30D91C465BE33CBE65C44D86B8A37F07000000010000000A8929E75030C7B61C72ED92FCFF1F24B473C950D0EA2478D42A8694CAF611F3F9C313EE64D67BACA1BD1D6715D3F7C52A87DDAC809D1BB633F252A657F66CD04673BB52C57EFD4A45468AA2F07553551EF5FA7AA1F202AD9CC579CFE313B6A8C03C42AD04EFBF883AE666CD16D6B2E2D4E35005760F0F',
  catchers: [{ key: CATCHER, arrival: 1795000050, snr: -22, hops: 2, via: 2, list: 0 }, { key: STRANGER, arrival: 1794990000, snr: 30, hops: 0, via: 0, list: 1 }],
  entry: 'Tk_QmczUfXiT3-nsJEFOyw2bVCAjKq0w2RxGW-M8vmXETYa4o38HAAAAAQAAAAqJKedQMMe2HHLtkvz_HyS0c8lQ0OokeNQqhpTK9hHz-cMT7mTWe6yhvR1nFdP3xSqH3ayAnRu2M_JSplf2bNBGc7tSxX79SkVGiqLwdVNVHvX6eqHyAq2cxXnP4xO2qMA8Qq0E77-IOuZmzRbWsuLU41AFdg8PAt3jvM7H86ZqERX0XXIPTcE1w658TiLco4_bHv1qSV_48ob9auoCAgBsKP0FjBjIjGzOKvmB0tEchRsSPtW2m3h2dz7Qmeo_g7Bf_WoeAAAB',
  k_gfwd: 'C306F53A7AC15E4105877C80832976DF24E67091D441A12B3519D961A0D694AA',
  guest: 'R-1UpZ-xrDpRI5NRNilBuGjoWmDj17JIXYKIIdx6acJ5YGFiY2RlZmdoaWpr6t0Bm7q0wLyu6JLJUgTQkPKP6iwCQVF33h3LdkobpZXPHp6RlMGdC_DaEYMimXedD_ScJrful4r0b8upyXm5o7efqwI6X2qLWeNW87YdKxW2_2jBCEmjXZuNvMtNUwYo32zivIqRYxNuAP5FxdXBFVKW62GDI6dbD32cu_K4xruKraVUKHzSudBLhDdk0A0R8_oLSmqMqCXh5Db-T9cVabd6knAEu_uxUM6U3dmsKVkE20jqWkYfull-MH4SHw6pUyaEdllqJRT_-RB5nAvSxtgrgi_9iAruGuaBnQRqzVzI7u2ca_4PL4EQ4qkx6n97YKXsm4EEydFusYUZ1DvkXiUiJ6d_oXqZ',
  guestNonce: '606162636465666768696A6B', rid: '00112233445566778899AABBCCDDEEFF',
});
const guestBody = () => { const b = new Uint8Array(132); b[0] = 0xc2; b.fill(7, 1); return b; };

// A signed announce of the vector node with other fields, sealed to `to` (default the owner).
function announceOf(over = {}, { by = nodeHandle, to = OWNER, key = null } = {}) {
  const f = { ...A1.fields, ...over };
  const k = key || mcc3.maliveKey(by.sharedSecret(to), by.publicKeyHex);
  return mcc3.signAnnounce(by, mcc3.sealAnnounce(k, to, by.publicKeyHex, f));
}
const entryOf = (announce, catchers = X.catchers) => mcc3.sealNodeEntry(announce, catchers);

// -- the bytes -------------------------------------------------------------------------------

test('the first 101 bytes are still the firmware vectors, and the constants hold', () => {
  assert.deepEqual([mcc3.KIND_ANNOUNCE, mcc3.ANNOUNCE_BODY, mcc3.ANNOUNCE_SEALED, mcc3.ANNOUNCE_TAG, mcc3.ANNOUNCE_MAX.version, mcc3.ANNOUNCE_MAX.name],
    [C.kind, C.payload_bytes, C.sealed_bytes, C.tag_bytes, C.max_version, C.max_name]);
  assert.deepEqual([mcc3.INFO_MALIVE, mcc3.OWN_LABEL], [C.label_malive, C.label_owner_tag]);
  assert.deepEqual([mcc3.ANNOUNCE_SIZE, mcc3.ANN_LABEL, mcc3.KIND_NODE, mcc3.NODE_CATCHER_SIZE, mcc3.NODE_FILTER], [165, 'mcc3/ann|', 0x4e, 40, 'mcc/node/+']);
  assert.equal(toHex(K_MALIVE, true), V.keys.k_malive_node);
  for (const a of V.announces) {
    const raw = mcc3.sealAnnounce(mcc3.maliveKey(owner.sharedSecret(PUB[a.node]), PUB[a.node]), OWNER, PUB[a.node], a.fields);
    assert.equal(toHex(raw, true), a.payload, a.name);
    const { node_key: key, ...opened } = mcc3.openAnnounceBody(mcc3.maliveKey(owner.sharedSecret(PUB[a.node]), PUB[a.node]), OWNER, raw);
    assert.equal(key, PUB[a.node]);
    assert.deepEqual(opened, a.opened);
  }
  for (const r of V.refusals) {
    assert.throws(() => mcc3.openAnnounceBody(K_MALIVE, OWNER, fromHex(r.input)), (e) => e instanceof mcc3.Refused && e.outcome === r.outcome, r.name);
  }
});

test('the signed announce: 165 bytes, the node\'s Ed25519 over "mcc3/ann|" and bytes 1..100, pinned', () => {
  const signed = mcc3.signAnnounce(nodeHandle, fromHex(A1.payload));
  assert.equal(signed.length, 165);
  assert.equal(toHex(signed, true), X.signed);
  assert.equal(toHex(signed.subarray(0, 101), true), A1.payload, 'the first 101 bytes as built in X07');
  assert.ok(mcc3.announceSignatureOk(signed));
  assert.ok(mcc3.announceIsFor(OWNER, signed));
  assert.ok(!mcc3.announceIsFor(STRANGER, signed));
  const { node_key: key, ...opened } = mcc3.openAnnounce(K_MALIVE, OWNER, signed);
  assert.equal(key, NODE);
  assert.deepEqual(opened, A1.opened);
  assert.throws(() => mcc3.signAnnounce(handleOf('catcher'), fromHex(A1.payload)), /signed by the node it names/);
});

test('the checks run in the note\'s order: size and kind, owner tag, signature, seal', () => {
  const signed = fromHex(X.signed);
  const refused = (raw, key = K_MALIVE, cmd = OWNER) => {
    try { mcc3.openAnnounce(key, cmd, raw); return null; } catch (e) { return e.outcome; }
  };
  assert.equal(refused(signed.subarray(0, 101)), 'not-announce', 'the unsigned announce of X07 is no longer taken');
  assert.equal(refused(signed, K_MALIVE, STRANGER), 'other-owner');
  for (const at of [1, 40, 50, 100, 101, 164]) {
    const bent = Uint8Array.from(signed);
    bent[at] ^= 1;
    if (at === 1) assert.equal(refused(bent), 'other-owner', 'the node key is inside the tag');
    else if (at === 40) assert.equal(refused(bent), 'other-owner', 'boot is inside the tag');
    else assert.equal(refused(bent), 'bad-signature', `byte ${at}`);
  }
  // a valid signature by another key over the same bytes: the key named is the node's, so it fails
  const forged = Uint8Array.from(signed);
  forged.set(handleOf('catcher').sign(fromHex(toHex(new TextEncoder().encode('mcc3/ann|'), true) + X.signed.slice(2, 202))), 101);
  assert.equal(refused(forged), 'bad-signature');
  // signed right but sealed under another key: the seal is the last check
  const wrongSeal = announceOf({}, { key: new Uint8Array(32) });
  assert.ok(mcc3.announceSignatureOk(wrongSeal));
  assert.equal(refused(wrongSeal), 'does-not-open');
});

test('the node entry: kind N, the announce from byte 1, the catchers of 40 bytes each, pinned', () => {
  assert.equal(entryOf(fromHex(X.signed)), X.entry);
  const raw = unb64url(X.entry);
  assert.equal(raw.length, 166 + 2 * 40);
  const e = mcc3.openNodeEntry(X.entry);
  assert.equal(e.node_key, NODE);
  assert.deepEqual([e.boot, e.sequence, e.report], [7, 1, X.signed.slice(202, 210)]);
  assert.equal(toHex(e.announce, true), X.signed);
  assert.deepEqual(e.catchers, X.catchers);
  assert.equal(mcc3.nodeTopic(NODE), `mcc/node/${NODE}`);
  assert.equal(mcc3.nodeEntryKey(`mcc/node/${NODE}`), NODE);
  for (const t of [`mcc/node/${NODE.toLowerCase()}`, `mcc/node/${NODE}/0`, 'mcc/node/ABCD', `mcc/alive/${NODE}`]) assert.equal(mcc3.nodeEntryKey(t), null, t);
  for (const bad of [b64url(raw.subarray(0, raw.length - 1)), b64url(Uint8Array.of(0x41, ...raw.subarray(1))), 'not base64 !', b64url(raw.subarray(0, 100))]) {
    assert.throws(() => mcc3.openNodeEntry(bad), (x) => x.outcome === 'bad-fields');
  }
  assert.deepEqual(mcc3.openNodeEntry(entryOf(fromHex(X.signed), [])).catchers, []);
});

test('the guest forward: K_gfwd the same from either side, kind G with the guest key in clear, pinned', () => {
  const relay = handleOf('catcher');
  const keys = mcc3.guestKeys(owner.sharedSecret(CATCHER), CATCHER);
  assert.equal(toHex(keys.fwd, true), X.k_gfwd);
  assert.equal(toHex(mcc3.guestKeys(relay.sharedSecret(OWNER), CATCHER).fwd, true), X.k_gfwd);
  assert.notEqual(toHex(keys.fwd, true), toHex(mcc3.ownerKeys(owner, CATCHER).fwd, true), 'not the owner\'s K_fwd');
  const g = mcc3.sealGuestForward(keys, OWNER, CATCHER, 1795000100, 1795000250, fromHex(X.rid), NODE, 0, guestBody(), { nonce: fromHex(X.guestNonce) });
  assert.equal(g, X.guest);
  const raw = unb64url(g);
  assert.equal(raw.length, mcc3.GUEST_FORWARD_SIZE);
  assert.deepEqual([raw[0], toHex(raw.subarray(1, 33), true)], [0x47, OWNER]);
  const o = mcc3.openGuestForward(relay, g);
  assert.deepEqual([o.guest, o.counter, o.expiry, toHex(o.rid, true), o.target, o.route, o.body.length], [OWNER, 1795000100, 1795000250, X.rid, NODE, 0, 132]);
  for (const at of [0, 1, 40, 50, raw.length - 1]) {
    const bent = Uint8Array.from(raw);
    bent[at] ^= 1;
    assert.throws(() => mcc3.openGuestForward(relay, b64url(bent)), mcc3.Refused, `byte ${at}`);
  }
  assert.throws(() => mcc3.openForward(relay, OWNER, g), mcc3.Refused, 'not an owner\'s forward');
  // the result under K_gfwd opens with the guest's keys only
  const res = mcc3.sealForwardResult(o.keys, o.counter, 10, 1795000101);
  assert.equal(mcc3.openForwardResult(keys, res).name, 'guest-cap');
  assert.throws(() => mcc3.openForwardResult(mcc3.ownerKeys(owner, CATCHER), res), mcc3.Refused);
  assert.deepEqual(mcc3.FORWARD_STATUSES.slice(10), ['guest-cap', 'guests-full', 'target-cap']);
});

test('openNodeWith: another owner\'s entry costs no key agreement; a forged one or one under another topic is null', () => {
  const secrets = {};
  const theirs = entryOf(announceOf({}, { to: STRANGER }));
  assert.equal(openNodeWith(owner, secrets, NODE, theirs), null);
  assert.equal(secrets[NODE], undefined, 'stopped at the owner tag');
  const raw = unb64url(X.entry);
  const bent = Uint8Array.from(raw);
  bent[120] ^= 1;                                   // inside the signed part
  assert.equal(openNodeWith(owner, secrets, NODE, b64url(bent)), null);
  assert.equal(secrets[NODE], undefined, 'stopped at the signature');
  assert.equal(openNodeWith(owner, secrets, CATCHER, X.entry), null, 'the topic names another key');
  const ok = openNodeWith(owner, secrets, NODE, X.entry);
  assert.deepEqual([ok.node_key, ok.battery_mv, ok.name, ok.catchers.length], [NODE, 3987, A1.fields.name, 2]);
  assert.ok(secrets[NODE]);
  const moved = Uint8Array.from(raw);
  moved[raw.length - 3] = 9;                         // a catcher's hops: in clear, not signed
  assert.equal(openNodeWith(owner, {}, NODE, b64url(moved)).catchers[1].hops, 9);
});

// -- the discovery ---------------------------------------------------------------------------

const rules = rulesFrom(Object.fromEntries(['brokers', 'cautions', 'commands', 'denylist', 'facts', 'firmware', 'results'].map((n) => [n, data(n)])));
const OBSERVER21 = 'v1.18.0-lou-21-arrc-observer-0';
const catcherAlive = () => mcc3.sealAlive(mcc3.ownerKeys(owner, CATCHER), aliveFields({ name: 'DEMO-Observer' }));

async function setup(retained, devices = [], { names = {}, relays = [] } = {}) {
  newSession();
  const stores = openStores(memoryDb(), 'C'.repeat(64));
  for (const d of devices) {
    const { set, ...add } = d;
    await stores.devices.add(add);
    if (set) await stores.devices.update(add.node.slice(0, 8), set);
  }
  const broker = mcc3Broker({ retained, relays });
  let secrets = {};
  const asked = [];
  const jobs = createJobs({
    ring: { handle: () => owner, hold: () => () => {}, touch() {}, loadSecrets: async () => ({ ...secrets }), saveSecrets: async (m) => { secrets = { ...m }; } },
    stores, rules, brokers: data('brokers'), results: data('results'), connect: connectVia(broker), waitSecs: 1, sleep: async () => {},
    observerName: async (key) => { asked.push(key); return names[key] ?? null; },
  });
  return { stores, jobs, broker, secrets: () => secrets, asked };
}

test('a node in the store is found, named, heard by its best catcher, and adopted as a node without Wi-Fi; nothing sent', async () => {
  const { jobs, broker, stores, asked } = await setup({ [mcc3.aliveTopic(CATCHER)]: catcherAlive(), [mcc3.nodeTopic(NODE)]: X.entry },
    [], { names: { [STRANGER]: 'DEMO-Grannen' } });
  const found = await jobs.discoverAlive({ waitSecs: 0.4 });
  assert.deepEqual(found.map((e) => [e.key, e.state]).sort(), [[CATCHER, 'online'], [NODE, 'heard']].sort());
  const e = found.find((x) => x.key === NODE);
  assert.deepEqual([e.name, e.version, e.knownAs, e.heard.batteryMv], [A1.opened.name, A1.opened.version, null, 3987]);
  // the current announce's only catcher: CATCHER, two hops; the previous list's stranger is kept too
  assert.deepEqual([e.heard.by, e.heard.byKey, e.heard.snr, e.heard.hops, e.heard.via], [CATCHER.slice(0, 8), CATCHER, -5.5, 2, 2]);
  assert.equal(e.heard.at, new Date(1795000050 * 1000).toISOString());
  assert.deepEqual(e.catchers.map((c) => [c.node, c.name, c.snr, c.hops, c.via, c.list]),
    [[CATCHER.slice(0, 8), '', -5.5, 2, 2, 0], [STRANGER.slice(0, 8), 'DEMO-Grannen', 7.5, 0, 0, 1]]);
  assert.deepEqual(asked.sort(), [CATCHER, STRANGER].sort(), 'Beacon asked for the Observers not in the list');
  assert.equal(broker.received.filter((p) => p.type === 'publish').length, 0, 'a read: nothing sent');
  assert.ok(broker.received.some((p) => p.type === 'subscribe' && p.topics.some((t) => t.topic === mcc3.NODE_FILTER)));
  assert.ok(!broker.received.some((p) => p.type === 'subscribe' && p.topics.some((t) => t.topic.startsWith('mcc/heard/'))), 'mcc/heard is no longer read');
  const d = await jobs.adopt({ node: e.key, key: e.key, region: '', name: e.name, heard: e.heard, catchers: e.catchers });
  assert.deepEqual([d.key, d.meshOnly, d.ver, d.heard.batteryMv, d.catchers.length], [NODE, true, 'lou-21-arrc', 3987, 2]);
  assert.equal(rules.deviceMeshOnly(d), true);
});

test('with no store (lou-20 and a command server without it) everything is as before', async () => {
  const { jobs, stores } = await setup({ [mcc3.aliveTopic(CATCHER)]: catcherAlive() });
  const found = await jobs.discoverAlive({ waitSecs: 0.4 });
  assert.deepEqual(found.map((e) => [e.key, e.state]), [[CATCHER, 'online']]);
  assert.deepEqual(await stores.devices.list(), []);
});

test('another owner\'s entries and forged ones never reach the list, and cost no key agreement', async () => {
  const other = handleOf('catcher');
  const raw = unb64url(X.entry);
  const bent = Uint8Array.from(raw);
  bent[60] ^= 1;
  const { jobs, stores, secrets } = await setup({
    [mcc3.nodeTopic(other.publicKeyHex)]: entryOf(announceOf({}, { by: other, to: STRANGER })),     // someone else's
    [mcc3.nodeTopic(NODE)]: b64url(bent),                                                           // altered
    [mcc3.nodeTopic(STRANGER)]: X.entry,                                                            // under another key's topic
  }, [{ node: NODE, key: NODE, region: '', name: 'cabin' }]);
  assert.deepEqual(await jobs.discoverAlive({ waitSecs: 0.4 }), []);
  assert.equal((await stores.devices.get(NODE.slice(0, 8))).heard, undefined);
  assert.equal(secrets()[other.publicKeyHex], undefined);
  assert.equal(secrets()[NODE], undefined);
});

test('each entry is tried once per (boot, sequence): later scans open only what is new; yours get their catchers again', async () => {
  const s = await setup({ [mcc3.nodeTopic(NODE)]: X.entry, [mcc3.nodeTopic(CATCHER)]: entryOf(announceOf({}, { by: handleOf('catcher'), to: STRANGER })) },
    [{ node: NODE, key: NODE, region: '', name: 'cabin' }]);
  await s.jobs.discoverAlive({ waitSecs: 0.3 });
  const tried = await s.stores.meta.get(TRIED);
  assert.deepEqual(tried, { [NODE]: `7.1.${X.signed.slice(202, 210)}!`, [CATCHER]: tried[CATCHER] });
  assert.match(tried[CATCHER], /^7\.1\.[0-9A-F]{8}$/, 'not yours: no mark');
  // The same announce again with a seal that no longer opens and a new catcher: it is not opened
  // again (it would fail), and the catchers, in clear, are taken.
  const signed = fromHex(X.signed);
  const unopenable = Uint8Array.from(signed);
  unopenable[60] ^= 1;                               // breaks the signature and the seal; the stamp is the same
  const again = entryOf(unopenable, [{ key: STRANGER, arrival: 1795000400, snr: 12, hops: 0, via: 0, list: 0 }]);
  const broker = mcc3Broker({ retained: { [mcc3.nodeTopic(NODE)]: again } });
  const jobs = createJobs({ ring: { handle: () => owner, hold: () => () => {}, touch() {} }, stores: s.stores, rules, brokers: data('brokers'),
    results: data('results'), connect: connectVia(broker), waitSecs: 1, sleep: async () => {} });
  const found = await jobs.discoverAlive({ waitSecs: 0.3 });
  assert.deepEqual(found.map((e) => [e.key, e.knownAs]), [[NODE, 'cabin']]);
  const d = await s.stores.devices.get(NODE.slice(0, 8));
  assert.deepEqual(d.catchers.map((c) => [c.key, c.hops]), [[STRANGER, 0]]);
  assert.deepEqual([d.heard.by, d.heard.hops, d.heard.batteryMv], [STRANGER.slice(0, 8), 0, 3987], 'who heard it moves; what it said stays');
  // a new (boot, sequence) is tried again
  const newer = entryOf(announceOf({ sequence: 2, battery_mv: 3801 }));
  const b2 = mcc3Broker({ retained: { [mcc3.nodeTopic(NODE)]: newer } });
  const j2 = createJobs({ ring: { handle: () => owner, hold: () => () => {}, touch() {} }, stores: s.stores, rules, brokers: data('brokers'),
    results: data('results'), connect: connectVia(b2), waitSecs: 1, sleep: async () => {} });
  await j2.discoverAlive({ waitSecs: 0.3 });
  assert.deepEqual([(await s.stores.devices.get(NODE.slice(0, 8))).heard.sequence, (await s.stores.devices.get(NODE.slice(0, 8))).heard.batteryMv], [2, 3801]);
});

test('the tried cache spares the owner tag test of every entry already tried', async () => {
  const other = handleOf('catcher');
  const retained = {};
  for (let i = 0; i < 20; i += 1) {
    const h = keyFromSeed(fromHex(toHex(new Uint8Array(32).fill(i + 1), true)));
    retained[mcc3.nodeTopic(h.publicKeyHex)] = entryOf(announceOf({}, { by: h, to: other.publicKeyHex }));
  }
  const stores = openStores(memoryDb(), 'C'.repeat(64));
  let reads = 0;
  const counted = new Proxy(owner, { get(t, p) { if (p === 'publicKeyHex') reads += 1; return Reflect.get(t, p); } });
  const scan = async () => {
    newSession();
    reads = 0;
    const jobs = createJobs({ ring: { handle: () => counted, hold: () => () => {}, touch() {} }, stores, rules, brokers: data('brokers'),
      results: data('results'), connect: connectVia(mcc3Broker({ retained })), waitSecs: 1, sleep: async () => {} });
    await jobs.discoverAlive({ waitSecs: 0.3 });
    return reads;
  };
  const first = await scan();
  assert.equal(Object.keys(await stores.meta.get(TRIED)).length, 20);
  const second = await scan();
  assert.ok(first - second >= 20, `${first} then ${second}`);
});

test('the newest announce is kept on a node you have; a name you typed stays; an older one changes nothing', async () => {
  const { jobs, stores } = await setup({ [mcc3.nodeTopic(NODE)]: entryOf(announceOf({ sequence: 2 })) }, [{ node: NODE, key: NODE, region: '', name: 'cabin' }]);
  await jobs.discoverAlive({ waitSecs: 0.3 });
  const d = await stores.devices.get(NODE.slice(0, 8));
  assert.deepEqual([d.name, d.meshOnly, d.heard.sequence], ['cabin', true, 2]);
  const later = await setup({ [mcc3.nodeTopic(NODE)]: X.entry }, [{ node: NODE, key: NODE, region: '', name: 'cabin', set: { heard: d.heard } }]);
  await later.jobs.discoverAlive({ waitSecs: 0.3 });
  assert.equal((await later.stores.devices.get(NODE.slice(0, 8))).heard.sequence, 2);
});

test('a node you remove stays out on this device; its entry stays in the store', async () => {
  const clock = { now: () => Date.now(), setTimeout: () => 0, clearTimeout() {} };
  const s = await setup({ [mcc3.nodeTopic(NODE)]: X.entry });
  const disc = createDiscovery({ stores: s.stores, jobs: s.jobs, rules, clock });
  const first = await disc.run({ force: true });
  assert.deepEqual(first.added.map((a) => a.node), [NODE.slice(0, 8)]);
  await keepOut(s.stores, NODE.slice(0, 8));
  await s.stores.devices.remove(NODE.slice(0, 8));
  const second = await disc.run({ force: true });
  assert.deepEqual([second.added, second.ignored], [[], 1]);
  assert.equal(await s.stores.devices.get(NODE.slice(0, 8)), undefined);
});

// -- the relay choice --------------------------------------------------------------------------

const k = (c) => c.repeat(64);
const row = (key, over = {}) => ({ key, node: key.slice(0, 8), name: '', at: '2026-11-27T10:00:00.000Z', snr: 0, hops: 1, via: 2, list: 0, ...over });
const aliveNow = () => ({ state: 'online', at: new Date(Date.now() - 60000).toISOString(), flags: 0x1b, relay: true, version: OBSERVER21, interval: 900 });

test('relay choice: your own Observer if it caught the node, else the fewest hops (zero-hop is 0), then the best SNR; demoted last', () => {
  const mine = { node: k('A').slice(0, 8), key: k('A'), name: 'mine', ver: OBSERVER21, alive: aliveNow() };
  const target = { node: NODE.slice(0, 8), key: NODE, meshOnly: true,
    catchers: [row(k('B'), { hops: 3, snr: 9 }), row(k('C'), { hops: 1, snr: -2 }), row(k('D'), { hops: 1, snr: 4 }), row(k('E'), { hops: 2, via: 0, snr: -9 }), row(k('A'), { hops: 4, snr: -10 })] };
  assert.deepEqual(rankCatchers(target, [mine]).map((c) => c.key[0]), ['A', 'E', 'D', 'C', 'B'], 'E came by a zero-hop state packet');
  const list = relayCandidates(rules, [mine], target);
  assert.deepEqual(list.map((c) => [c.device.node[0], c.guest]), [['A', false], ['E', true], ['D', true], ['C', true], ['B', true]]);
  assert.deepEqual([list[1].hears, list[1].snr], [true, -9], 'a zero-hop catcher hears the node directly');
  assert.deepEqual(routesFor(list[1])[0], 'neighbour');
  assert.deepEqual(routesFor(list[2])[0], 'flood', 'over hops: a zero-hop send is not the first offered');
  assert.deepEqual(autoRelay(rules, [mine], target), { relay: list[1].device, route: 'neighbour' }, 'auto: the one that hears it directly');
  // two in a row without an answer demote that relay for this node
  let misses = relayMisses(target, 'EEEEEEEE', 'no-answer');
  misses = relayMisses({ relayMisses: misses }, 'EEEEEEEE', null);
  assert.equal(misses.EEEEEEEE, DEMOTE_AFTER);
  const down = relayCandidates(rules, [mine], { ...target, relayMisses: misses });
  assert.deepEqual(down.map((c) => c.device.node[0]), ['A', 'D', 'C', 'B', 'E']);
  assert.equal(down.at(-1).demoted, true);
  assert.equal(autoRelay(rules, [mine], { ...target, relayMisses: misses }), null, 'auto never takes a demoted relay (and never floods)');
  assert.deepEqual(relayMisses({ relayMisses: misses }, 'EEEEEEEE', 'answered'), {}, 'an answer clears it');
  assert.deepEqual(relayMisses({ relayMisses: { X: 1 } }, 'X', 'busy'), { X: 1 }, 'a refusal sent nothing: no evidence');
  // with no catchers (lou-20) the list is as before
  assert.deepEqual(relayCandidates(rules, [mine], { node: 'T', key: NODE }).map((c) => c.device.node), [mine.node]);
});

test('a guest forward through a stranger\'s Observer: sealed under K_gfwd with your key in clear, answered, kept; refusals in words', async () => {
  const stranger = handleOf('catcher');
  const fakeRelay = { handle: stranger, commandKey: STRANGER, guests: true, snr: 20,
    targets: [{ handle: nodeHandle, answer: (c) => ({ code: 0, reply: `> ${c}` }) }] };
  const target = { node: NODE, key: NODE, region: '', name: 'cabin',
    set: { ver: 'nrf52-v1.18.0-lou-21-rc-0', meshOnly: true, catchers: [row(CATCHER, { name: 'DEMO-Grannen', hops: 0, via: 0, snr: 5 })] } };
  const s = await setup({}, [target], { relays: [fakeRelay] });
  const out = await s.jobs.send({ command: 'get name', nodes: [NODE.slice(0, 8)], road: 'relay', relay: { node: CATCHER.slice(0, 8), route: 'neighbour' } });
  const o = out.outcomes[0];
  assert.equal(o.result?.reply, '> get name');
  assert.deepEqual([o.info.relay, o.info.relayName, o.info.guest, o.info.status], [CATCHER.slice(0, 8), 'DEMO-Grannen', true, 'answered']);
  const sent = s.broker.received.filter((p) => p.type === 'publish');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].topic, mcc3.commandTopic(CATCHER));
  const raw = unb64url(new TextDecoder().decode(sent[0].payload));
  assert.deepEqual([raw[0], toHex(raw.subarray(1, 33), true)], [0x47, OWNER]);
  const counter = (await s.stores.meta.get('relay.guest'))[CATCHER];
  assert.ok(counter >= Math.floor(Date.now() / 1000) - 5);
  const ev = (await s.stores.history.list({ node: NODE.slice(0, 8) }))[0];
  assert.deepEqual([ev.road, ev.relay.node, ev.relay.status], ['relay', CATCHER.slice(0, 8), 'answered']);
  assert.equal((await s.stores.devices.get(NODE.slice(0, 8))).relayMisses, undefined);
  // the guest refusals, each sent nothing
  const { explainEvent } = await import('../ui/screens/node-kit.js');
  const en = JSON.parse(readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
  const sv = JSON.parse(readFileSync(new URL('../i18n/sv.json', import.meta.url), 'utf8'));
  for (const [status, name] of [[10, 'guest-cap'], [11, 'guests-full'], [12, 'target-cap']]) {
    fakeRelay.guestStatus = status;
    const r = (await s.jobs.send({ command: 'get name', nodes: [NODE.slice(0, 8)], road: 'relay', relay: { node: CATCHER.slice(0, 8), route: 'neighbour' } })).outcomes[0];
    assert.equal(r.info.status, name);
    assert.equal(r.result, null);
    const e = (await s.stores.history.list({ node: NODE.slice(0, 8) }))[0];
    for (const [lang, strings] of [['en', en], ['sv', sv]]) {
      const ctx = { lang, t: (key, vars = {}) => String(strings[key] ?? key).replace(/\{(\w+)\}/g, (_, n) => vars[n] ?? '') };
      const svc = { data: { results: data('results') }, rules };
      const said = explainEvent(ctx, svc, e);
      assert.equal(said.help, strings[`road.guestRefused.${name}`], `${lang} ${name}`);
      assert.ok(said.help && !/—|–/.test(said.help));
    }
  }
  assert.equal((await s.stores.devices.get(NODE.slice(0, 8))).relayMisses, undefined, 'a refusal is no miss');
  // two silent relays in a row demote it
  delete fakeRelay.guestStatus;
  fakeRelay.targets = [];
  for (let i = 0; i < 2; i += 1) await s.jobs.send({ command: 'get name', nodes: [NODE.slice(0, 8)], road: 'relay', relay: { node: CATCHER.slice(0, 8), route: 'neighbour' } });
  const d = await s.stores.devices.get(NODE.slice(0, 8));
  assert.equal(d.relayMisses[CATCHER.slice(0, 8)], 2);
  assert.equal(relayCandidates(rules, await s.stores.devices.list(), d)[0].demoted, true);
  // a relay not among the catchers is refused before anything is signed
  await assert.rejects(s.jobs.send({ command: 'get name', nodes: [NODE.slice(0, 8)], road: 'relay', relay: { node: 'ABCDEF01', route: 'neighbour' } }),
    (e) => e.code === 'relayMissing' || /relayMissing/.test(JSON.stringify(e.outcomes || e)));
});

// -- what the screens show -------------------------------------------------------------------

const NOW = Date.parse('2026-11-27T12:00:00Z');
const heardRec = { at: '2026-11-27T03:00:00.000Z', atRead: false, by: CATCHER.slice(0, 8), byName: 'DEMO-Grannen', snr: 3.25, hops: 0, batteryMv: 3710 };

test('silent after about two days without a newer announce; the battery is the newer reading', () => {
  assert.equal(ANNOUNCE_SILENT_HOURS, 48);
  const opts = { now: NOW, hours: 2, thresholdMv: 3500, rules };
  const d = { node: 'AAAA0001', name: 'DEMO-Stig', meshOnly: true, heard: heardRec };
  assert.deepEqual(needsAttention([d], opts), [], 'nine hours: fine, and never "not heard on MQTT"');
  const quiet = { ...d, heard: { ...heardRec, at: new Date(NOW - 49 * 3600000).toISOString() } };
  assert.deepEqual(needsAttention([quiet], opts).map((r) => [r.kind, r.vars.hours]), [['announceSilent', 49]]);
  assert.equal(lastHeard(d), Date.parse(heardRec.at));
  assert.equal(batteryReading(d).source, 'heard');
  for (const lang of ['en', 'sv']) {
    const strings = JSON.parse(readFileSync(new URL(`../i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const key of ['dash.att.announceSilent', 'road.hears.caught', 'road.guest', 'road.demoted', 'road.demotedShort', 'road.demotedNote',
      'road.guestRefused.guest-cap', 'road.guestRefused.guests-full', 'road.guestRefused.target-cap', 'node.forgetHidden']) {
      assert.ok(strings[key] && !/—|–/.test(strings[key]), `${lang} ${key}`);
    }
  }
});

test('the words: who heard it and when, the battery\'s source', async () => {
  const { batteryWords, heardWords } = await import('../ui/screens/node-kit.js');
  const en = JSON.parse(readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
  const ctx = { lang: 'en', t: (key, vars = {}) => String(en[key] ?? key).replace(/\{(\w+)\}/g, (_, n) => vars[n] ?? '') };
  assert.match(heardWords(ctx, { heard: heardRec }, NOW), /^heard by DEMO-Grannen 9 hr?\.? ago$/);
  assert.match(batteryWords(ctx, { heard: heardRec }, NOW), /^3\.71 V, 9 hr?\.? ago, heard by DEMO-Grannen$/);
  assert.match(heardWords(ctx, { heard: { ...heardRec, byName: '' } }, NOW), new RegExp(`^heard by ${CATCHER.slice(0, 8)} `), 'unnamed: its id');
});

// -- the demo --------------------------------------------------------------------------------

test('the demo: a node found through a stranger\'s Observer in the store, reached through it with a guest forward', async () => {
  newSession();
  const world = demoWorld();
  const [a] = world.announced;
  const [g] = world.strangers;
  assert.match(a.name, /^DEMO-/);
  assert.match(g.name, /^DEMO-/);
  assert.equal(a.by, g.name);
  assert.notEqual(g.owner, world.owner.key, 'not the demo owner\'s');
  assert.ok(!world.nodes.some((n) => n.key === a.key || n.key === g.key), 'neither is in the list at the start');
  assert.equal(demoBeacon(world, `/nodes?pubkeyPrefix=${g.key.slice(0, 16).toLowerCase()}`).items[0].name, g.name);
  const plane = demoPlane(world, { rules, delay: () => 0 });
  assert.ok(plane.broker.retained.has(mcc3.nodeTopic(a.key)));
  assert.ok(![...plane.broker.retained.keys()].some((t) => t.startsWith('mcc/heard/')));
  const stores = openStores(memoryDb(), world.owner.key);
  await seedDemo(stores, world, { results: data('results') });
  const demoOwner = keyFromSeed(fromHex(world.owner.seedHex));
  let secrets = {};
  const jobs = createJobs({
    ring: { handle: () => demoOwner, hold: () => () => {}, touch() {}, loadSecrets: async () => ({ ...secrets }), saveSecrets: async (m) => { secrets = { ...m }; } },
    stores, rules, brokers: data('brokers'), results: data('results'), connect: (o) => createMqttClient({ ...o, WebSocket: plane.broker.WebSocket }),
    waitSecs: 1, sleep: async () => {}, observerName: async (key) => demoBeacon(world, `/nodes?pubkeyPrefix=${key.toLowerCase()}`).items[0]?.name || null,
  });
  const found = await jobs.discoverAlive({ waitSecs: 0.3 });
  const e = found.find((x) => x.key === a.key);
  assert.deepEqual([e.state, e.name, e.heard.batteryMv, e.heard.byName, e.heard.hops], ['heard', a.name, a.mv, g.name, 0]);
  const d = await jobs.adopt({ node: e.key, key: e.key, region: '', name: e.name, heard: e.heard, catchers: e.catchers });
  const pick = relayCandidates(rules, await stores.devices.list(), d)[0];
  assert.deepEqual([pick.device.name, pick.guest, routesFor(pick)[0]], [g.name, true, 'neighbour']);
  assert.deepEqual(autoRelay(rules, await stores.devices.list(), d)?.relay.node, g.node);
  const out = await jobs.send({ command: 'get name', nodes: [d.node], road: 'relay', relay: { node: g.node, route: 'neighbour' } });
  assert.equal(out.outcomes[0].info.status, 'answered');
  assert.equal(out.outcomes[0].result?.verified, true);
});
