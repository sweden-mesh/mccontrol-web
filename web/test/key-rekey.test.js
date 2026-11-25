// The keyring's second key (lib/key/keyring.js, `rekey*`): the next key of a replacement on the
// nodes is made, sealed, backed up, dropped or made the key here, and nowhere else is its seed seen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createKeyring } from '../lib/key/keyring.js';
import { memoryStorage } from '../lib/key/storage.js';
import { openSealed } from '../lib/key/backup.js';
import { keyFromSeed } from '../lib/key/handle.js';
import { copyStores, openStores } from '../lib/store/index.js';
import { memoryDb } from '../lib/store/db.js';
import { toHex, utf8 } from '../lib/bytes.js';

const PASS = 'correct horse battery';
const fast = { iterations: 1000 };

async function ringWithKey() {
  const storage = memoryStorage();
  const ring = createKeyring({ storage, ...fast });
  const handle = await ring.create(PASS);
  await ring.setAutoLock(null);
  return { storage, ring, inUse: handle.publicKeyHex };
}
const record = async (storage) => (await storage.list())[0];

test('start makes a second key, sealed twice, and the key in use stays the key', async () => {
  const { storage, ring, inUse } = await ringWithKey();
  assert.equal((await ring.status()).rekey, null);
  assert.equal(ring.rekeyHandle(), null);
  await assert.rejects(ring.rekeyStart('wrong passphrase'), /passphrase is wrong/);
  const next = await ring.rekeyStart(PASS);
  assert.match(next, /^[0-9A-F]{64}$/);
  assert.notEqual(next, inUse);
  const s = await ring.status();
  assert.equal(s.publicKeyHex, inUse);
  assert.deepEqual({ ...s.rekey, created: null }, { publicKeyHex: next, created: null, backup: null });
  assert.equal(ring.handle().publicKeyHex, inUse);
  assert.equal(ring.rekeyHandle().publicKeyHex, next);
  assert.equal((await storage.list()).length, 1, 'one record still');
  await assert.rejects(ring.rekeyStart(PASS), /already under way/);
  // Nothing stored is the seed: the record holds ciphertext, and the seed opens only with the passphrase.
  const r = await record(storage);
  const seed = await openSealed(r.next.wrap, PASS);
  assert.equal(keyFromSeed(seed).publicKeyHex, next);
  const stored = JSON.stringify(r);
  assert.ok(!stored.toUpperCase().includes(toHex(seed, true)), 'the seed is not in the record');
  assert.ok(!JSON.stringify(await ring.status()).toUpperCase().includes(toHex(seed, true)));
});

test('the next key signs whenever the key in use is unlocked, and is gone with a lock', async () => {
  const { ring } = await ringWithKey();
  const next = await ring.rekeyStart(PASS);
  const first = ring.rekeyHandle();
  const sig = first.sign(utf8('x'));
  ring.lock();
  assert.equal(ring.rekeyHandle(), null);
  assert.throws(() => first.sign(utf8('x')), /locked/, 'the handle that was handed out forgot its seed');
  await ring.unlock(PASS);
  assert.equal(ring.rekeyHandle().publicKeyHex, next);
  assert.deepEqual(ring.rekeyHandle().sign(utf8('x')), sig, 'the same key again');
});

test('a job that holds the key keeps the next key too until it lets go', async () => {
  const { ring } = await ringWithKey();
  await ring.rekeyStart(PASS);
  const next = ring.rekeyHandle();
  const release = ring.hold();
  ring.lock();
  assert.ok(next.sign(utf8('x')), 'still signs for the running job');
  release();
  assert.throws(() => next.sign(utf8('x')), /locked/);
});

test('the next key\'s backup file opens with the passphrase and is marked as saved', async () => {
  const { ring } = await ringWithKey();
  const next = await ring.rekeyStart(PASS);
  await assert.rejects(ring.rekeyBackup('wrong passphrase'), /passphrase is wrong/);
  assert.equal((await ring.status()).rekey.backup, null);
  const file = await ring.rekeyBackup(PASS);
  assert.equal(file.filename, `mccontrol-key-${next.slice(0, 8)}.json`);
  const seed = await openSealed(JSON.parse(file.text), PASS);
  assert.equal(keyFromSeed(seed).publicKeyHex, next);
  assert.equal((await ring.status()).rekey.backup.form, 'file');
  // A fresh browser takes that file as its key.
  const other = createKeyring({ storage: memoryStorage(), ...fast });
  assert.equal((await other.importKey(file.text, PASS)).publicKeyHex, next);
  other.lock();      // and its auto-lock timer with it
});

test('abort forgets the next key and nothing else', async () => {
  const { storage, ring, inUse } = await ringWithKey();
  await ring.rekeyStart(PASS);
  const next = ring.rekeyHandle();
  await ring.rekeyAbort();
  assert.equal((await ring.status()).rekey, null);
  assert.equal(ring.rekeyHandle(), null);
  assert.throws(() => next.sign(utf8('x')), /locked/);
  assert.equal((await record(storage)).next, undefined);
  assert.equal(ring.handle().publicKeyHex, inUse);
  await assert.rejects(ring.rekeyAbort(), /No key replacement/);
  await assert.rejects(ring.rekeyFinish(), /No key replacement/);
});

test('finish: the next key becomes the key, and the replaced one is kept sealed until the owner forgets it', async () => {
  const { storage, ring, inUse } = await ringWithKey();
  const old = ring.handle();
  const next = await ring.rekeyStart(PASS);
  await ring.rekeyBackup(PASS);
  let heard = 0;
  ring.subscribe(() => { heard += 1; });
  const handle = await ring.rekeyFinish();
  assert.ok(heard >= 1);
  assert.equal(handle.publicKeyHex, next);
  assert.equal(ring.handle(), handle);
  assert.equal(ring.rekeyHandle(), null);
  assert.throws(() => old.sign(utf8('x')), /locked/, 'the replaced key no longer signs here');
  const s = await ring.status();
  assert.equal(s.publicKeyHex, next);
  assert.equal(s.rekey, null);
  assert.equal(s.backup.form, 'file', 'the backup made during the round is the new key\'s');
  assert.deepEqual(s.replaced.map((r) => r.publicKeyHex), [inUse]);
  assert.equal((await storage.list()).length, 1);
  // The new key unlocks with the same passphrase.
  ring.lock();
  assert.equal((await ring.unlock(PASS)).publicKeyHex, next);
  // The replaced key: its backup file opens to the old key; forgetting it is a separate act.
  await assert.rejects(ring.replacedBackup(inUse, 'wrong passphrase'), /passphrase is wrong/);
  const file = await ring.replacedBackup(inUse, PASS);
  assert.equal(keyFromSeed(await openSealed(JSON.parse(file.text), PASS)).publicKeyHex, inUse);
  await ring.forgetReplaced(inUse);
  assert.deepEqual((await ring.status()).replaced, []);
  await assert.rejects(ring.replacedBackup(inUse, PASS), /No such replaced key/);
});

test('finish needs both keys unlocked', async () => {
  const { ring, inUse } = await ringWithKey();
  await ring.rekeyStart(PASS);
  ring.lock();
  await assert.rejects(ring.rekeyFinish(), /locked/);
  assert.equal((await ring.status()).publicKeyHex, inUse);
});

test('while a next key exists, making or importing another key outright is refused', async () => {
  const { ring, inUse } = await ringWithKey();
  await ring.rekeyStart(PASS);
  await assert.rejects(ring.create(PASS, { replace: true }), /Finish or abort/);
  await assert.rejects(ring.importKey('11'.repeat(32), PASS, { replace: true }), /Finish or abort/);
  assert.equal((await ring.status()).publicKeyHex, inUse);
  assert.ok((await ring.status()).rekey);
});

test('a changed passphrase follows the next key and the replaced ones', async () => {
  const { ring, inUse } = await ringWithKey();
  const next = await ring.rekeyStart(PASS);
  const NEW = 'another long passphrase';
  await ring.changePassphrase(PASS, NEW);
  await assert.rejects(ring.rekeyBackup(PASS), /passphrase is wrong/);
  await ring.rekeyBackup(NEW);
  await ring.rekeyFinish();
  ring.lock();
  assert.equal((await ring.unlock(NEW)).publicKeyHex, next);
  const LAST = 'a third long passphrase';
  await ring.changePassphrase(NEW, LAST);
  const file = await ring.replacedBackup(inUse, LAST);
  assert.equal(keyFromSeed(await openSealed(JSON.parse(file.text), LAST)).publicKeyHex, inUse);
});

test('another tab started or ended a replacement: reconcile follows it', async () => {
  const storage = memoryStorage();
  const a = createKeyring({ storage, ...fast });
  const b = createKeyring({ storage, ...fast });
  await a.create(PASS);
  await b.unlock(PASS);
  const next = await a.rekeyStart(PASS);
  assert.equal(b.rekeyHandle(), null);
  await b.reconcile();
  assert.equal(b.rekeyHandle().publicKeyHex, next);
  await a.rekeyFinish();
  await b.reconcile();
  assert.equal(b.handle(), null, 'the replaced key is no longer the stored key: locked');
  assert.equal(b.rekeyHandle(), null);
  for (const r of [a, b]) r.lock();
});

test('the demo takes an invented next key instead of making one, and refuses the key in use', async () => {
  const { ring } = await ringWithKey();
  const seedHex = '5A'.repeat(32);
  assert.equal(await ring.rekeyStart(PASS, { seedHex }), keyFromSeed(Uint8Array.from(Buffer.from(seedHex, 'hex'))).publicKeyHex);
  await ring.rekeyAbort();
  const own = createKeyring({ storage: memoryStorage(), ...fast });
  await own.importKey(seedHex, PASS);
  await assert.rejects(own.rekeyStart(PASS, { seedHex }), /key in use/);
  assert.equal((await own.status()).rekey, null);
  own.lock();
});

// -- the owner's data follows the key (lib/store copyStores) ------------------------------------

test('finish copies the nodes, their counters, groups, sets and history to the new key, without the old alive', async () => {
  const db = memoryDb();
  const A = 'A1'.repeat(32), B = 'B2'.repeat(32), NODE = 'C3'.repeat(32);
  const from = openStores(db, A);
  await from.devices.add({ node: NODE, key: NODE, name: 'TEST-one' });
  await from.devices.update(NODE.slice(0, 8), { ver: 'v1.18.0-lou-20-arrc-observer-0', alive: { state: 'online', at: new Date().toISOString(), last_counter: 5 } });
  const counter = await from.devices.nextCounter(NODE.slice(0, 8));
  await from.groups.create('test', [NODE.slice(0, 8)]);
  await from.history.append({ node: NODE.slice(0, 8), command: 'ver', code: 0, reply: 'x', verified: true });
  await from.meta.set('rekey', { v: 1 });
  await from.meta.set('lastVisit', 'yesterday');
  await copyStores(db, A, B, { skipMeta: ['rekey'] });
  const to = openStores(db, B);
  const [d] = await to.devices.list();
  assert.deepEqual([d.name, d.key, d.counter, d.ver, d.owner], ['TEST-one', NODE, counter, 'v1.18.0-lou-20-arrc-observer-0', B]);
  assert.equal(d.alive, undefined, 'the alive was sealed to the replaced key');
  assert.ok(await to.devices.nextCounter(d.node) > counter, 'the node\'s counter goes on, it does not start over');
  assert.deepEqual((await to.groups.list()).map((g) => g.id), ['test']);
  assert.equal((await to.history.list()).length, 1);
  assert.equal(await to.meta.get('lastVisit'), 'yesterday');
  assert.equal(await to.meta.get('rekey'), undefined, 'the round stays behind');
  assert.equal((await from.devices.list()).length, 1, 'the replaced key keeps its own');
  await assert.rejects(copyStores(db, A, A), /two 64-hex/);
});

// -- the strings ---------------------------------------------------------------------------------

test('every rekey string is in both languages, is used by the screen, and the Swedish has no dashes for commas', () => {
  const read = (lang) => JSON.parse(readFileSync(new URL(`../i18n/${lang}.json`, import.meta.url), 'utf8'));
  const sv = read('sv'), en = read('en');
  const src = readFileSync(new URL('../ui/screens/key-rekey.js', import.meta.url), 'utf8');
  const keys = Object.keys(en).filter((k) => k.startsWith('rekey.'));
  assert.ok(keys.length >= 40);
  for (const k of keys) {
    assert.ok(sv[k], `sv ${k}`);
    assert.ok(!/[—–]/.test(sv[k]) && !/[—–]/.test(en[k]), `${k}: no dash`);
    const family = k.split('.').slice(0, 2).join('.');
    assert.ok(src.includes(`'${k}'`) || src.includes(`\`${family}.\${`), `${k} is used`);
  }
  for (const m of src.matchAll(/t\('(rekey\.[A-Za-z.]+)'/g)) assert.ok(en[m[1]], `${m[1]} exists`);
});
