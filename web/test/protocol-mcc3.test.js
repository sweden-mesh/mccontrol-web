// lib/protocol/mcc3.js against mccontrol-spec's test/mcc3-vectors.json (the same file the CLI and
// the firmware pin): every command, result, mesh request and response and alive message rebuilt
// byte for byte from its inputs and opened again, every refusal giving its outcome, and every
// command a sender must not build refused before signing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mcc3 from '../lib/protocol/mcc3.js';
import { keyFromSeed } from '../lib/key/handle.js';
import { fromHex, toHex, utf8 } from '../lib/bytes.js';
import { unb64url } from '../lib/protocol/text.js';

const V = JSON.parse(readFileSync(new URL('./mcc3-vectors.json', import.meta.url), 'utf8'));
const SEEDS = V.keys.seeds;
const PUB = V.keys.public;
const owner = keyFromSeed(fromHex(SEEDS.command));
const node = keyFromSeed(fromHex(SEEDS.node));
const NODE = PUB.node;
const CMD_KEY = PUB.command;
const K = mcc3.ownerKeys(owner, NODE);
const hexKeys = (k) => Object.fromEntries(Object.entries(k).map(([n, v]) => [n, toHex(v, true)]));
const fromHexKeys = (k) => Object.fromEntries(Object.entries(k).map(([n, v]) => [n, fromHex(v)]));

test('the keys: public keys, S from both sides, K_cmd, K_mesh, K_alive, K_fwd', () => {
  for (const name of ['command', 'node', 'other_node', 'other_owner']) {
    assert.equal(keyFromSeed(fromHex(SEEDS[name])).publicKeyHex, PUB[name], name);
  }
  assert.equal(toHex(owner.sharedSecret(NODE), true), V.keys.shared_secret);
  assert.equal(toHex(node.sharedSecret(CMD_KEY), true), V.keys.shared_secret_from_node_side);
  assert.deepEqual(hexKeys(K), V.keys.owner);
  assert.deepEqual(hexKeys(mcc3.nodeKeys(node, CMD_KEY)), V.keys.node_side);
  assert.deepEqual(hexKeys(mcc3.ownerKeys(owner, PUB.other_node)), V.keys.other_node);
  assert.deepEqual(hexKeys(mcc3.ownerKeys(keyFromSeed(fromHex(SEEDS.other_owner)), NODE)), V.keys.other_owner);
});

test('the constants are the spec\'s', () => {
  const c = V.constants;
  assert.deepEqual([...mcc3.COMMAND_SIZES], c.command_sizes);
  assert.deepEqual([...mcc3.RESULT_SIZES], c.result_sizes);
  assert.deepEqual([...mcc3.COMMAND_PADS], c.command_pads);
  assert.deepEqual([...mcc3.RESULT_PADS], c.result_pads);
  assert.equal(mcc3.ALIVE_SIZE, c.alive_size);
  assert.equal(mcc3.ALIVE_PLAIN, c.alive_plaintext);
  assert.equal(mcc3.MAX_COMMAND, c.max_command);
  assert.equal(mcc3.MESH_REQUEST_LEN, c.mesh_request);
  assert.equal(mcc3.MESH_COMMAND_FIELD, c.mesh_command_field);
  assert.equal(mcc3.MESH_MAX_COMMAND, c.mesh_max_command);
  assert.equal(mcc3.MESH_MAX_REPLY, c.mesh_max_reply);
  assert.equal(mcc3.MESH_SUBTYPE, c.mesh_subtype);
  assert.deepEqual([...mcc3.MESH_FLAGS], c.mesh_flags);
  assert.equal(mcc3.FLAG_ZERO_HOP, c.flag_zero_hop);
  assert.equal(mcc3.ALIVE_FLAG_RELAY, c.alive_flag_relay);
  assert.deepEqual({ size: mcc3.FORWARD_SIZE, result_size: mcc3.FORWARD_RESULT_SIZE, path: mcc3.FORWARD_PATH,
    body: mcc3.FORWARD_BODY, min_body: mcc3.FORWARD_MIN_BODY, body_subtypes: [mcc3.MESH_V1_SUBTYPE, mcc3.MESH_SUBTYPE], body_subtypes_from: { 'lou-21': [mcc3.MESH_SUBTYPE] },
    result_plaintext: mcc3.FORWARD_RESULT_PLAIN, result_path: mcc3.FORWARD_RESULT_PATH,
    max_response: mcc3.FORWARD_MAX_RESPONSE, routes: { ...mcc3.ROUTES }, statuses: [...mcc3.FORWARD_STATUSES],
    sent: { ...mcc3.SENT }, snr_none: mcc3.SNR_NONE, path_none: mcc3.PATH_NONE, max_ttl_secs: mcc3.FORWARD_MAX_TTL }, c.forward);
  assert.deepEqual({ ...mcc3.KIND }, c.kind);
  assert.deepEqual({ mqtt: mcc3.ROAD_MQTT, mesh: mcc3.ROAD_MESH }, c.road);
  assert.equal(mcc3.SIG_LABEL, c.sig_label);
  assert.equal(mcc3.ALIVE_FILTER, c.topics.alive_filter);
  for (const [name, info] of Object.entries(c.hkdf_info)) assert.equal(`${mcc3.INFO[name]}<KEY>`, info);
});

for (const v of V.commands) {
  test(`command ${v.name}`, () => {
    const rid = fromHex(v.rid);
    const payload = mcc3.sealCommand(owner, NODE, v.counter, v.expiry, rid, v.command, { nonce: v.nonce });
    assert.equal(payload, v.payload);
    assert.equal(unb64url(payload).length, v.bytes);
    assert.equal(toHex(mcc3.signedBytes(NODE, mcc3.ROAD_MQTT, 0, v.counter, v.expiry, rid, utf8(v.command)), true), v.signed);
    assert.equal(mcc3.commandTopic(NODE), v.topic);
    assert.equal(mcc3.replyTopic(rid), v.reply_topic);
    const opened = mcc3.openCommand(node, CMD_KEY, payload);
    assert.deepEqual({ ...opened, rid: toHex(opened.rid, true) }, { counter: v.counter, expiry: v.expiry, rid: v.rid, command: v.command });
    // the signature inside is the vector's
    assert.equal(toHex(owner.sign(fromHex(v.signed)), true), v.signature);
  });
}

for (const v of V.results) {
  test(`result ${v.name}`, () => {
    const payload = mcc3.sealResult(K, v.counter, v.code, v.clock, v.command, v.reply, { nonce: v.nonce });
    assert.equal(payload, v.payload);
    assert.equal(unb64url(payload).length, v.bytes);
    assert.deepEqual(mcc3.openResult(K, payload),
      { counter: v.counter, code: v.code, clock: v.clock, command: v.command, reply: v.reply_opened });
    assert.ok(v.reply.startsWith(v.reply_opened));
  });
}

for (const v of V.mesh_requests) {
  test(`mesh request ${v.name}`, () => {
    const req = mcc3.sealMeshRequest(owner, NODE, v.counter, v.expiry, v.command, { companionTag: v.companion_tag, flags: v.flags });
    assert.equal(toHex(req, true), v.request);
    assert.equal(req.length, mcc3.MESH_REQUEST_LEN);
    assert.equal(toHex(req.subarray(4), true), v.app_sends);
    assert.equal(toHex(mcc3.meshNonce(v.counter), true), v.nonce);
    assert.equal(toHex(mcc3.signedBytes(NODE, mcc3.ROAD_MESH, v.flags, v.counter, v.expiry, null, utf8(v.command)), true), v.signed);
    assert.deepEqual(mcc3.openMeshRequest(node, CMD_KEY, req, { lastCounter: v.counter - 1 }),
      { tag: v.companion_tag, flags: v.flags, counter: v.counter, expiry: v.expiry, command: v.command });
  });
}

for (const v of V.mesh_responses) {
  test(`mesh response ${v.name}`, () => {
    const resp = mcc3.sealMeshResponse(K, v.companion_tag, v.counter, v.code, v.clock, v.reply, { nonce: v.nonce });
    assert.equal(toHex(resp, true), v.response);
    assert.deepEqual(mcc3.openMeshResponse(K, resp),
      { tag: v.companion_tag, counter: v.counter, code: v.code, clock: v.clock, reply: v.reply });
  });
}

// MeshCore hands a datagram over zero-filled to the 16-byte block edge (bench 2026-11-23: a
// 55-byte response arrived as 60), so the opener finds the length by the tag.
test('a mesh response opens with the mesh zero fill after it, an altered one does not', () => {
  const v = V.mesh_responses[0];
  const resp = mcc3.sealMeshResponse(K, v.companion_tag, v.counter, v.code, v.clock, v.reply, { nonce: v.nonce });
  for (let fill = 0; fill < 16; fill++) {
    const filled = new Uint8Array(resp.length + fill);
    filled.set(resp);
    assert.equal(mcc3.openMeshResponse(K, filled).reply, v.reply, `fill ${fill}`);
  }
  const bad = new Uint8Array(resp.length + 5);
  bad.set(resp);
  bad[20] ^= 1;
  assert.throws(() => mcc3.openMeshResponse(K, bad), mcc3.Refused);
});

// The node of the vectors is the relay; its K_fwd seals the forward and its result.
for (const v of V.forwards) {
  test(`forward ${v.name}`, () => {
    const payload = mcc3.sealForward(K, NODE, v.counter, v.expiry, fromHex(v.rid), v.target, v.route, fromHex(v.body),
      { pathLen: v.path_len, path: fromHex(v.path), nonce: v.nonce, pathField: v.path_field ? fromHex(v.path_field) : null });
    assert.equal(payload, v.payload);
    assert.equal(unb64url(payload).length, v.bytes);
    assert.equal(mcc3.commandTopic(NODE), v.topic);
    assert.equal(mcc3.replyTopic(fromHex(v.rid)), v.reply_topic);
    const o = mcc3.openForward(node, CMD_KEY, payload);
    assert.deepEqual({ counter: o.counter, expiry: o.expiry, rid: toHex(o.rid, true), target: o.target, route: o.route,
      path_len: o.pathLen, path: toHex(o.path, true), body: toHex(o.body, true) }, v.opened);
  });
}

for (const v of V.forward_results) {
  test(`forward result ${v.name}`, () => {
    const payload = mcc3.sealForwardResult(K, v.counter, v.status, v.clock,
      { sent: v.sent, snr: v.snr, pathLen: v.path_len, path: fromHex(v.path), response: fromHex(v.response), nonce: v.nonce });
    assert.equal(payload, v.payload);
    assert.equal(unb64url(payload).length, v.bytes);
    const o = mcc3.openForwardResult(K, payload);
    assert.deepEqual({ ...o, path: toHex(o.path, true), response: toHex(o.response, true) },
      { counter: v.counter, status: v.status, name: v.status_name, clock: v.clock, sent: v.sent, snr: v.snr,
        pathLen: v.path_len, path: v.path, response: v.response });
  });
}

test('F1 carries V3z after its tag, and F3 gives V4 back to the owner', () => {
  assert.equal(V.forwards[0].body, V.mesh_requests[2].app_sends);
  const r = mcc3.openForwardResult(K, V.forward_results[0].payload);
  const v4 = V.mesh_responses[0];
  assert.deepEqual(mcc3.openMeshResponse(K, new Uint8Array([0, 0, 0, 0, ...r.response])),
    { tag: 0, counter: v4.counter, code: v4.code, clock: v4.clock, reply: v4.reply });
});

test('a sender builds no forward a relay would refuse', () => {
  const f = V.forwards[0];
  const seal = (over = {}, opts = {}) => mcc3.sealForward(K, NODE, 9, 1, fromHex(f.rid), over.target || f.target,
    over.route ?? 0, over.body || fromHex(f.body), opts);
  assert.throws(() => seal({ route: 3 }), mcc3.Mcc3Error);
  assert.throws(() => seal({ target: NODE }), mcc3.Mcc3Error);
  assert.throws(() => seal({ body: fromHex(f.body).subarray(0, 131) }), mcc3.Mcc3Error);
  assert.throws(() => seal({ body: Uint8Array.of(0xc3, ...new Uint8Array(131)) }), mcc3.Mcc3Error);
  assert.throws(() => seal({ body: Uint8Array.of(0xc1, ...new Uint8Array(72)) }), mcc3.Mcc3Error);
  assert.throws(() => seal({}, { pathLen: 58, path: new Uint8Array(58) }), mcc3.Mcc3Error);
  assert.throws(() => seal({}, { pathLen: 0xc1, path: new Uint8Array(4) }), mcc3.Mcc3Error);
  assert.throws(() => seal({}, { pathLen: 2, path: new Uint8Array(1) }), mcc3.Mcc3Error);
  assert.throws(() => mcc3.sealMeshRequest(owner, NODE, 7, 1, 'ver', { flags: 1 }), mcc3.Mcc3Error);
  assert.throws(() => mcc3.sealMeshRequest(owner, NODE, 7, 1, 'ver', { flags: 3 }), mcc3.Mcc3Error);
});

for (const v of V.alive) {
  test(`alive ${v.name}`, () => {
    const payload = mcc3.sealAlive(K, v.fields, { nonce: v.nonce });
    assert.equal(payload, v.payload);
    assert.equal(payload.length, 252);
    assert.deepEqual(mcc3.openAlive(K, payload), v.opened);
    assert.equal(mcc3.aliveTopic(NODE), v.topic);
  });
}

for (const v of V.refusals) {
  test(`refused: ${v.name}`, () => {
    let outcome = null;
    try {
      if (v.opened_by === 'node') {
        const nodeHandle = keyFromSeed(fromHex(v.node_seed));
        if (v.kind === 'command') mcc3.openCommand(nodeHandle, v.command_key, v.input);
        else if (v.kind === 'forward') mcc3.openForward(nodeHandle, v.command_key, v.input);
        else mcc3.openMeshRequest(nodeHandle, v.command_key, fromHex(v.input), { lastCounter: v.last_counter ?? null });
      } else {
        const keys = fromHexKeys(v.keys);
        if (v.kind === 'mesh_response') mcc3.openMeshResponse(keys, fromHex(v.input));
        else if (v.kind === 'result') mcc3.openResult(keys, v.input);
        else if (v.kind === 'forward_result') mcc3.openForwardResult(keys, v.input);
        else mcc3.openAlive(keys, v.input);
      }
    } catch (e) {
      assert.ok(e instanceof mcc3.Refused, `${v.name}: ${e.message}`);
      outcome = e.outcome;
    }
    assert.equal(outcome, v.outcome);
  });
}

for (const v of V.not_built) {
  test(`not built (${v.road}): ${JSON.stringify(v.command.slice(0, 16))}`, () => {
    assert.throws(() => (v.road === 'mqtt'
      ? mcc3.sealCommand(owner, NODE, 7, 1, new Uint8Array(16), v.command)
      : mcc3.sealMeshRequest(owner, NODE, 7, 1, v.command)), mcc3.Mcc3Error);
  });
}

test('every bit after the mesh counter is covered, though the road has no tag', () => {
  const req = fromHex(V.mesh_requests[0].request);
  for (let offset = 6; offset < mcc3.MESH_REQUEST_LEN; offset += 1) {
    for (const bit of [0, 7]) {
      const bad = Uint8Array.from(req);
      bad[offset] ^= 1 << bit;
      assert.throws(() => mcc3.openMeshRequest(node, CMD_KEY, bad), mcc3.Refused, `byte ${offset} bit ${bit}`);
    }
  }
});

test('random nonces differ and both open; a mesh resend is the same bytes', () => {
  const rid = mcc3.newRid();
  const a = mcc3.sealCommand(owner, NODE, 7, 1, rid, 'ver');
  const b = mcc3.sealCommand(owner, NODE, 7, 1, rid, 'ver');
  assert.notEqual(a, b);
  assert.equal(mcc3.openCommand(node, CMD_KEY, a).command, mcc3.openCommand(node, CMD_KEY, b).command);
  const r1 = mcc3.sealResult(K, 7, 0, 0, 'ver', 'x');
  const r2 = mcc3.sealResult(K, 7, 0, 0, 'ver', 'x');
  assert.notEqual(r1, r2);
  assert.deepEqual(mcc3.openResult(K, r1), mcc3.openResult(K, r2));
  assert.deepEqual(mcc3.sealMeshRequest(owner, NODE, 9, 1795000000, 'reboot', { companionTag: 1 }),
    mcc3.sealMeshRequest(owner, NODE, 9, 1795000000, 'reboot', { companionTag: 1 }));
});

test('topics', () => {
  assert.equal(mcc3.nodeFromTopic(mcc3.commandTopic(NODE)), NODE);
  assert.equal(mcc3.nodeFromTopic(mcc3.aliveTopic(NODE.toLowerCase())), NODE);
  assert.equal(mcc3.pingTopic(NODE), `mcc/ping/${NODE}`);
  assert.equal(mcc3.nodeFromTopic(`meshcore/JKG/${NODE}/cmd`), null);
  assert.equal(mcc3.nodeFromTopic(`mcc/cmd/${NODE.toLowerCase()}`), null);
  assert.throws(() => mcc3.commandTopic(NODE.slice(0, 8)), mcc3.Mcc3Error);
});
