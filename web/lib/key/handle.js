// The only place a raw seed is turned into something that signs. Everything else -- protocol,
// UI -- receives a key handle and never sees the seed.
//
// A handle:
//   publicKeyHex           64 upper-case hex, what `set cmd.pubkey` takes
//   sign(bytes)            Ed25519 (RFC 8032, deterministic) signature, 64 bytes
//   sharedSecret(nodeHex)  MeshCore's ed25519_key_exchange with a node's public key, 32 bytes
//   sealLocal(bytes)       encrypt something this browser keeps beside the key (the mcc3 shared
//   openLocal(sealed)      secrets): ChaCha20-Poly1305 under HKDF(seed, "mccontrol-web/local"),
//                          so it opens only while this key is unlocked; openLocal throws on a forgery
//   forget()               zero the seed copy; every later call throws
//
// throwawayKey() is a handle on a fresh random seed: the broker login of one mcc3 session (IATA-2:
// the command key signs and seals, it never logs in), never stored.
//
// Storage, passphrase, unlock and auto-lock (W-5) wrap this; they hand out handles, not seeds.
import { ed25519, x25519 } from '../../vendor/noble-curves/ed25519.js';
import { hkdf } from '../../vendor/noble-hashes/hkdf.js';
import { sha256 } from '../../vendor/noble-hashes/sha2.js';
import { chacha20poly1305 } from '../../vendor/noble-ciphers/chacha.js';
import { concat, fromHex, toHex, utf8 } from '../bytes.js';

const LOCAL_INFO = 'mccontrol-web/local';

export function keyFromSeed(seedBytes) {
  if (!(seedBytes instanceof Uint8Array) || seedBytes.length !== 32) {
    throw new TypeError('a seed is 32 bytes');
  }
  let seed = Uint8Array.from(seedBytes);
  const publicKeyHex = toHex(ed25519.getPublicKey(seed), true);
  const live = () => {
    if (!seed) throw new Error('this key is locked');
    return seed;
  };
  return Object.freeze({
    publicKeyHex,
    sign: (bytes) => ed25519.sign(bytes, live()),
    // SHA-512(seed)[0:32], clamped by X25519, times the Montgomery u of the node's key.
    sharedSecret: (nodeKeyHex) => x25519.getSharedSecret(
      ed25519.utils.toMontgomerySecret(live()),
      ed25519.utils.toMontgomery(fromHex(nodeKeyHex)),
    ),
    sealLocal: (bytes) => {
      const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
      return concat(nonce, chacha20poly1305(hkdf(sha256, live(), new Uint8Array(0), utf8(LOCAL_INFO), 32), nonce).encrypt(bytes));
    },
    openLocal: (sealed) => chacha20poly1305(hkdf(sha256, live(), new Uint8Array(0), utf8(LOCAL_INFO), 32),
      sealed.subarray(0, 12)).decrypt(sealed.subarray(12)),
    forget() {
      if (seed) seed.fill(0);
      seed = null;
    },
  });
}

export const throwawayKey = () => keyFromSeed(globalThis.crypto.getRandomValues(new Uint8Array(32)));
