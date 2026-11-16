// The vendored noble libraries, through lib/key's handle, reproduce the Python package's bytes:
// the public key, a v1 signature, the v2 shared secret and key, and ChaCha20-Poly1305 both
// ways. The full protocol (W-3) builds on exactly these primitives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hkdf } from '../vendor/noble-hashes/hkdf.js';
import { sha256 } from '../vendor/noble-hashes/sha2.js';
import { chacha20poly1305 } from '../vendor/noble-ciphers/chacha.js';
import { keyFromSeed } from '../lib/key/handle.js';
import { concat, fromHex, fromUtf8, toHex, utf8 } from '../lib/bytes.js';

const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
const b64url = (text) => Uint8Array.from(Buffer.from(text, 'base64url'));

test('the public key matches', () => {
  assert.equal(keyFromSeed(fromHex(V.seed)).publicKeyHex, V.public_key);
  assert.equal(keyFromSeed(fromHex(V.node_seed)).publicKeyHex, V.node_key);
});

test('v1 signatures are byte-identical', () => {
  const key = keyFromSeed(fromHex(V.seed));
  for (const c of V.v1) {
    const sig = toHex(key.sign(utf8(c.signed)), true);
    assert.equal(c.payload, `${c.signed.slice(c.topic.length + 1)}|${sig}`);
  }
});

test('the v2 shared secret and key match, from both sides', () => {
  const k = V.v2_keys;
  const ours = keyFromSeed(fromHex(V.seed)).sharedSecret(V.node_key);
  const theirs = keyFromSeed(fromHex(V.node_seed)).sharedSecret(V.public_key);
  assert.equal(toHex(ours), k.shared_secret);
  assert.equal(toHex(theirs), k.shared_secret);
  const derived = hkdf(sha256, ours, new Uint8Array(0), utf8(`mccontrol-v2|${k.topic}`), 32);
  assert.equal(toHex(derived), k.key);
});

test('ChaCha20-Poly1305 opens the v2 commands and reseals them identically', () => {
  const key = fromHex(V.v2_keys.key);
  for (const c of V.v2) {
    const [tag, counter, expiry, sealedB64] = c.payload.split('|');
    const aad = utf8(`${tag}|${counter}|${expiry}`);
    const plain = chacha20poly1305(key, fromHex(c.nonce), aad).decrypt(b64url(sealedB64));
    const text = fromUtf8(plain).replace(/\0+$/, '');
    assert.equal(text, c.command);
    const again = chacha20poly1305(key, fromHex(c.nonce), aad).encrypt(plain);
    assert.equal(Buffer.from(again).toString('base64url'), sealedB64);
  }
});

test('a forgotten key signs nothing', () => {
  const key = keyFromSeed(fromHex(V.seed));
  key.forget();
  assert.throws(() => key.sign(utf8('x')), /locked/);
});

test('concat joins', () => {
  assert.deepEqual(concat(Uint8Array.of(1), Uint8Array.of(2, 3)), Uint8Array.of(1, 2, 3));
});
