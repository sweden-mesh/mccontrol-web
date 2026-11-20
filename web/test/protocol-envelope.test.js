// lib/protocol reproduces every vector Python wrote: topics, v1 and v2 envelopes, the v2 key
// steps, r1/r2/r3 results, the broker token and the registration line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../lib/protocol/constants.js';
import * as M3 from '../lib/protocol/mcc3.js';
import { buildV1, buildV2, isTransmit, v2Key, v2Nonce } from '../lib/protocol/envelope.js';
import { codeHelp, codeName, parseAny, parseR3, parseResult } from '../lib/protocol/results.js';
import { makeToken, username } from '../lib/protocol/token.js';
import { registerPayload } from '../lib/protocol/registration.js';
import {
  commandTopic, commandTopicOf, nodeFromResultTopic, nodeId, nodeKey, registerAckTopic, resultTopic,
} from '../lib/protocol/topics.js';
import { b64url, unb64url } from '../lib/protocol/text.js';
import { toHex } from '../lib/bytes.js';
import { V, data, ownerHandle } from './protocol-helpers.js';

const owner = ownerHandle();

test('the constants are the ones Python exports', () => {
  const p = data('protocol');
  const pairs = {
    topic_prefix: C.TOPIC_PREFIX, field_sep: C.FIELD_SEP, v1: C.V1, v2: C.V2, r1: C.R1, r2: C.R2, r3: C.R3,
    sig_hex_len: C.SIG_HEX_LEN, max_payload: C.MAX_PAYLOAD, max_topic: C.MAX_TOPIC,
    max_command: C.MAX_COMMAND, max_future_secs: C.MAX_FUTURE_SECS, default_ttl_secs: C.DEFAULT_TTL_SECS,
    node_hex_len: C.NODE_HEX_LEN, key_hex_len: C.KEY_HEX_LEN, v2_info: C.V2_INFO,
    v2_command_pads: [...C.V2_COMMAND_PADS], r3_pads: [...C.R3_PADS], tag_len: C.TAG_LEN,
    dir_command: C.DIR_COMMAND, dir_result: C.DIR_RESULT, register_topic: C.REGISTER_TOPIC,
    register_version: C.REGISTER_VERSION, token: { ...C.TOKEN }, mesh: { ...C.MESH },
    mcc3_forward: {
      kind: M3.KIND.forward, result_kind: M3.KIND.forward_result, hkdf_info: M3.INFO.fwd, flag_zero_hop: M3.FLAG_ZERO_HOP,
      alive_flag_relay: M3.ALIVE_FLAG_RELAY, size: M3.FORWARD_SIZE, result_size: M3.FORWARD_RESULT_SIZE, path: M3.FORWARD_PATH,
      body: M3.FORWARD_BODY, min_body: M3.FORWARD_MIN_BODY, body_subtypes: [M3.MESH_V1_SUBTYPE, M3.MESH_SUBTYPE],
      result_plaintext: M3.FORWARD_RESULT_PLAIN, result_path: M3.FORWARD_RESULT_PATH, max_response: M3.FORWARD_MAX_RESPONSE,
      routes: { ...M3.ROUTES }, statuses: [...M3.FORWARD_STATUSES], sent: { ...M3.SENT }, snr_none: M3.SNR_NONE,
      path_none: M3.PATH_NONE, max_ttl_secs: M3.FORWARD_MAX_TTL,
    },
  };
  // keys that start with _ are for the reader (the source, the mesh road's layout in words)
  const exported = Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('_')));
  assert.deepEqual(pairs, exported);
});

test('topics', () => {
  for (const t of V.topics) {
    assert.equal(commandTopic(t.iata, t.node, t.key), t.command);
    if (t.result) {
      assert.equal(resultTopic(t.iata, t.node, t.key), t.result);
      assert.equal(commandTopicOf(t.result), t.command);
      assert.equal(nodeFromResultTopic(t.result), t.key || t.node);
    }
  }
  assert.equal(nodeId(V.node_key.toLowerCase()), V.node_key.slice(0, 8));
  assert.equal(nodeKey(V.node_key.slice(0, 8)), null);
  assert.throws(() => nodeId('12'), /first 8 hex/);
  assert.throws(() => nodeId('XYZ12345'), /hex/);
  assert.equal(nodeFromResultTopic('meshcore/JKG/ABC/res'), null);
  assert.equal(nodeFromResultTopic('meshcore/JKG/71565BBD/cmd'), null);
});

test('v1 envelopes are byte-identical', () => {
  for (const c of V.v1) {
    assert.equal(buildV1(owner, c.topic, c.counter, c.command, { ttl: c.ttl, now: c.now }), c.payload, c.command);
  }
});

test('v1 refuses what Python refuses', () => {
  const topic = commandTopic('JKG', V.node_key.slice(0, 8), V.node_key);
  for (const c of V.v1_errors) {
    assert.throws(() => buildV1(owner, topic, c.counter ?? 1, c.command, { ttl: c.ttl ?? 300, now: V.now }),
      Error, JSON.stringify(c));
  }
  assert.throws(() => buildV1(owner, 'x'.repeat(161), 1, 'ver', { now: V.now }), /topic/);
  assert.throws(() => buildV1(owner, 'x', 1, 'a b', { now: V.now }), /printable/);
});

test('v2 key steps and envelopes are byte-identical', () => {
  const k = V.v2_keys;
  assert.equal(toHex(owner.sharedSecret(V.node_key)), k.shared_secret);
  assert.equal(toHex(v2Key(owner, V.node_key, k.topic)), k.key);
  for (const c of V.v2) {
    assert.equal(toHex(v2Nonce(C.DIR_COMMAND, c.counter)), c.nonce);
    assert.equal(buildV2(owner, c.topic, c.counter, c.command, c.node_key, { ttl: c.ttl, now: c.now }),
      c.payload, c.command);
  }
  assert.throws(() => buildV2(owner, k.topic, 1, 'ver', V.node_key.slice(0, 8)), /whole public key/);
  assert.throws(() => buildV2(owner, k.topic, 1, 'a|b', V.node_key), /may not contain/);
});

test('results r1, r2 and r3 parse as Python parses them', () => {
  for (const r of V.results) {
    const node = V.node_key.slice(0, 8);
    let got;
    if (r.kind === 'r3') {
      got = parseR3(r.payload, node, owner, V.node_key, V.v2_keys.topic);
    } else {
      got = parseResult(r.payload, node, r.with_key ? { topic: r.topic, keyHex: V.node_key } : {});
    }
    const plain = got && { counter: got.counter, code: got.code, command: got.command, reply: got.reply, verified: got.verified };
    assert.deepEqual(plain, r.result, r.payload);
    // bytes in, the same out; and parseAny picks the kind by its tag
    const viaAny = parseAny(new TextEncoder().encode(r.payload), node,
      { handle: owner, topic: r.topic, keyHex: r.with_key ? V.node_key : null, commandTopic: V.v2_keys.topic });
    assert.deepEqual(viaAny && viaAny.verified, r.result && r.result.verified, r.payload);
  }
});

test('a result is ok only when it ran and was not forged', () => {
  const forged = V.results.find((r) => r.kind === 'r2' && r.result.verified === false);
  const got = parseResult(forged.payload, 'X', { topic: forged.topic, keyHex: V.node_key });
  assert.equal(got.code, 0);
  assert.equal(got.ok, false);
  assert.equal(parseResult('r1|1|0|ver|x').ok, true);
  assert.equal(parseResult(Uint8Array.of(0xff, 0xfe)), null);
  assert.equal(parseR3('r3|1|AAAA', 'X', owner, null, V.v2_keys.topic).verified, null);
});

test('result codes have names and help', () => {
  const results = data('results');
  assert.equal(codeName(results, 14), 'not-allowed');
  assert.equal(codeName(results, 99), 'unknown-99');
  assert.match(codeHelp(results, 16), /signature/);
  assert.match(codeHelp(results, 1), /nothing in it/);   // W-36: every code has its text
  assert.equal(codeHelp(results, 99), '');
});

test('the broker token and the registration line are byte-identical', () => {
  const t = V.token;
  assert.equal(username(owner), t.username);
  assert.equal(makeToken(owner, t.audience, { now: t.now, lifetime: t.lifetime }), t.password);
  const r = V.registration;
  assert.equal(registerPayload(owner, { now: r.now }), r.payload);
  assert.equal(registerAckTopic(owner.publicKeyHex.toLowerCase()), r.ack_topic);
  assert.equal(C.REGISTER_TOPIC, r.topic);
});

test('base64url both ways', () => {
  for (let n = 0; n < 40; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
    const text = b64url(bytes);
    assert.equal(text, Buffer.from(bytes).toString('base64url'));
    if (n) assert.deepEqual(unb64url(text), bytes);
  }
  assert.throws(() => unb64url('A'), /base64url/);
  assert.throws(() => unb64url('AA=='), /base64url/);
  assert.throws(() => unb64url(''), /base64url/);
});

test('is_transmit matches', () => {
  for (const c of V.checks.is_transmit) assert.equal(isTransmit(c.command), c.transmit, c.command);
});
