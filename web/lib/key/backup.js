// The key backup file, and the encryption of the seed at rest: one format for both, the same
// as the terminal tool's (mccontrol/keyfile.py), so a file moves both ways. Internal to
// lib/key: these functions take and return raw seeds; the rest of the app uses keyring.js.
//
//   { format: 'mccontrol-key-backup', version: 1, public_key: '<64 HEX>', created: '<ISO>',
//     kdf: { name: 'PBKDF2-SHA256', iterations: 600000, salt: '<16 bytes hex>' },
//     cipher: { name: 'AES-256-GCM', nonce: '<12 bytes hex>' },
//     ciphertext: '<32-byte seed + 16-byte tag, hex>' }
//
// Key: PBKDF2-HMAC-SHA256 over the NFC-normalised UTF-8 passphrase (WebCrypto). Additional
// data: format|version|kdf|iterations|salt|cipher|nonce|public_key, so a changed header fails
// like a wrong passphrase. `created` is informational and not bound.
import { keyFromSeed } from './handle.js';
import { fromHex, toHex, utf8 } from '../bytes.js';

export const FORMAT = 'mccontrol-key-backup';
export const VERSION = 1;
export const KDF = 'PBKDF2-SHA256';
export const CIPHER = 'AES-256-GCM';
export const ITERATIONS = 600000;
export const MAX_ITERATIONS = 10000000;
export const MIN_PASSPHRASE = 8;

const subtle = () => globalThis.crypto.subtle;

export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

const aad = (publicKey, iterations, saltHex, nonceHex) => utf8(
  [FORMAT, VERSION, KDF, iterations, saltHex, CIPHER, nonceHex, publicKey].join('|'));

async function deriveKey(passphrase, salt, iterations) {
  const secret = utf8(String(passphrase).normalize('NFC'));
  try {
    const base = await subtle().importKey('raw', secret, 'PBKDF2', false, ['deriveKey']);
    return await subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally {
    secret.fill(0);
  }
}

// The public key of a seed, without keeping a handle.
export function publicKeyOf(seed) {
  const handle = keyFromSeed(seed);
  handle.forget();
  return handle.publicKeyHex;
}

// The sealed record of `seed` (32 bytes) under `passphrase`. `salt`, `nonce`, `created` and
// `iterations` are for tests and the shared vectors; leave them out.
export async function sealSeed(seed, passphrase, {
  iterations = ITERATIONS, salt = randomBytes(16), nonce = randomBytes(12),
  created = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00'),
} = {}) {
  if (!passphrase) throw new Error('A backup needs a passphrase.');
  const publicKey = publicKeyOf(seed);
  const saltHex = toHex(salt);
  const nonceHex = toHex(nonce);
  const key = await deriveKey(passphrase, salt, iterations);
  const sealed = new Uint8Array(await subtle().encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad(publicKey, iterations, saltHex, nonceHex) }, key, seed));
  return {
    format: FORMAT, version: VERSION, public_key: publicKey, created,
    kdf: { name: KDF, iterations, salt: saltHex },
    cipher: { name: CIPHER, nonce: nonceHex },
    ciphertext: toHex(sealed),
  };
}

function hexField(value, size, what) {
  let raw = null;
  try { raw = fromHex(value); } catch { /* reported below */ }
  if (!raw || raw.length !== size) throw new Error(`The backup's ${what} is not ${size} bytes of hex.`);
  return raw;
}

// Checks a parsed backup's shape without a passphrase; returns its public key. Lets the UI show
// whose key a file holds before asking for the passphrase.
export function inspectBackup(data) {
  if (!data || typeof data !== 'object' || data.format !== FORMAT) {
    throw new Error('This is not an mccontrol key backup.');
  }
  if (data.version !== VERSION) {
    throw new Error(`A backup of version ${data.version}; this mccontrol reads version ${VERSION}.`);
  }
  const kdf = data.kdf || {};
  const cipher = data.cipher || {};
  if (kdf.name !== KDF || cipher.name !== CIPHER) {
    throw new Error(`The backup uses ${kdf.name}/${cipher.name}; this mccontrol reads ${KDF}/${CIPHER}.`);
  }
  if (!Number.isInteger(kdf.iterations) || kdf.iterations < 1 || kdf.iterations > MAX_ITERATIONS) {
    throw new Error("The backup's iteration count is out of range.");
  }
  hexField(data.public_key, 32, 'public key');
  hexField(kdf.salt, 16, 'salt');
  hexField(cipher.nonce, 12, 'nonce');
  hexField(data.ciphertext, 48, 'ciphertext');
  return data.public_key;
}

// The seed inside a backup (32 bytes; the caller zeroes it). A wrong passphrase and a changed
// file are refused alike: AES-GCM cannot tell them apart.
export async function openSealed(data, passphrase) {
  inspectBackup(data);
  const { kdf, cipher } = data;
  const key = await deriveKey(passphrase || '', fromHex(kdf.salt), kdf.iterations);
  let seed;
  try {
    seed = new Uint8Array(await subtle().decrypt({
      name: 'AES-GCM', iv: fromHex(cipher.nonce),
      additionalData: aad(data.public_key, kdf.iterations, kdf.salt, cipher.nonce),
    }, key, fromHex(data.ciphertext)));
  } catch {
    throw new Error('The passphrase is wrong, or the file was changed.');
  }
  if (publicKeyOf(seed) !== data.public_key) {
    seed.fill(0);
    throw new Error("The backup's public key does not match the key inside it.");
  }
  return seed;
}

// What a key file holds: `{ kind: 'backup', data, publicKey }` (a passphrase is still needed)
// or `{ kind: 'seed', seed }` (the 64 hex characters the terminal tool keeps in key.seed, or
// a seed pasted as text).
export function readKeyFile(text) {
  const body = String(text || '').trim();
  if (body.startsWith('{')) {
    let data;
    try { data = JSON.parse(body); } catch { throw new Error('The file is not valid JSON.'); }
    return { kind: 'backup', data, publicKey: inspectBackup(data) };
  }
  if (!/^[0-9a-fA-F]{64}$/.test(body)) {
    throw new Error('The file holds neither a backup nor the 64 hex characters of a seed.');
  }
  return { kind: 'seed', seed: fromHex(body) };
}
