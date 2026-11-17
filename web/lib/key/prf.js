// Fingerprint/face unlock: a passkey's PRF output (WebAuthn's `prf` extension, 32 secret bytes
// released only after the owner's fingerprint or face) wraps a second copy of the seed. The
// passphrase copy always stays; losing the passkey loses only this shortcut. Internal to lib/key.
//
// `credentials` is the browser's `navigator.credentials` (a fake in tests). There is no
// server: the challenge is random and unchecked, because nothing here proves who signed in --
// the PRF bytes either open the wrap or they do not.
import { fromHex, toHex, utf8 } from '../bytes.js';
import { randomBytes } from './backup.js';

const subtle = () => globalThis.crypto.subtle;
const LABEL = 'mccontrol-key-prf';

const aad = (credentialId, publicKey) => utf8(`${LABEL}|1|${credentialId}|${publicKey}`);

async function wrapKey(prfBytes, publicKey) {
  const base = await subtle().importKey('raw', prfBytes, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(`${LABEL}|${publicKey}`) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// One sign-in with the passkey; its PRF output, or null when the browser returned none (it may
// claim support and still return nothing: Safari, some iOS versions).
async function prfOutput(credentials, credentialId, salt) {
  const assertion = await credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: [{ type: 'public-key', id: fromHex(credentialId) }],
      userVerification: 'required',
      timeout: 60000,
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  const first = assertion?.getClientExtensionResults?.()?.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

// Register a passkey and test it: the wrap is returned only after a real sign-in released PRF
// bytes and those bytes opened what they sealed. Throws a readable error otherwise.
export async function createPrfWrap(credentials, seed, publicKey, { userName = 'mccontrol', rpName = 'mccontrol' } = {}) {
  if (!credentials?.create || !credentials?.get) {
    throw new Error('This browser cannot unlock with a fingerprint or face.');
  }
  const credential = await credentials.create({
    publicKey: {
      rp: { name: rpName },
      user: { id: randomBytes(16), name: userName, displayName: userName },
      challenge: randomBytes(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 },
        { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      timeout: 60000,
      extensions: { prf: {} },
    },
  });
  if (!credential?.rawId) throw new Error('No passkey was made.');
  const credentialId = toHex(new Uint8Array(credential.rawId));
  const salt = randomBytes(32);
  const bytes = await prfOutput(credentials, credentialId, salt);
  if (!bytes) {
    throw new Error('The passkey works, but this browser did not hand over its secret, so it cannot unlock the key here. The passphrase still does.');
  }
  const nonce = randomBytes(12);
  const key = await wrapKey(bytes, publicKey);
  bytes.fill(0);
  const ciphertext = new Uint8Array(await subtle().encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad(credentialId, publicKey) }, key, seed));
  const wrap = { credentialId, salt: toHex(salt), nonce: toHex(nonce), ciphertext: toHex(ciphertext) };
  const check = await openPrfWrap(credentials, wrap, publicKey);  // a second sign-in: does it give the same bytes?
  const same = check.every((b, i) => b === seed[i]);
  check.fill(0);
  if (!same) throw new Error('The passkey gave a different secret the second time; it cannot unlock the key.');
  return wrap;
}

// The seed (32 bytes; the caller zeroes it) after a fingerprint or face sign-in.
export async function openPrfWrap(credentials, wrap, publicKey) {
  const bytes = await prfOutput(credentials, wrap.credentialId, fromHex(wrap.salt));
  if (!bytes) throw new Error('The passkey did not hand over its secret. Unlock with the passphrase.');
  const key = await wrapKey(bytes, publicKey);
  bytes.fill(0);
  try {
    return new Uint8Array(await subtle().decrypt(
      { name: 'AES-GCM', iv: fromHex(wrap.nonce), additionalData: aad(wrap.credentialId, publicKey) },
      key, fromHex(wrap.ciphertext)));
  } catch {
    throw new Error('That passkey does not open this key. Unlock with the passphrase.');
  }
}
