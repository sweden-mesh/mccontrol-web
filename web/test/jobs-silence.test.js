// Why a mesh command got no answer, and what to try (lib/jobs/silence.js): the decision as a pure
// function of the road, the outcome, the direct sends lost in a row and the two `refused` counts;
// and the words the screens make of it, in both languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADVICE, advice, refusedCount, step } from '../lib/jobs/silence.js';
import { explain } from '../ui/screens/node-kit.js';
import { translator } from '../i18n/i18n.js';
import { memoryDb } from '../lib/store/db.js';
import { openStores } from '../lib/store/index.js';

test('the refused count is read from get cmd only', () => {
  const reply = '> on, counter 1795000000, mesh on ok 4 refused 2';
  assert.equal(refusedCount('get cmd', reply), 2);
  assert.equal(refusedCount('get  mqtt.cmd', '> on, mesh auto ok 0 refused 11'), 11);
  assert.equal(refusedCount('get cmd', '> on, counter 5, mesh only, mesh on ok 0 refused 0'), 0);
  assert.equal(refusedCount('get relay', '> own, forwarded 3, answered 2, refused 1'), null);
  assert.equal(refusedCount('get cmd', '> off'), null);
  assert.equal(refusedCount('get name', reply), null);
});

test('a refused count that rose across the silence is said, and nothing else is', () => {
  assert.deepEqual(advice('mqtt', 'ok', 0, 2, 3), ['refused']);
  for (const [before, after] of [[3, 3], [3, 0], [null, 3], [3, null]]) assert.deepEqual(advice('mqtt', 'ok', 0, before, after), []);
});

test('two direct losses in a row suggest a flood, over the mesh roads only and only for a silence', () => {
  for (const road of ['mesh', 'relay']) {
    assert.deepEqual(advice(road, 'silent', 1), []);
    assert.deepEqual(advice(road, 'silent', 2), ['flood']);
    assert.deepEqual(advice(road, 'silent', 3), ['flood']);
    for (const outcome of ['ok', 'refused', 'unknown']) assert.deepEqual(advice(road, outcome, 5), []);
  }
  assert.deepEqual(advice('mqtt', 'silent', 5), []);
});

test('the count is of direct sends in a row, and any answer over the mesh ends it', () => {
  let s = step(null, 'relay', 'silent', true).state;
  s = step(s, 'mesh', 'silent', true).state;
  assert.equal(s.direct, 2);
  assert.equal(step(s, 'relay', 'silent', false).state.direct, 0, 'a flood is not a direct loss');
  assert.equal(step(s, 'relay', 'ok', true).state.direct, 0);
  assert.equal(step(s, 'mesh', 'refused', true).state.direct, 0);
  assert.equal(step(s, 'relay', 'unknown', true).state.direct, 2, 'not known to have been sent');
  assert.equal(step(s, 'mqtt', 'ok').state.direct, 2, 'MQTT says nothing of the path');
});

test('the two counts are the reads before and after the silence', () => {
  let r = step(null, 'mqtt', 'ok', false, 2);
  assert.deepEqual([r.before, r.after], [null, null]);
  r = step(r.state, 'mesh', 'silent', true);
  assert.deepEqual([r.before, r.after, r.state.refused], [null, null, 2]);
  r = step(r.state, 'mesh', 'silent', true);
  r = step(r.state, 'mqtt', 'ok', false, 4);
  assert.deepEqual([r.before, r.after, r.state.refused, r.state.base], [2, 4, null, 4]);
  r = step(r.state, 'mqtt', 'ok', false, 5);
  assert.deepEqual([r.before, r.after], [null, null], 'no silence between');
  // a read over the mesh after the silence counts too
  r = step(step(step(null, 'relay', 'ok', false, 1).state, 'relay', 'silent').state, 'relay', 'ok', false, 2);
  assert.deepEqual([r.before, r.after], [1, 2]);
});

test('a count that other sends could have raised is not used', () => {
  const read = step(null, 'mqtt', 'ok', false, 2).state;
  const end = (s) => { const r = step(s, 'mqtt', 'ok', false, 4); return [r.before, r.after]; };
  // a mesh send between the read and the silence: an answered refusal is counted too
  assert.deepEqual(end(step(step(read, 'mesh', 'refused').state, 'mesh', 'silent').state), [null, null]);
  for (const outcome of ['refused', 'unknown']) {
    assert.deepEqual(end(step(step(read, 'mesh', 'silent').state, 'relay', outcome).state), [null, null], outcome);
  }
  assert.deepEqual(end(step(null, 'mesh', 'silent').state), [null, null], 'no read before the silence');
  assert.deepEqual(end(step(read, 'mesh', 'silent').state), [2, 4]);
});

test('the words: both causes and neither claimed; the flood by its control; the refusal on the read', () => {
  for (const lang of ['en', 'sv']) {
    const strings = JSON.parse(readFileSync(new URL(`../i18n/${lang}.json`, import.meta.url), 'utf8'));
    const ctx = { t: translator(strings), lang };
    const plain = explain(ctx, null, null, null, 'mesh').help;
    assert.equal(plain, `${strings['road.silentMesh']} ${strings['road.adviceSilent']}`);
    assert.match(strings['road.adviceSilent'], /get cmd/);
    assert.match(strings['road.adviceSilent'], /refused/);
    const flood = explain(ctx, null, null, null, 'mesh', null, ['flood']).help;
    assert.ok(flood.startsWith(plain) && flood.includes(strings['road.relay']) && flood.includes(strings['road.route.flood']), flood);
    assert.ok(!/[{}]/.test(flood), flood);
    assert.equal(explain(ctx, null, null, null, 'mqtt', null, ['flood']).help, strings['send.res.silentHelp']);
    const ok = { ok: true, code: 0, reply: '> on', verified: true };
    assert.equal(explain(ctx, null, ok, null, 'mqtt', null, ['refused']).help, `${strings['send.res.signed']} ${strings['road.adviceRefused']}`);
    assert.equal(explain(ctx, null, ok, null, 'mqtt', null, []).help, strings['send.res.signed']);
    for (const k of ['road.silentMesh', 'road.adviceSilent', 'road.adviceRefused', 'road.adviceFlood.mesh', 'road.adviceFlood.relay']) {
      assert.ok(strings[k] && !strings[k].includes('\u2014'), k);
    }
  }
});

test('a history event keeps only the words this app writes', async () => {
  const stores = openStores(memoryDb(), 'C'.repeat(64));
  const e = await stores.history.append({ node: 'AAAA0001', command: 'ver', road: 'mesh', advice: ['flood', 'run this', { x: 1 }, 'refused'] });
  assert.deepEqual(e.advice, [...ADVICE]);
  assert.deepEqual((await stores.history.append({ node: 'AAAA0001', command: 'ver', advice: 'flood' })).advice, []);
});
