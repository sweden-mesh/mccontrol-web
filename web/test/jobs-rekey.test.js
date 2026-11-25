// Replacing the key on the nodes (lib/jobs/rekey.js): the round as pure functions, with a scripted
// send in place of the roads, as mccontrol-cli's tests/test_rekey.py has it. Invented keys and names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PROOF_COMMAND, RekeyError, STATES, WHY, WINDOW_MS, abortRefusal, apply, finishRefusal, keyText, offerAccepted, offerCommand,
  proofAccepted, provedNodes, rotate, start, stepsFor, summary, view, whyNot,
} from '../lib/jobs/rekey.js';
import { rekeyParse, REKEY_OK } from '../lib/demo/nodes.js';
import { rulesFrom } from '../lib/protocol/rules.js';
import { makeResult } from '../lib/protocol/results.js';

const json = (name) => JSON.parse(readFileSync(new URL(`../lib/data/${name}.json`, import.meta.url), 'utf8'));
const rules = rulesFrom(Object.fromEntries(['commands', 'cautions', 'denylist', 'facts', 'firmware'].map((n) => [n, json(n)])));

const IN_USE = 'A1'.repeat(32);
const NEXT = '0F'.repeat(31) + 'F3';
const LOU20 = 'esp32s3-v1.18.0-lou-20-arrc-observer-1a2b3c4d';
const LOU20_MESH = 'nrf52840-v1.18.0-lou-20-rc-1a2b3c4d';
const LOU19 = 'esp32s3-v1.18.0-lou-19-arrc-observer-1a2b3c4d';
const dev = (name, byte, ver) => ({ name, key: byte.repeat(32), node: byte.repeat(4), ver });
const RELAY = dev('TEST-relay', 'B2', LOU20);
const SOLAR = dev('TEST-solar', 'C3', LOU20_MESH);
const OLD = dev('TEST-old', 'D4', LOU19);
const UNREAD = dev('TEST-unread', 'E5', null);
const ALL = [RELAY, SOLAR, OLD, UNREAD];
const T0 = Date.UTC(2026, 10, 25, 12);

const ok = (node, command, reply) => makeResult(node, 1, 0, command, reply, true);

// A round kept in memory, a clock, and send(): `answers[signer step node]` is false (silence), a
// result code (a verified refusal) or absent (the firmware's own answer). Everything sent is listed.
function bench(answers = {}) {
  const b = { round: start({ inUse: IN_USE, next: NEXT, now: T0 }), now: T0, sent: [] };
  b.load = async () => b.round;
  b.save = async (r) => { b.round = r; };
  b.send = async (signer, command, device) => {
    const verb = command.split(' ')[0];
    b.sent.push([signer, command, device.name]);
    const a = answers[`${signer} ${verb} ${device.name}`];
    if (a === false) return { result: null, road: 'mqtt' };
    if (typeof a === 'number') return { result: makeResult(device.node, 1, a, command, '', true), road: 'mqtt' };
    if (typeof a === 'string') return { result: ok(device.node, command, a), road: 'mqtt' };
    return { result: ok(device.node, command, verb === 'rekey' ? REKEY_OK : device.ver), road: 'mqtt' };
  };
  b.rotate = (device, more = {}) => rotate({ load: b.load, save: b.save, rules, device, send: b.send, now: () => b.now, ...more });
  b.state = (device) => view(b.round, rules, device, b.now).state;
  b.sum = () => summary(b.round, rules, ALL, b.now);
  return b;
}

test('the key travels as 43 base64url characters, which the node reads back to the same 32 bytes', () => {
  const text = keyText(NEXT);
  assert.equal(text.length, 43);
  assert.match(text, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(text, 'base64url').toString('hex').toUpperCase(), NEXT);
  assert.equal(offerCommand(NEXT), `rekey ${text}`);
  assert.equal(rekeyParse(offerCommand(NEXT)), NEXT, 'the demo node parses it as the firmware does');
  assert.ok(offerCommand(NEXT).length <= 57, 'it fits the mesh road');
  assert.equal(rekeyParse(`rekey ${NEXT}`), null, 'hex is not the form');
  assert.equal(rekeyParse(`rekey ${text.slice(0, 42)}B`), null, 'the two spare bits must be zero');
  assert.throws(() => keyText('abc'), RekeyError);
});

test('start makes a round and sends nothing; the key in use is refused', () => {
  const b = bench();
  assert.deepEqual({ ...b.round, nodes: { ...b.round.nodes } }, { v: 1, from: IN_USE, next: NEXT, started: T0, nodes: {} });
  assert.deepEqual(b.sent, []);
  assert.throws(() => start({ inUse: IN_USE, next: IN_USE.toLowerCase(), now: T0 }), (e) => e.code === 'sameKey');
  assert.deepEqual([RELAY, SOLAR, OLD, UNREAD].map((d) => b.state(d)), ['waiting', 'waiting', 'cannot', 'cannot']);
});

test('a node is offered the key with the old key and proved with the new one', async () => {
  const b = bench();
  const out = await b.rotate(RELAY);
  assert.equal(out.state, STATES.proved);
  assert.deepEqual(b.sent, [['old', offerCommand(NEXT), 'TEST-relay'], ['new', PROOF_COMMAND, 'TEST-relay']]);
  assert.deepEqual(out.steps.map((s) => [s.step, s.ok]), [['offer', true], ['prove', true]]);
  assert.deepEqual([RELAY, SOLAR].map((d) => b.state(d)), ['proved', 'waiting'], 'the other node was not touched');
  assert.deepEqual([...provedNodes(b.round)], [RELAY.node]);
});

test('an offer the node refuses, answers with Err, or meets with silence changes nothing and the proof is not sent', async () => {
  for (const answer of [14, 'Err - that is the key in use', false]) {
    const b = bench({ 'old rekey TEST-relay': answer });
    const out = await b.rotate(RELAY);
    assert.equal(out.state, STATES.failed, String(answer));
    assert.equal(b.sent.length, 1, 'no proof after an offer that was not taken');
    assert.equal(abortRefusal(b.sum()), null, 'it keeps the key in use: abort is open');
  }
});

test('a proof met with silence leaves the node sent; within the hour it is proved again with one send', async () => {
  const b = bench({ 'new ver TEST-solar': false });
  assert.equal((await b.rotate(SOLAR)).state, STATES.sent);
  assert.equal(b.sent.length, 2);
  b.now += 10 * 60000;
  const v = view(b.round, rules, SOLAR, b.now);
  assert.equal(v.state, STATES.sent);
  assert.equal(v.left, 50 * 60000, 'the time the key still waits on the node');
  const again = bench();
  again.round = b.round; again.now = b.now;
  assert.equal((await again.rotate(SOLAR, { proveOnly: true })).state, STATES.proved);
  assert.deepEqual(again.sent, [['new', PROOF_COMMAND, 'TEST-solar']], 'the proof alone: one transmission');
});

test('a sent node can be offered again, as the terminal tool does: the node may have restarted', async () => {
  const b = bench({ 'new ver TEST-solar': false });
  await b.rotate(SOLAR);
  b.now += 5 * 60000;
  const again = bench();
  again.round = b.round; again.now = b.now;
  assert.equal((await again.rotate(SOLAR)).state, STATES.proved);
  assert.deepEqual(again.sent.map((s) => s[1].split(' ')[0]), ['rekey', 'ver']);
});

test('a later offer that did not arrive does not undo one that still waits', async () => {
  const b = bench({ 'new ver TEST-solar': false });
  await b.rotate(SOLAR);
  const at = b.round.nodes[SOLAR.node].at;
  const again = bench({ 'old rekey TEST-solar': false });
  again.round = b.round; again.now = b.now + 60000;
  assert.equal((await again.rotate(SOLAR)).state, STATES.sent);
  assert.equal(again.round.nodes[SOLAR.node].at, at, 'the hour runs from the offer the node took');
});

test('the window: after 60 minutes the node has forgotten the key, and only a new offer helps', async () => {
  const b = bench({ 'new ver TEST-solar': false });
  await b.rotate(SOLAR);
  b.now += WINDOW_MS - 1;
  assert.equal(b.state(SOLAR), STATES.sent);
  b.now += 1;
  const v = view(b.round, rules, SOLAR, b.now);
  assert.deepEqual([v.state, v.expired, v.left], [STATES.waiting, true, null]);
  assert.deepEqual(stepsFor(v, true), ['offer', 'prove'], 'a proof alone would be signed by a key the node no longer holds');
  const again = bench();
  again.round = b.round; again.now = b.now;
  await again.rotate(SOLAR, { proveOnly: true });
  assert.deepEqual(again.sent.map((s) => s[0]), ['old', 'new']);
  assert.equal(b.sum().sent.length, 0, 'an expired offer is not counted as one that may have been taken');
});

test('an answer that opens under the new key proves the node took it, a refusal too', async () => {
  const b = bench({ 'new ver TEST-relay': 17 });
  const out = await b.rotate(RELAY);
  assert.equal(out.state, STATES.proved, 'only a node that holds the new key can seal to it');
  assert.equal(proofAccepted(makeResult('X', 1, 0, 'ver', 'v', false)), false, 'a forged answer proves nothing');
  assert.equal(proofAccepted(makeResult('X', 1, 0, 'ver', 'v', null)), false, 'nor an unsigned one');
  assert.equal(proofAccepted(null), false);
  assert.equal(offerAccepted(makeResult('X', 1, 0, 'rekey', REKEY_OK, true)), true);
  assert.equal(offerAccepted(makeResult('X', 1, 0, 'rekey', REKEY_OK, false)), false);
});

test('a node on the new key is only proved again', async () => {
  const b = bench();
  await b.rotate(RELAY);
  b.sent.length = 0;
  await b.rotate(RELAY);
  assert.deepEqual(b.sent, [['new', PROOF_COMMAND, 'TEST-relay']]);
  const silent = bench({ 'new ver TEST-relay': false });
  silent.round = b.round;
  assert.equal((await silent.rotate(RELAY)).state, STATES.proved, 'silence does not take the proof back');
});

test('older firmware and an unread node are never sent anything, and say why', async () => {
  const b = bench();
  assert.equal(whyNot(rules, OLD), WHY.usb);
  assert.equal(whyNot(rules, UNREAD), WHY.noVersion);
  assert.equal(whyNot(rules, { ...RELAY, key: RELAY.key.slice(0, 8) }), WHY.noKey);
  assert.equal(whyNot(rules, { ...RELAY, ver: 'esp32s3-v1.18.0-lou-20-ar-observer-1a2b3c4d' }), WHY.usb, 'no control plane in the image');
  await assert.rejects(b.rotate(OLD), (e) => e instanceof RekeyError && e.code === WHY.usb);
  await assert.rejects(b.rotate(UNREAD), (e) => e.code === WHY.noVersion);
  assert.deepEqual(b.sent, []);
  assert.deepEqual(stepsFor(view(b.round, rules, OLD, b.now)), []);
  assert.deepEqual(b.sum().cannot.map((c) => [c.device.name, c.why]), [['TEST-old', 'usb'], ['TEST-unread', 'noVersion']]);
});

test('no round, no send', async () => {
  const b = bench();
  b.round = null;
  await assert.rejects(b.rotate(RELAY), (e) => e.code === 'notStarted');
  assert.deepEqual(b.sent, []);
});

test('finish waits for every node that can, unless the owner leaves them behind', async () => {
  const b = bench();
  assert.deepEqual(finishRefusal(b.sum()), { code: 'left', names: ['TEST-relay', 'TEST-solar'] });
  await b.rotate(RELAY);
  assert.deepEqual(finishRefusal(b.sum()), { code: 'left', names: ['TEST-solar'] });
  assert.equal(finishRefusal(b.sum(), true), null, 'the owner\'s word leaves it behind');
  await b.rotate(SOLAR);
  assert.equal(finishRefusal(b.sum()), null, 'older and unread nodes do not hold it up: they need USB either way');
  assert.deepEqual(b.sum().proved.map((d) => d.name), ['TEST-relay', 'TEST-solar']);
});

test('finish with no node on the new key is refused: there is nothing to finish', () => {
  const none = summary(start({ inUse: IN_USE, next: NEXT, now: T0 }), rules, [OLD], T0);
  assert.deepEqual(finishRefusal(none), { code: 'none', names: [] });
  assert.equal(finishRefusal(none, true), null);
});

test('abort is open before any proof and shut after one; a sent node is named as one that may have taken it', async () => {
  const b = bench({ 'new ver TEST-solar': false });
  assert.equal(abortRefusal(b.sum()), null);
  await b.rotate(SOLAR);
  assert.equal(abortRefusal(b.sum()), null, 'offered is not taken');
  assert.deepEqual(b.sum().sent.map((d) => d.name), ['TEST-solar']);
  await b.rotate(RELAY);
  assert.deepEqual(abortRefusal(b.sum()), { code: 'taken', names: ['TEST-relay'] });
});

test('one send at a time, each once: rotate never repeats a step by itself', async () => {
  const b = bench({ 'old rekey TEST-relay': false, 'new ver TEST-solar': false });
  await b.rotate(RELAY);
  await b.rotate(SOLAR);
  assert.deepEqual(b.sent.map((s) => `${s[0]} ${s[1].split(' ')[0]} ${s[2]}`), ['old rekey TEST-relay', 'old rekey TEST-solar', 'new ver TEST-solar']);
  assert.throws(() => apply(b.round, RELAY.node, 'other', true, T0), RekeyError);
});
