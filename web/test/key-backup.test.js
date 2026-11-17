// The backup file (lib/key/backup.js) against the terminal tool's (mccontrol/keyfile.py): the
// shared vector both ways, refusals, and the bare seed file the terminal tool keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ITERATIONS, openSealed, readKeyFile, sealSeed } from '../lib/key/backup.js';
import { fromHex, toHex } from '../lib/bytes.js';

const V = JSON.parse(readFileSync(new URL('./key-backup-vectors.json', import.meta.url), 'utf8'));
const copy = (o) => structuredClone(o);

test('sealing the vector in JS gives Python\'s file, byte for byte', async () => {
  const sealed = await sealSeed(fromHex(V.seed), V.passphrase, {
    iterations: V.iterations, salt: fromHex(V.salt), nonce: fromHex(V.nonce), created: V.created,
  });
  assert.deepEqual(sealed, V.sealed);
  assert.equal(JSON.stringify(sealed), JSON.stringify(V.sealed));   // same field order too
});

test('Python\'s file opens in JS, the passphrase normalised', async () => {
  assert.equal(toHex(await openSealed(V.sealed, V.passphrase)), V.seed);
  const nfd = V.passphrase.normalize('NFD');
  assert.notEqual(nfd, V.passphrase);
  assert.equal(toHex(await openSealed(V.sealed, nfd)), V.seed);
});

test('a fresh backup at the default cost round-trips and holds no seed', async () => {
  const seed = fromHex(V.seed);
  const sealed = await sealSeed(seed, 'correct horse');
  assert.ok(sealed.kdf.iterations === ITERATIONS && ITERATIONS >= 600000);
  assert.notEqual(sealed.kdf.salt, V.salt);
  assert.ok(!JSON.stringify(sealed).includes(V.seed));
  assert.equal(toHex(await openSealed(sealed, 'correct horse')), V.seed);
});

test('a wrong passphrase is refused', async () => {
  await assert.rejects(openSealed(V.sealed, `${V.passphrase}x`), /passphrase is wrong/);
  await assert.rejects(openSealed(V.sealed, ''), /passphrase is wrong/);
});

test('every changed field is refused', async () => {
  const changes = [
    (d) => { d.ciphertext = `${d.ciphertext.slice(0, -2)}00`; },
    (d) => { d.public_key = 'A'.repeat(64); },
    (d) => { d.kdf.salt = '00'.repeat(16); },
    (d) => { d.kdf.iterations += 1; },
    (d) => { d.cipher.nonce = '00'.repeat(12); },
  ];
  for (const change of changes) {
    const d = copy(V.sealed);
    change(d);
    await assert.rejects(openSealed(d, V.passphrase), /passphrase is wrong|changed/);
  }
});

test('malformed files are refused readably', async () => {
  for (const [d, re] of [
    [{ format: 'x' }, /not an mccontrol/],
    [{ ...copy(V.sealed), version: 2 }, /version 2/],
    [{ ...copy(V.sealed), kdf: { name: 'scrypt' } }, /reads PBKDF2/],
    [{ ...copy(V.sealed), kdf: { ...V.sealed.kdf, iterations: 1e9 } }, /out of range/],
    [{ ...copy(V.sealed), ciphertext: 'zz' }, /ciphertext/],
  ]) {
    await assert.rejects(openSealed(d, V.passphrase), re);
  }
});

test('a key file is a backup or the terminal tool\'s bare seed', () => {
  const backup = readKeyFile(JSON.stringify(V.sealed, null, 2));
  assert.equal(backup.kind, 'backup');
  assert.equal(backup.publicKey, V.sealed.public_key);
  const bare = readKeyFile(`${V.seed.toUpperCase()}\n`);      // what key.seed holds
  assert.equal(bare.kind, 'seed');
  assert.equal(toHex(bare.seed), V.seed);
  assert.throws(() => readKeyFile('hello'), /neither a backup/);
  assert.throws(() => readKeyFile('{nope'), /not valid JSON/);
});
