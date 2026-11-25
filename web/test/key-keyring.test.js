// The keyring (lib/key/keyring.js): create, import, unlock, lock, the backup file, the private key
// shown behind the passphrase, auto-lock on
// a fake clock, jobs that outlive a lock, persistence and fingerprint unlock with a fake passkey.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeyring, DEFAULT_AUTO_LOCK } from '../lib/key/keyring.js';
import { memoryStorage } from '../lib/key/storage.js';
import { openSealed } from '../lib/key/backup.js';
import { toHex, utf8 } from '../lib/bytes.js';

const V = JSON.parse(readFileSync(new URL('./key-backup-vectors.json', import.meta.url), 'utf8'));
const PASS = 'correct horse battery';
const MIN = 60000;

function fakeClock(start = Date.UTC(2026, 10, 17)) {
  let now = start;
  let next = 1;
  const due = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = next++; due.set(id, [now + ms, fn]); return id; },
    clearTimeout(id) { due.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const [id, [at, fn]] = [...due.entries()].sort((a, b) => a[1][0] - b[1][0])[0] || [null, [Infinity]];
        if (at > end) break;
        due.delete(id);
        now = at;
        fn();
      }
      now = end;
    },
  };
}

// A passkey with PRF: HMAC-SHA256 under a per-credential secret. `mode` 'none' returns no PRF
// bytes (as some Safari versions do), 'unstable' different bytes each time.
function fakePasskeys(mode = 'ok') {
  const secrets = new Map();
  let calls = 0;
  return {
    get calls() { return calls; },
    async create() {
      const id = crypto.getRandomValues(new Uint8Array(16));
      secrets.set(toHex(id), crypto.getRandomValues(new Uint8Array(32)));
      return { rawId: id.buffer };
    },
    async get({ publicKey }) {
      calls += 1;
      const id = toHex(publicKey.allowCredentials[0].id);
      const salt = publicKey.extensions.prf.eval.first;
      const secret = mode === 'unstable' ? crypto.getRandomValues(new Uint8Array(32)) : secrets.get(id);
      const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const first = await crypto.subtle.sign('HMAC', key, salt);
      return { getClientExtensionResults: () => (mode === 'none' ? {} : { prf: { results: { first } } }) };
    },
  };
}

function ring(options = {}) {
  const storage = options.storage || memoryStorage();
  const clock = options.clock || fakeClock();
  return { storage, clock, ring: createKeyring({ storage, clock, iterations: 1000, ...options }) };
}

test('a new key is unlocked, stored encrypted, and its public key is there at once', async () => {
  const { ring: r, storage } = ring();
  assert.equal((await r.status()).exists, false);
  await assert.rejects(r.create('short'), /at least 8/);
  const handle = await r.create(PASS);
  assert.equal(r.handle(), handle);
  assert.equal(handle.sign(utf8('x')).length, 64);
  const s = await r.status();
  assert.deepEqual([s.exists, s.locked, s.source, s.backup, s.autoLockMinutes], [true, false, 'created', null, DEFAULT_AUTO_LOCK]);
  assert.equal('gate' in s, false, 'no backup gate (operator 2026-11-17)');
  assert.equal(s.publicKeyHex, handle.publicKeyHex);
  const [record] = await storage.list();
  const seedHex = toHex(await openSealed(record.wraps.passphrase, PASS));
  assert.ok(!JSON.stringify(record).toLowerCase().includes(seedHex));
  assert.ok(!JSON.stringify(s).toLowerCase().includes(seedHex));
});

test('lock drops the handle; unlock needs the passphrase', async () => {
  const { ring: r } = ring();
  const first = await r.create(PASS);
  const pub = first.publicKeyHex;
  r.lock();
  assert.equal(r.handle(), null);
  assert.ok((await r.status()).locked);
  assert.throws(() => first.sign(utf8('x')), /locked/);
  await assert.rejects(r.unlock('wrong passphrase'), /passphrase is wrong/);
  assert.equal(r.handle(), null);
  assert.equal((await r.unlock(PASS)).publicKeyHex, pub);
});

test('the backup file needs the passphrase, opens anywhere, and is recorded', async () => {
  const { ring: r } = ring();
  const handle = await r.create(PASS);
  await assert.rejects(r.exportBackup('not it at all'), /passphrase is wrong/);
  assert.equal((await r.status()).backup, null);
  r.lock();                                                     // export works locked too
  const file = await r.exportBackup(PASS);
  assert.equal(file.filename, `mccontrol-key-${handle.publicKeyHex.slice(0, 8)}.json`);
  assert.equal((await r.status()).backup.form, 'file');
  const { ring: other } = ring();                              // another browser
  const again = await other.importKey(file.text, PASS);
  assert.equal(again.publicKeyHex, handle.publicKeyHex);
});

test('the private key is shown only to the right passphrase, locked or not', async () => {
  const { ring: r } = ring();
  await assert.rejects(r.revealSeed(PASS), /no key/);
  await r.importKey(JSON.stringify(V.sealed), V.passphrase);
  await assert.rejects(r.revealSeed('wrong passphrase'), /passphrase is wrong/);
  const hex = await r.revealSeed(V.passphrase);
  assert.match(hex, /^[0-9a-f]{64}$/);
  assert.equal(hex, toHex(await openSealed(V.sealed, V.passphrase)));
  r.lock();
  assert.equal(await r.revealSeed(V.passphrase), hex);
  assert.equal(r.handle(), null, 'showing it does not unlock');
  const { ring: other } = ring();                              // the shown text imports elsewhere
  assert.equal((await other.importKey(hex, PASS)).publicKeyHex, V.sealed.public_key);
});

test('one key per browser unless replaced', async () => {
  const { ring: r, storage } = ring();
  const old = await r.create(PASS);
  await assert.rejects(r.create(PASS), /already holds a key/);
  const fresh = await r.create(PASS, { replace: true });
  assert.notEqual(fresh.publicKeyHex, old.publicKeyHex);
  assert.deepEqual((await storage.list()).map((x) => x.id), [fresh.publicKeyHex]);
  assert.throws(() => old.sign(utf8('x')), /locked/);
});

test('importing the terminal tool\'s backup', async () => {
  const { ring: r } = ring();
  await assert.rejects(r.importKey(JSON.stringify(V.sealed), 'wrong passphrase'), /passphrase is wrong/);
  assert.equal((await r.status()).exists, false);
  const h = await r.importKey(JSON.stringify(V.sealed), V.passphrase);
  assert.equal(h.publicKeyHex, V.sealed.public_key);
  assert.deepEqual([(await r.status()).source, (await r.status()).backup], ['imported', null]);
  r.lock();
  assert.equal((await r.unlock(V.passphrase)).publicKeyHex, V.sealed.public_key);
});

test('importing a bare seed file, and a changed backup', async () => {
  const { ring: r } = ring();
  const changed = { ...structuredClone(V.sealed), ciphertext: '00'.repeat(48) };
  await assert.rejects(r.importKey(JSON.stringify(changed), V.passphrase), /changed/);
  const h = await r.importKey(`${V.seed}\n`, PASS);
  assert.equal(h.publicKeyHex, V.sealed.public_key);
  assert.equal((await r.status()).source, 'imported');
});

test('auto-lock after the chosen idle time; activity restarts it', async () => {
  const { ring: r, clock } = ring();
  await r.create(PASS);
  clock.advance(48 * 60 * MIN);                                  // the default: until the tab closes
  assert.ok(r.handle());
  await r.setAutoLock(15);
  clock.advance(14 * MIN);
  assert.ok(r.handle());
  r.touch();
  clock.advance(14 * MIN);
  assert.ok(r.handle());
  clock.advance(1 * MIN);
  assert.equal(r.handle(), null);

  await r.setAutoLock(5);
  await r.unlock(PASS);
  clock.advance(5 * MIN - 1);
  assert.ok(r.handle());
  clock.advance(1);
  assert.equal(r.handle(), null);

  await r.setAutoLock(null);                                   // until the tab closes
  await r.unlock(PASS);
  clock.advance(48 * 60 * MIN);
  assert.ok(r.handle());
  await assert.rejects(r.setAutoLock(30), /5, 15 or 60/);
  assert.equal((await r.status()).autoLockMinutes, null);
});

test('a sleeping tab whose timer never fired locks on the next touch', async () => {
  const clock = fakeClock();
  const frozen = { ...clock, setTimeout: () => 0, clearTimeout: () => {} };
  const { ring: r } = ring({ clock: frozen });
  await r.create(PASS);
  await r.setAutoLock(15);
  clock.advance(16 * MIN);
  assert.ok(r.handle());
  r.touch();
  assert.equal(r.handle(), null);
});

test('a running job keeps its key past a lock, and only until it ends', async () => {
  const { ring: r } = ring();
  const handle = await r.create(PASS);
  const release = r.hold();
  r.lock();
  assert.equal(r.handle(), null);                              // nothing new may start
  assert.throws(() => r.hold(), /locked/);
  assert.equal(handle.sign(utf8('step 2')).length, 64);       // the job finishes
  release();
  release();                                                   // twice is harmless
  assert.throws(() => handle.sign(utf8('step 3')), /locked/);
});

test('persistent storage is asked for and remembered', async () => {
  const { ring: r } = ring({ storageManager: { persist: async () => true } });
  await r.create(PASS);
  assert.equal((await r.status()).persist.granted, true);
  const { ring: bare } = ring();
  await bare.create(PASS);
  assert.equal((await bare.status()).persist.granted, null);   // the browser has no such API
  assert.equal(await bare.requestPersistence(), null);
});

test('fingerprint unlock: only after a real PRF answer, and the passphrase still works', async () => {
  const keys = fakePasskeys();
  const { ring: r } = ring({ credentials: keys });
  const pub = (await r.create(PASS)).publicKeyHex;
  await assert.rejects(r.enableFingerprint('wrong passphrase'), /passphrase is wrong/);
  await r.enableFingerprint(PASS);
  assert.equal(keys.calls, 2);                                 // the test sign-in and its check
  assert.ok((await r.status()).fingerprint);
  r.lock();
  assert.equal((await r.unlockWithFingerprint()).publicKeyHex, pub);
  r.lock();
  assert.equal((await r.unlock(PASS)).publicKeyHex, pub);
  await r.disableFingerprint();
  r.lock();
  await assert.rejects(r.unlockWithFingerprint(), /not set up/);
});

test('fingerprint unlock is refused when the browser gives no or a changing secret', async () => {
  for (const [mode, re] of [['none', /did not hand over/], ['unstable', /different secret|does not open/]]) {
    const { ring: r } = ring({ credentials: fakePasskeys(mode) });
    await r.create(PASS);
    await assert.rejects(r.enableFingerprint(PASS), re);
    assert.equal((await r.status()).fingerprint, false);
  }
  const { ring: none } = ring();
  await none.create(PASS);
  await assert.rejects(none.enableFingerprint(PASS), /cannot unlock with a fingerprint/);
});

test('changing the passphrase: the old one is needed, then only the new one unlocks', async () => {
  const { ring: r, storage, clock } = ring({ credentials: fakePasskeys() });
  const handle = await r.create(PASS);
  const key = handle.publicKeyHex;
  await r.enableFingerprint(PASS);
  const backup = await r.exportBackup(PASS);
  await assert.rejects(r.changePassphrase('wrong passphrase', 'a new passphrase'));
  await assert.rejects(r.changePassphrase(PASS, 'short'), /at least 8/);
  clock.advance(MIN);
  await r.changePassphrase(PASS, 'a new passphrase');
  const s = await r.status();
  assert.equal(s.passphraseChanged, new Date(clock.now()).toISOString());
  assert.equal(s.backup.form, 'file', 'the backup record is kept');
  assert.equal(s.fingerprint, true, 'the fingerprint copy is kept');
  assert.equal(s.locked, false, 'changing does not lock');
  r.lock();
  await assert.rejects(r.unlock(PASS));
  assert.equal((await r.unlock('a new passphrase')).publicKeyHex, key);
  // The backup saved before the change still opens with the old passphrase.
  assert.equal(toHex(await openSealed(JSON.parse(backup.text), PASS)).length, 64);
  const [record] = await storage.list();
  assert.equal(record.wraps.passphrase.public_key, key);
  r.lock();
  assert.equal((await r.unlockWithFingerprint()).publicKeyHex, key);
});

test('listeners hear lock and unlock', async () => {
  const { ring: r } = ring();
  let heard = 0;
  const stop = r.subscribe(() => { heard += 1; });
  await r.create(PASS);
  r.lock();
  stop();
  await r.unlock(PASS);
  assert.equal(heard, 2);
});

test('outside lib/key nothing imports the modules that handle raw seeds', () => {
  const WEB = fileURLToPath(new URL('..', import.meta.url));
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
  for (const f of walk(WEB)) {
    const rel = relative(WEB, f);
    if (/^(vendor|test)\b/.test(rel) || rel.startsWith(join('lib', 'key'))) continue;
    const src = readFileSync(f, 'utf8');
    assert.ok(!/key\/(backup|prf)\.js/.test(src), rel);
    if (rel !== join('ui', 'screens', 'key.js')) assert.ok(!/revealSeed/.test(src), `${rel}: only the key screen shows the private key`);
  }
});

test('another tab replaced the key: reconcile locks the old handle here (W-12)', async () => {
  const storage = memoryStorage();
  const { ring: here } = ring({ storage });
  const { ring: there } = ring({ storage });
  const old = await here.create(PASS);
  await there.unlock(PASS);
  await there.setAutoLock(5);
  await here.reconcile();
  assert.equal(here.handle(), old, 'the same key stays unlocked');
  assert.equal((await here.status()).autoLockMinutes, 5);
  await there.create(PASS, { replace: true });
  await here.reconcile();
  assert.equal(here.handle(), null);
  assert.throws(() => old.sign(utf8('x')), /locked/);
});

test('the mcc3 shared secrets are kept sealed beside the key, open only while it is unlocked (IATA2-MC4)', async () => {
  const storage = memoryStorage();
  const { ring: r } = ring({ storage });
  await r.create(PASS);
  assert.deepEqual(await r.loadSecrets(), {});
  const map = { ['A'.repeat(64)]: 'B'.repeat(64) };
  await r.saveSecrets(map);
  const [record] = await storage.list();
  assert.ok(!JSON.stringify(record).includes('B'.repeat(64)), 'no secret in the clear');
  assert.deepEqual(await r.loadSecrets(), map);
  r.lock();
  assert.deepEqual(await r.loadSecrets(), {}, 'locked: nothing opens');
  await r.saveSecrets({});
  await r.unlock(PASS);
  assert.deepEqual(await r.loadSecrets(), map, 'a locked save writes nothing');
  const forged = { ...(await storage.list())[0] };
  await storage.put({ ...forged, secrets: forged.secrets.replace(/^../, '00') });
  assert.deepEqual(await r.loadSecrets(), {}, 'an altered record opens to nothing');
});
