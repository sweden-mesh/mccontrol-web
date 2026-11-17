// The signed envelope the repeater firmware verifies: v1 (signed) and v2 (signed and
// encrypted, ar-13 and later). A port of mccontrol/envelope.py; test/vectors.json pins it
// byte for byte.
//
//   v1  payload  v1|<counter>|<expiry>|<command>|<128 hex Ed25519 signature>
//       signed   "<topic>\n" + "v1|<counter>|<expiry>|<command>"
//   v2  payload  v2|<counter>|<expiry>|<b64url(ChaCha20-Poly1305(command padded to 64 or 160),
//                AAD "v2|<counter>|<expiry>")>|<128 hex Ed25519 over "<topic>\n" + all before>
//       key      HKDF-SHA256(shared secret, salt empty, info "mccontrol-v2|" + topic, 32)
//       nonce    dir(1) | 00 x 7 | counter (4, big-endian); dir 00 command, 01 result
//
// Every function that signs or derives takes a key handle (lib/key/handle.js), never a seed.
import { hkdf } from '../../vendor/noble-hashes/hkdf.js';
import { sha256 } from '../../vendor/noble-hashes/sha2.js';
import { chacha20poly1305 } from '../../vendor/noble-ciphers/chacha.js';
import { concat, toHex, utf8 } from '../bytes.js';
import {
  DEFAULT_TTL_SECS, DIR_COMMAND, FIELD_SEP, MAX_COMMAND, MAX_FUTURE_SECS, MAX_PAYLOAD, MAX_TOPIC,
  TAG_LEN, V1, V2, V2_COMMAND_PADS, V2_INFO,
} from './constants.js';
import { nodeKey } from './topics.js';
import { b64url, codePoints, isPrintable } from './text.js';

const nowSecs = () => Math.floor(Date.now() / 1000);

function checkTtl(ttl) {
  if (!(Number.isInteger(ttl) && ttl > 0 && ttl <= MAX_FUTURE_SECS)) {
    throw new Error(`ttl is 1..${MAX_FUTURE_SECS} seconds`);
  }
}

// "v1|<counter>|<expiry>|<command>", after the checks a node makes of a command.
export function signedPart(counter, expiry, command) {
  if (command.includes(FIELD_SEP)) {
    throw new Error(`a command may not contain '${FIELD_SEP}'; for a region tree use 'region put' one name at a time`);
  }
  if (!isPrintable(command)) throw new Error('a command is printable text');
  const size = utf8(command).length;
  if (!command || size > MAX_COMMAND) throw new Error(`a command is 1..${MAX_COMMAND} bytes`);
  if (!(Number.isInteger(counter) && counter >= 0 && counter <= 0xffffffff)) {
    throw new Error('the counter must fit in 32 bits');
  }
  return `${V1}${FIELD_SEP}${counter}${FIELD_SEP}${expiry}${FIELD_SEP}${command}`;
}

// The bytes a signature covers: "<topic>\n<part>".
export function signedMessage(topic, part) {
  if (!topic || codePoints(topic) > MAX_TOPIC) throw new Error(`a topic is 1..${MAX_TOPIC} characters`);
  return utf8(`${topic}\n${part}`);
}

// One signed v1 envelope, as the payload string to publish (envelope.build).
export function buildV1(handle, topic, counter, command, { ttl = DEFAULT_TTL_SECS, now = nowSecs() } = {}) {
  checkTtl(ttl);
  const part = signedPart(counter, now + ttl, command);
  const signature = toHex(handle.sign(signedMessage(topic, part)), true);
  const payload = `${part}${FIELD_SEP}${signature}`;
  if (codePoints(payload) > MAX_PAYLOAD) {
    throw new Error(`the envelope is ${codePoints(payload)} bytes, over ${MAX_PAYLOAD}`);
  }
  return payload;
}

// The command-plane key for one node and one command topic.
export function v2Key(handle, nodeKeyHex, topic) {
  const node = nodeKeyHex ? nodeKey(nodeKeyHex) : null;
  if (!node) throw new Error("v2 needs the node's whole public key");
  return hkdf(sha256, handle.sharedSecret(node), new Uint8Array(0), utf8(V2_INFO + topic), 32);
}

export function v2Nonce(direction, counter) {
  const nonce = new Uint8Array(12);
  nonce[0] = direction;
  new DataView(nonce.buffer).setUint32(8, counter, false);
  return nonce;
}

// Zero-padded to the first size that holds it; null when none does.
export function pad(data, sizes) {
  for (const size of sizes) {
    if (data.length <= size) return concat(data, new Uint8Array(size - data.length));
  }
  return null;
}

export function seal(key, direction, counter, aad, plaintext) {
  return chacha20poly1305(key, v2Nonce(direction, counter), aad).encrypt(plaintext);
}

// The plaintext, or throws when the tag does not verify.
export function openSealed(key, direction, counter, aad, sealed) {
  if (sealed.length < TAG_LEN) throw new Error('too short');
  return chacha20poly1305(key, v2Nonce(direction, counter), aad).decrypt(sealed);
}

// One encrypted, signed v2 envelope for one node (envelope.build_v2). Broadcasts stay v1.
export function buildV2(handle, topic, counter, command, nodeKeyHex,
  { ttl = DEFAULT_TTL_SECS, now = nowSecs() } = {}) {
  checkTtl(ttl);
  const expiry = now + ttl;
  signedPart(counter, expiry, command);            // the same rules for the command as v1
  const head = `${V2}${FIELD_SEP}${counter}${FIELD_SEP}${expiry}`;
  const plain = pad(utf8(command), V2_COMMAND_PADS);
  const sealed = seal(v2Key(handle, nodeKeyHex, topic), DIR_COMMAND, counter, utf8(head), plain);
  const part = `${head}${FIELD_SEP}${b64url(sealed)}`;
  const signature = toHex(handle.sign(signedMessage(topic, part)), true);
  return `${part}${FIELD_SEP}${signature}`;
}

// Does this command put a packet on the air? The firmware refuses those as a broadcast.
export function isTransmit(command) {
  const head = command.trim().toLowerCase();
  return head === 'trigger' || head.startsWith('trigger ') || head.startsWith('trigger.');
}
