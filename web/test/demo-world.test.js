// The demo's world (W-39b): invented, the same every time, and made only of things the tool knows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { demoWorld, demoHistory, seedDemo, aliveOf, neighboursOf, DEMO_REGION } from '../lib/demo/world.js';
import { memoryDb } from '../lib/store/db.js';
import { openStores } from '../lib/store/index.js';
import { rulesFrom } from '../lib/protocol/rules.js';
import { relayRefusal } from '../lib/jobs/relay.js';
import { scheme } from '../lib/jobs/scheme.js';

const json = (name) => JSON.parse(readFileSync(new URL(`../lib/data/${name}.json`, import.meta.url), 'utf8'));
const data = Object.fromEntries(['commands', 'cautions', 'denylist', 'facts', 'firmware', 'help', 'protocol', 'results', 'brokers', 'areas'].map((n) => [n, json(n)]));
const rules = rulesFrom(data);
const NOW = Date.UTC(2026, 10, 23, 12);

test('the world is the same on every call, and its keys are whole and distinct', () => {
  const a = demoWorld(), b = demoWorld();
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  const keys = [a.owner.key, ...a.nodes.map((n) => n.key)];
  for (const k of keys) assert.match(k, /^[0-9A-F]{64}$/);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(new Set(a.nodes.map((n) => n.node)).size, a.nodes.length);
});

test('every name says DEMO and none has the form of a real node name', () => {
  for (const n of demoWorld().nodes) {
    assert.match(n.name, /^DEMO-/);
    assert.doesNotMatch(n.name, /^SE[-0-9]/);
    assert.ok(new TextEncoder().encode(n.name).length <= 31, n.name);
  }
});

test('the fleet shows every kind of node the screens know', () => {
  const kinds = demoWorld().nodes.map((n) => n.kind).sort();
  for (const k of ['relay', 'wifi', 'mesh', 'offline', 'old', 'never']) assert.ok(kinds.includes(k), k);
});

test('the history uses only commands and result codes the tool knows', () => {
  const world = demoWorld();
  const texts = data.commands.table.map((c) => c.text);
  for (const e of demoHistory(world)) {
    if (e.code !== null) assert.ok(String(e.code) in data.results.codes, `code ${e.code}`);
    if (e.code === 14) continue;   // the one refused by the deny list is, by design, not in the table
    assert.ok(texts.some((t) => e.command === t || e.command.startsWith(`${t} `)), `command ${e.command}`);
    assert.equal(rules.refusal(e.command), null, `${e.command} is admitted`);
  }
  const refused = demoHistory(world).find((e) => e.code === 14);
  assert.ok(rules.refusal(refused.command), 'the refused command is one the deny list refuses');
});

test('seeded stores: the relay can relay now, the mesh-only node is one, the old node speaks the old plane', async () => {
  const world = demoWorld();
  const stores = openStores(memoryDb(), world.owner.key, { now: () => NOW });
  await seedDemo(stores, world, { now: NOW, results: data.results });
  const devices = await stores.devices.list();
  assert.equal(devices.length, world.nodes.length);
  const by = (name) => devices.find((d) => d.name === name);
  assert.equal(relayRefusal(rules, by('DEMO-Kvarnberget'), by('DEMO-Granbo'), NOW), null);
  assert.equal(relayRefusal(rules, by('DEMO-Vattentornet'), by('DEMO-Granbo'), NOW)?.code, 'relayOff');
  assert.equal(rules.deviceMeshOnly(by('DEMO-Granbo')), true);
  assert.equal(scheme(rules, by('DEMO-Lövåsen')), 'old');
  assert.equal(scheme(rules, by('DEMO-Rosenlund')), 'mcc3');
  assert.equal(by('DEMO-Torpa').alive.state, 'offline');
  assert.equal(by('DEMO-Hagen').lastHeard, null);
  assert.equal(by('DEMO-Ekbacken').lastResult.codeName, 'not-allowed');
  assert.equal((await stores.groups.list()).length, 2);
  assert.ok((await stores.history.list()).length >= 20);
});

test('alive and neighbours come from the world alone', () => {
  const world = demoWorld();
  const k = world.nodes[0];
  assert.equal(aliveOf(world, k, NOW).region, DEMO_REGION);
  assert.ok(neighboursOf(world, k).length >= 2);
  assert.ok(!neighboursOf(world, k).some((m) => m.kind === 'offline' || m.heard === null));
});
