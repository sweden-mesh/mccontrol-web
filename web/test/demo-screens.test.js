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
