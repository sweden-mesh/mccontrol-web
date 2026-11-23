// What the demo's nodes answer (W-39j): every command the tool offers has an answer of its own, so a
// command added to the spec fails here until the demo knows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answer, newState, clockLine, UNKNOWN } from '../lib/demo/answers.js';
import { demoWorld } from '../lib/demo/world.js';
import { rulesFrom } from '../lib/protocol/rules.js';
import { parseNeighbors } from '../lib/jobs/relay.js';

const json = (name) => JSON.parse(readFileSync(new URL(`../lib/data/${name}.json`, import.meta.url), 'utf8'));
const data = Object.fromEntries(['commands', 'cautions', 'denylist', 'facts', 'firmware', 'help', 'protocol', 'results', 'brokers', 'areas'].map((n) => [n, json(n)]));
const rules = rulesFrom(data);
const world = demoWorld();
const NOW = Date.UTC(2026, 10, 23, 12, 5);
const ctx = { now: NOW, neighbours: [{ key: 'AB'.repeat(32), secsAgo: 90, snr4: -18 }, { key: 'CD'.repeat(32), secsAgo: 400, snr4: 22 }] };
const fresh = () => ({ ...newState(world, world.nodes[0]), started: NOW - 86400000 });

// A sendable command for a table row: its text, with an example or a plain value where it takes one.
const sample = (row) => (row.kind === 'none' ? row.text : `${row.text} ${row.examples?.[0] ?? row.choices?.[0] ?? '1'}`.trim());

test('every command in the tool\'s table that the plane admits has an answer of its own', () => {
  const missing = [];
  for (const row of data.commands.table) {
    if (row.text === 'get' || row.text === 'set') continue;   // the free forms: any name
    const command = sample(row);
    if (rules.refusal(command)) continue;
    const a = answer(fresh(), command, ctx);
    assert.equal(a.code, 0, command);
    if (a.reply === UNKNOWN || a.reply === '' || a.reply === undefined) missing.push(command);
  }
  assert.deepEqual(missing, []);
});

test('reads are in the firmware\'s formats', () => {
  const s = fresh();
  assert.equal(answer(s, 'ver', ctx).reply, world.nodes[0].fw);
  assert.equal(answer(s, 'clock', ctx).reply, '12:05 - 23/11/2026 UTC');
  assert.equal(clockLine(Date.UTC(2026, 0, 5, 7, 9)), '07:09 - 5/1/2026 UTC');
  assert.match(answer(s, 'get radio', ctx).reply, /^\d+\.\d+,\d+(\.\d+)?,\d+,\d+$/);
  assert.deepEqual(parseNeighbors(answer(s, 'neighbors', ctx).reply), [{ prefix: 'ABABABAB', secsAgo: 90, snr: -4.5 }, { prefix: 'CDCDCDCD', secsAgo: 400, snr: 5.5 }]);
  assert.equal(answer(s, 'neighbors', { ...ctx, neighbours: [] }).reply, '-none-');
  assert.equal(answer(s, 'get mqtt.relay', ctx).reply, 'own');
});

test('a set changes the state, a get reads it back; an unknown command gets the firmware\'s answer', () => {
  const s = fresh();
  assert.equal(answer(s, 'set  txdelay   0.8', ctx).reply, 'OK');
  assert.equal(answer(s, 'get txdelay', ctx).reply, '0.8');
  assert.equal(answer(s, 'set name DEMO-Nytt', ctx).reply, 'OK');
  assert.equal(answer(s, 'get name', ctx).reply, 'DEMO-Nytt');
  assert.equal(answer(s, 'region home se05', ctx).reply, 'OK');
  assert.match(answer(s, 'region', ctx).reply, /^home se05,/);
  assert.equal(answer(s, 'frobnicate', ctx).reply, UNKNOWN);
  assert.equal(answer(s, 'get no.such.setting', ctx).reply, UNKNOWN);
  assert.equal(answer(s, 'set no.such.setting 1', ctx).reply, UNKNOWN);
  assert.equal(answer(s, 'reboot', ctx).reply, 'OK - rebooting');
  assert.equal(s.rebootUntil, NOW + 20000);
});
