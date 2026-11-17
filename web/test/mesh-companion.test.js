// lib/mesh: the companion frame codec, the serial framing, the companion session and the send
// over the mesh, against a fake companion (mesh-fakes.js). No radio is opened; nothing transmits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CMD, NUS, addContact, appStart, getContactByKey, parseFrame, sendAnonReq, serialDeframer, serialFrame, utf8Cut,
} from '../lib/mesh/frames.js';
import { CompanionError, openCompanion } from '../lib/mesh/companion.js';
import { sendOverMesh } from '../lib/mesh/send.js';
import { meshFrame } from '../lib/protocol/mesh.js';
import { keyFromSeed } from '../lib/key/handle.js';
import { fromHex, toHex } from '../lib/bytes.js';
import { V } from './protocol-helpers.js';
import { fakeCompanion } from './mesh-fakes.js';

const M = V.mesh;
const owner = keyFromSeed(fromHex(V.seed));
const NODE = V.node_key;

test('the frames the companion firmware reads', () => {
  assert.equal(toHex(appStart(), true), `0103${'20'.repeat(6)}6D63636F6E74726F6C`);
  assert.equal(toHex(getContactByKey(NODE), true), `1E${NODE}`);
  const add = addContact(NODE, 'SE-JKP-Väster', 1794800000);
  assert.equal(add.length, 1 + 32 + 3 + 64 + 32 + 4 + 4 + 4);
  assert.equal(add[0], CMD.ADD_UPDATE_CONTACT);
  assert.deepEqual([...add.subarray(33, 36)], [2, 0, 0xff]);                  // a repeater with no path: floods
  assert.equal(new TextDecoder().decode(add.subarray(100, 114)), 'SE-JKP-Väster');
  assert.equal(add[100 + 31], 0, 'a name always ends in NUL');
  assert.equal(toHex(add.subarray(132, 136), true), '8079FA6A');
  // the anonymous request is the vector's whole frame
  const w = M.worked[0];
  assert.equal(toHex(sendAnonReq(M.doc_node_key, fromHex(w.body)), true), w.frame);
  assert.equal(toHex(meshFrame(M.doc_node_key, fromHex(w.body)), true), w.frame);
  assert.ok(fromHex(w.frame).length <= 176, 'fits the companion frame');
  assert.equal(NUS.service, '6e400001-b5a3-f393-e0a9-e50e24dcca9e');
});

test('a name is cut on a character boundary', () => {
  assert.equal(utf8Cut('å'.repeat(20), 31).length, 30);
  assert.equal(utf8Cut('abc', 31).length, 3);
});

test('frames from the companion parse; pushes are marked', () => {
  const sent = parseFrame(fromHex('060100F1536500000000'.slice(0, 20)));
  assert.deepEqual({ kind: sent.kind, flood: sent.flood, tag: sent.tag }, { kind: 'sent', flood: true, tag: '00F15365' });
  const resp = parseFrame(fromHex(`8C0000F15365${'EF93446607000000004F4B'}`));
  assert.equal(resp.kind, 'binaryResponse');
  assert.equal(resp.tag, '00F15365');
  assert.equal(toHex(resp.data, true), 'EF93446607000000004F4B');
  assert.equal(parseFrame(Uint8Array.of(0x88, 1)).push, true);
  assert.deepEqual(parseFrame(Uint8Array.of(1, 2)), { code: 1, push: false, kind: 'error', error: 2 });
});

test('serial framing: < len LE out, > len LE in, noise and split chunks survived', () => {
  assert.equal(toHex(serialFrame(Uint8Array.of(1, 2, 3)), true), '3C0300010203');
  assert.throws(() => serialFrame(new Uint8Array(177)), /176/);
  const d = serialDeframer();
  assert.deepEqual(d.push(new TextEncoder().encode('boot\r\n')), []);
  assert.deepEqual(d.push(Uint8Array.of(0x3e, 2)), []);
  const frames = d.push(Uint8Array.of(0, 5, 6, 0x3e, 1, 0, 9));
  assert.deepEqual(frames.map((f) => [...f]), [[5, 6], [9]]);
});

const echo = (command) => ({ code: 0, reply: `> ${command}` });

test('a known node with a path: direct, the answer matched by tag and counter', async () => {
  const fake = fakeCompanion({ ownerKey: owner.publicKeyHex, contacts: { [NODE]: 2 }, answer: echo });
  const c = await openCompanion(fake.link);
  assert.equal(c.self.name, 'LouHome');
  const out = await sendOverMesh({ companion: c, handle: owner, keyHex: NODE, region: 'jkg', command: 'get name', waitSecs: 2, counter: 77 });
  assert.equal(out.topic, `meshcore/JKG/${NODE}/cmd`);
  assert.deepEqual({ contact: out.info.contact, path: out.info.path }, { contact: 'known', path: 'direct, 2 hop(s)' });
  assert.deepEqual({ code: out.result.code, reply: out.result.reply, counter: out.result.counter, verified: out.result.verified, road: out.result.road },
    { code: 0, reply: '> get name', counter: 77, verified: true, road: 'mesh' });
  assert.equal(out.result.clock, null, "the node's clock is unset");
  assert.equal(fake.written.filter((f) => f[0] === CMD.ADD_UPDATE_CONTACT).length, 0);
});

test('an unknown node is added with no path and the request floods', async () => {
  const fake = fakeCompanion({ ownerKey: owner.publicKeyHex, answer: echo });
  const c = await openCompanion(fake.link);
  const out = await sendOverMesh({ companion: c, handle: owner, keyHex: NODE, region: 'JKG', name: 'SE-JKG-Test', command: 'ver', waitSecs: 2 });
  assert.equal(out.info.contact, 'added');
  assert.equal(out.info.path, 'flood');
  assert.equal(fake.book.get(NODE), -1);
  assert.equal(out.result.reply, '> ver');
});

test('an older companion without the lookup: the contact list is read instead', async () => {
  const fake = fakeCompanion({ ownerKey: owner.publicKeyHex, oldCompanion: true, contacts: { [NODE]: 1 }, answer: echo });
  const c = await openCompanion(fake.link);
  assert.deepEqual(await c.contact(NODE), { name: 'node', hops: 1 });
  assert.equal(await c.contact('AB'.repeat(32)), null);
});

test('a mesh-only node: signed for meshcore/mesh/<key>/cmd, or its signature fails and it is silent', async () => {
  const fake = fakeCompanion({ ownerKey: owner.publicKeyHex, region: 'mesh', contacts: { [NODE]: 0 }, answer: echo });
  const c = await openCompanion(fake.link);
  const right = await sendOverMesh({ companion: c, handle: owner, keyHex: NODE, region: 'JKG', meshOnly: true, command: 'get name', waitSecs: 1 });
  assert.equal(right.topic, `meshcore/mesh/${NODE}/cmd`);
  assert.equal(right.result.code, 0);
  const wrong = await sendOverMesh({ companion: c, handle: owner, keyHex: NODE, region: 'JKG', command: 'get name', waitSecs: 0.3 });
  assert.equal(wrong.result, null, 'silence, never a refusal');
});

test('mesh-closed and not-allowed come back as answers with their codes', async () => {
  const fake = fakeCompanion({ ownerKey: owner.publicKeyHex, contacts: { [NODE]: 0 }, clock: 1795000000,
    answer: (cmd) => (cmd === 'ver' ? { code: 19 } : { code: 14 }) });
  const c = await openCompanion(fake.link);
  const closed = await sendOverMesh({ companion: c, handle: owner, keyHex: NODE, region: 'JKG', command: 'ver', waitSecs: 1 });
  assert.deepEqual([closed.result.code, closed.result.ok, closed.result.clock], [19, false, 1795000000]);
  const denied = await sendOverMesh({ companion: c, handle: owner, keyHex: NODE, region: 'JKG', command: 'neighbors', waitSecs: 1 });
  assert.equal(denied.result.code, 14);
});

test('over 59 bytes or without the whole key: refused before signing or touching the companion', async () => {
  const fake = fakeCompanion({ ownerKey: owner.publicKeyHex });
  const c = await openCompanion(fake.link);
  const before = fake.written.length;
  let signed = 0;
  const spy = { sign: (b) => { signed += 1; return owner.sign(b); } };
  await assert.rejects(sendOverMesh({ companion: c, handle: spy, keyHex: NODE, region: 'JKG', command: 'x'.repeat(60) }), /1\.\.59 bytes/);
  await assert.rejects(sendOverMesh({ companion: c, handle: spy, keyHex: NODE.slice(0, 8), region: 'JKG', command: 'ver' }), /whole public key/);
  assert.equal(signed, 0);
  assert.equal(fake.written.length, before);
});

test('a full contact table, a refused send, a dropped link: said as companion errors', async () => {
  const full = fakeCompanion({ ownerKey: owner.publicKeyHex, full: true });
  const c = await openCompanion(full.link);
  await assert.rejects(sendOverMesh({ companion: c, handle: owner, keyHex: NODE, region: 'JKG', command: 'ver' }),
    (e) => e instanceof CompanionError && e.code === 'full');
  const gone = fakeCompanion({ ownerKey: owner.publicKeyHex, contacts: { [NODE]: 0 }, answer: () => null });
  const g = await openCompanion(gone.link);
  const waiting = sendOverMesh({ companion: g, handle: owner, keyHex: NODE, region: 'JKG', command: 'ver', waitSecs: 5 });
  setTimeout(() => gone.link.drop(), 50);
  const out = await waiting;
  assert.equal(out.result, null);
  await assert.rejects(g.contact(NODE), (e) => e.code === 'closed');
});

test('not a companion: no SELF_INFO to the app start', async () => {
  const link = { onFrame(fn) { this.fn = fn; }, onClose() {}, async close() {}, async write() { setTimeout(() => this.fn(Uint8Array.of(1, 1)), 0); } };
  await assert.rejects(openCompanion(link), /MeshCore companion/);
});

test('silence lasts the wait and is null; an abort ends it early', async () => {
  const fake = fakeCompanion({ ownerKey: owner.publicKeyHex, contacts: { [NODE]: 0 }, answer: () => null });
  const c = await openCompanion(fake.link);
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 50);
  const started = Date.now();
  const out = await sendOverMesh({ companion: c, handle: owner, keyHex: NODE, region: 'JKG', command: 'ver', waitSecs: 10, signal: stop.signal });
  assert.equal(out.result, null);
  assert.ok(Date.now() - started < 2000);
});
