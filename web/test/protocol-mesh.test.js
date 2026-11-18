// lib/protocol/mesh.js and the mesh parts of rules.js reproduce vectors.mesh, which Python wrote
// from the wire-format document's own test keys: every request, frame and signature byte for byte,
// the 59-byte limit, every response, the allowance and the refusals, and which firmware speaks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MESH } from '../lib/protocol/constants.js';
import {
  checkCommand, meshBuild, meshFrame, meshRequest, meshResponse, meshTopic, parseMeshResponse,
} from '../lib/protocol/mesh.js';
import { rulesFrom } from '../lib/protocol/rules.js';
import { keyFromSeed } from '../lib/key/handle.js';
import { fromHex, toHex } from '../lib/bytes.js';
import { V, data } from './protocol-helpers.js';

const M = V.mesh;
const docOwner = keyFromSeed(fromHex(M.doc_seed));
const testOwner = keyFromSeed(fromHex(V.seed));
const rules = rulesFrom({
  denylist: data('denylist'), cautions: data('cautions'), commands: data('commands'), firmware: data('firmware'), facts: data('facts'),
});

test('the document keys are the ones Python used', () => {
  assert.equal(docOwner.publicKeyHex, M.doc_public_key);
  assert.equal(keyFromSeed(fromHex(M.doc_node_seed)).publicKeyHex, M.doc_node_key);
});

function check(owner, nodeKeyHex, c) {
  const topic = meshTopic(c.region, nodeKeyHex, c.mesh_only);
  assert.equal(topic, c.topic, c.command);
  const body = meshRequest(owner, topic, c.counter, c.expiry, c.command);
  assert.equal(toHex(body, true), c.body, c.command);
  assert.equal(toHex(body.subarray(9, 73), true), c.signature, c.command);
  assert.equal(toHex(meshFrame(nodeKeyHex, body), true), c.frame, c.command);
  assert.equal(body.length, MESH.head + new TextEncoder().encode(c.command).length);
}

test('the worked vectors: request, signature and frame byte for byte', () => {
  for (const c of M.worked) check(docOwner, M.doc_node_key, c);
  assert.equal(M.worked[0].tag + toHex(meshRequest(docOwner, M.worked[0].topic, 7, 1795000000, M.worked[0].command), true),
    M.worked[0].plaintext);
});

test('the test-key requests: lower-case region, 32-bit edges, UTF-8, 59 bytes, mesh only', () => {
  for (const c of M.requests) check(testOwner, V.node_key, c);
});

test('the same signature travels as the MQTT v1 payload', () => {
  for (const c of [...M.worked, ...M.requests]) {
    assert.equal(`v1|${c.counter}|${c.expiry}|${c.command}|${c.signature}`, c.mqtt_payload);
  }
});

test('meshBuild is meshRequest at now + ttl', () => {
  const c = M.requests[0];
  const built = meshBuild(testOwner, c.topic, c.counter, c.command, { ttl: c.expiry - V.now, now: V.now });
  assert.equal(toHex(built, true), c.body);
  assert.throws(() => meshBuild(testOwner, c.topic, 1, 'ver', { ttl: 0 }), /ttl/);
});

test('over 59 bytes, or empty, is refused before signing', () => {
  for (const c of M.too_long) {
    assert.throws(() => checkCommand(c.command), /1\.\.59 bytes/);
    let signed = false;
    const spy = { sign: () => { signed = true; return new Uint8Array(64); } };
    assert.throws(() => meshRequest(spy, 'meshcore/JKG/x/cmd', 1, 2, c.command));
    assert.equal(signed, false, 'nothing signed');
  }
  checkCommand('x'.repeat(59));
});

test('a topic needs the whole key, and a region unless mesh only', () => {
  assert.throws(() => meshTopic('JKG', V.node_key.slice(0, 8)), /whole public key/);
  assert.throws(() => meshTopic('JKG', null), /whole public key/);
  assert.throws(() => meshTopic('', V.node_key), /region/);
  assert.equal(meshTopic('', V.node_key, true), `meshcore/mesh/${V.node_key}/cmd`);
});

test('responses parse as Python parses them', () => {
  for (const r of M.responses) {
    const got = parseMeshResponse(fromHex(r.data), { counter: r.counter });
    if (r.result === null) { assert.equal(got, null, r.data); continue; }
    assert.deepEqual({ counter: got.counter, code: got.code, reply: got.reply, clock: got.clock }, r.result, r.data);
    assert.equal(got.verified, true);
    assert.equal(got.road, 'mesh');
    assert.equal(got.ok, r.result.code === 0);
  }
  assert.equal(toHex(meshResponse(1715770351, 7, 0, 'OK'), true), 'EF934466070000000' + '04F4B');
});

test('the allowance and the mesh-only refusals match Python', () => {
  for (const c of M.refusal) {
    assert.equal(rules.meshRefusal(c.command), c.uplink, `uplink: ${c.command}`);
    assert.equal(rules.meshRefusal(c.command, true), c.mesh_only, `mesh only: ${c.command}`);
  }
});

test('which firmware speaks the mesh road, and which is mesh only', () => {
  for (const f of M.firmware) {
    assert.equal(rules.speaksMesh(f.version), f.speaks_mesh, String(f.version));
    assert.equal(rules.meshOnly(f.version), f.mesh_only, String(f.version));
  }
  assert.equal(rules.deviceMeshOnly({ ver: 'nrf52-v1.18.0-lou-19-rc-1a2b3c4d' }), true);
  assert.equal(rules.deviceMeshOnly({ ver: 'nrf52-v1.18.0-lou-19-rc-1a2b3c4d', meshOnly: false }), false);
  assert.equal(rules.deviceMeshOnly({ ver: 'esp32s3-v1.18.0-lou-19-arrc-observer-1a2b3c4d', meshOnly: true }), true);
});

// W-26d: LOUTEST (an MQTT-capable lou-19 arrc-observer node in JKG) answered the web app's mesh
// `ver` with a refusal and MQTT's with the version. The web app's request is byte for byte the
// CLI's (this frame is Python's mesh.frame for the same seed, counter and expiry): both sign
// meshcore/JKG/<whole key>/cmd, the topic the firmware rebuilds for a node with an IATA
// (mqttCtrlMeshRegion: its mqtt.iata, upper case since set). A node only answers a request whose
// signature and counter it accepts, so the refusal was the node's own: 19 mesh-closed, its
// mqtt.cmd.mesh being auto with MQTT up. Nothing to fix on either side.
test('LOUTEST: the web app\'s mesh ver is the CLI\'s, byte for byte', async () => {
  const { createHash } = await import('node:crypto');
  const { meshRequest, meshTopic } = await import('../lib/protocol/mesh.js');
  const { sendAnonReq } = await import('../lib/mesh/frames.js');
  const key = 'F415473DD701A5B949A039991C672FCF119C564799F0ADE1E1B73150696F66A7';
  const owner = keyFromSeed(fromHex(createHash('sha256').update('w26d test seed').digest('hex')));
  const topic = meshTopic('JKG', key, false);
  assert.equal(topic, `meshcore/JKG/${key}/cmd`);
  assert.equal(toHex(sendAnonReq(key, meshRequest(owner, topic, 1795000000, 1795000300, 'ver'))).toLowerCase(),
    '39f415473dd701a5b949a039991c672fcf119c564799f0ade1e1b73150696f66a7c1c086fd6aec87fd6aac5b2737de1207150257e3ecb5cfa6221a215fb78da869618970c351b4c1fc8708eb0ed15620e16cff30319011eab794ea356e331e57406d953657a937d85a00766572');
});
