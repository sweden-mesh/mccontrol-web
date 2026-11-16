// The only place a raw seed is turned into something that signs. Everything else -- protocol,
// UI -- receives a key handle and never sees the seed.
//
// A handle:
//   publicKeyHex           64 upper-case hex, what `set mqtt.cmd.pubkey` takes
//   sign(bytes)            Ed25519 (RFC 8032, deterministic) signature, 64 bytes
//   sharedSecret(nodeHex)  MeshCore's ed25519_key_exchange with a node's public key, 32 bytes
//   forget()               zero the seed copy; every later call throws
//
// Storage, passphrase, unlock and auto-lock (W-5) wrap this; they hand out handles, not seeds.
import { ed25519, x25519 } from '../../vendor/noble-curves/ed25519.js';
import { fromHex, toHex } from '../bytes.js';

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
    forget() {
      if (seed) seed.fill(0);
      seed = null;
    },
  });
}
