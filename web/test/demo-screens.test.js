// The demo's key doors (W-39d): once the demo's own key is in, nothing can make, change, show or copy
// a key, and locking leaves the demo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memoryStorage } from '../lib/key/storage.js';
import { startKeySession, keyring, closeDemoRing, DEMO_OPEN } from '../ui/screens/key-session.js';
import { demoWorld } from '../lib/demo/world.js';

test('the demo ring: the key signs, every other door is shut, lock leaves', async () => {
  const w = demoWorld();
  await startKeySession({ storage: memoryStorage(), credentials: null, storageManager: null, iterations: 1000 });
  const raw = keyring();
  const handle = await raw.importKey(w.owner.seedHex, w.owner.passphrase);
  assert.equal(handle.publicKeyHex.toUpperCase(), w.owner.key);
  await raw.setAutoLock(null);   // as the demo does; it also leaves no timer running
  let left = 0;
  const ring = closeDemoRing(() => { left += 1; }, 'Not in the demo');
  assert.equal(keyring(), ring);
  assert.equal(ring.handle().publicKeyHex.toUpperCase(), w.owner.key, 'the key still signs');
  assert.equal((await ring.status()).locked, false);
  const release = ring.hold();
  release();
  const doors = Object.keys(raw).filter((k) => typeof raw[k] === 'function' && k !== 'lock' && !DEMO_OPEN.includes(k));
  assert.ok(doors.length >= 8, `the keyring's other doors: ${doors.join(', ')}`);
  for (const door of doors) await assert.rejects(ring[door]('x', 'y'), /Not in the demo/, door);
  ring.lock();
  assert.equal(left, 1);
  assert.equal((await ring.status()).locked, false, 'locking does not lock: it leaves');
});

test('both languages have every demo string', () => {
  const read = (lang) => JSON.parse(readFileSync(new URL(`../i18n/${lang}.json`, import.meta.url), 'utf8'));
  const sv = read('sv'), en = read('en');
  const keys = Object.keys(en).filter((k) => k.startsWith('demo.'));
  assert.ok(keys.length >= 8);
  for (const k of keys) { assert.ok(sv[k], `sv ${k}`); assert.notEqual(sv[k], en[k] === 'Demo' ? null : en[k], k); }
});

// -- the read-only demo's second gate (W-39e) -----------------------------------------------------
import { createJobs } from '../lib/jobs/jobs.js';
import { memoryDb } from '../lib/store/db.js';
import { openStores } from '../lib/store/index.js';
import { rulesFrom } from '../lib/protocol/rules.js';
import { seedDemo } from '../lib/demo/world.js';
import { keyFromSeed } from '../lib/key/handle.js';
import { fromHex } from '../lib/bytes.js';

const json = (name) => JSON.parse(readFileSync(new URL(`../lib/data/${name}.json`, import.meta.url), 'utf8'));
const data = Object.fromEntries(['commands', 'cautions', 'denylist', 'facts', 'firmware', 'help', 'protocol', 'results', 'brokers', 'areas'].map((n) => [n, json(n)]));

async function demoJobs(readOnly) {
  const w = demoWorld();
  const handle = keyFromSeed(fromHex(w.owner.seedHex));
  const stores = openStores(memoryDb(), w.owner.key);
  await seedDemo(stores, w, { results: data.results });
  const touched = [];
  const never = (name) => async () => { touched.push(name); throw new Error(`${name} was reached`); };
  const jobs = createJobs({ ring: { handle: () => handle, hold: () => () => {}, touch() {} }, stores, rules: rulesFrom(data), brokers: data.brokers,
    results: data.results, readOnly, transport: { send: never('transport.send'), discover: never('transport.discover') },
    plane: { send: never('plane.send'), scan: never('plane.scan'), forward: never('plane.forward') }, meshSend: never('mesh') });
  return { jobs, w, touched };
}

test('read-only: every job that would sign, publish or read the plane refuses before it reaches a road', async () => {
  const { jobs, w, touched } = await demoJobs(true);
  const node = w.nodes[1].node;
  const attempts = {
    send: () => jobs.send({ command: 'ver', nodes: [node] }),
    runSet: () => jobs.runSet({ steps: ['ver'], nodes: [node] }),
    discover: () => jobs.discover({ region: 'JKG' }),
    discoverAlive: () => jobs.discoverAlive({}),
    refresh: () => jobs.refresh({ nodes: [node] }),
    update: () => jobs.update({ node, target: 'v1.18.0-lou-20' }),
    checkMeshNode: () => jobs.checkMeshNode({ candidate: { key: w.nodes[4].key, name: 'x' } }),
    checkNeighbours: () => jobs.checkNeighbours({ relay: w.nodes[0].node, target: w.nodes[4].node }),
  };
  assert.deepEqual(Object.keys(attempts).sort(), Object.keys(jobs).filter((k) => typeof jobs[k] === 'function' && k !== 'adopt').sort(), 'every job is tried');
  for (const [name, run] of Object.entries(attempts)) {
    let caught = null;
    try { const out = await run(); caught = out?.outcomes?.find?.((o) => o.reason?.code === 'demo') ? { code: 'demo' } : (out?.refused || out); } catch (e) { caught = e; }
    assert.equal(caught?.code ?? caught?.reason?.code ?? JSON.stringify(caught), 'demo', name);
  }
  assert.deepEqual(touched, [], 'no road was reached');
});

test('the same jobs, not read-only, do reach a road (so the gate above is what stopped them)', async () => {
  const { jobs, w, touched } = await demoJobs(false);
  await jobs.send({ command: 'ver', nodes: [w.nodes[1].node] }).catch(() => {});
  assert.ok(touched.length > 0);
});
