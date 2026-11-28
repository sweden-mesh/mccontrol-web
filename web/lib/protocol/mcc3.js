// mcc3: the control plane keyed by the node and sealed to the owner (lou-20 and later). A port
// of mccontrol-cli's mccontrol/mcc3.py; the wire format is mccontrol-spec's
// docs/wire-format-mcc3.md and test/mcc3-vectors.json pins every function byte for byte.
//
//   S        X25519(node identity, owner command key)        the same from either side
//   K_cmd    HKDF-SHA256(S, salt empty, "mcc3/cmd/"   + KEY)  MQTT commands and results, mesh responses
//   K_mesh   HKDF-SHA256(S, salt empty, "mcc3/mesh/"  + KEY)  mesh requests (ChaCha20, no tag)
//   K_alive  HKDF-SHA256(S, salt empty, "mcc3/alive/" + KEY)  alive messages
//   K_fwd    HKDF-SHA256(S, salt empty, "mcc3/fwd/"   + KEY)  forwards through a relay, and their results
//   signed   "mcc3/sig|" node key, road, flags, counter, expiry, RID (MQTT only), command
//
// KEY is the node's public key in upper-case hex. Every integer is little-endian; MQTT payloads
// are base64url without padding. The owner's side takes a key handle (lib/key/handle.js) and
// never a seed; the node's side (openCommand, openMeshRequest, openForward) is here for the vectors and the
// test fakes, with a handle made from a node's seed. Nothing here connects or sends.
import { hkdf } from '../../vendor/noble-hashes/hkdf.js';
import { sha256 } from '../../vendor/noble-hashes/sha2.js';
import { chacha20, chacha20poly1305 } from '../../vendor/noble-ciphers/chacha.js';
import { ed25519 } from '../../vendor/noble-curves/ed25519.js';
import { concat, fromHex, toHex, utf8 } from '../bytes.js';
import { signedPart } from './envelope.js';
import { nodeKey } from './topics.js';
import { b64url, isPrintable, unb64url } from './text.js';

export const TOPIC_ROOT = 'mcc/';
export const SIG_LABEL = 'mcc3/sig|';
export const INFO = Object.freeze({ cmd: 'mcc3/cmd/', mesh: 'mcc3/mesh/', alive: 'mcc3/alive/', fwd: 'mcc3/fwd/' });
export const ROAD_MQTT = 0x00;
export const ROAD_MESH = 0x01;
export const KIND = Object.freeze({ command: 0x43, result: 0x52, alive: 0x41, forward: 0x46, forward_result: 0x66 });
export const MESH_SUBTYPE = 0xc2;
export const MESH_V1_SUBTYPE = 0xc1; // the lou-19 mesh request: a relay forwards it too
// Mesh requests only: answer once, directly, with an empty path. The delegation bit 0x01 stays refused.
export const FLAG_ZERO_HOP = 0x02;
export const MESH_FLAGS = Object.freeze([0, FLAG_ZERO_HOP]);

export const NONCE_LEN = 12;
export const TAG_LEN = 16;
export const SIG_LEN = 64;
export const RID_LEN = 16;
export const COMMAND_PADS = Object.freeze([64, 160]);
export const MAX_COMMAND = 160;
export const RESULT_PADS = Object.freeze([256, 512]);
export const ALIVE_PLAIN = 160;
export const COMMAND_SIZES = Object.freeze(COMMAND_PADS.map((p) => 2 + NONCE_LEN + 4 + 4 + RID_LEN + SIG_LEN + p + TAG_LEN));
export const RESULT_SIZES = Object.freeze(RESULT_PADS.map((p) => 1 + NONCE_LEN + p + TAG_LEN));
export const ALIVE_SIZE = 1 + NONCE_LEN + ALIVE_PLAIN + TAG_LEN;

// The mesh road (ANON_REQ sub-type 0xC2): 136 bytes, no AEAD tag (operator decision 2026-11-18).
export const MESH_REQUEST_LEN = 136;
export const MESH_COMMAND_FIELD = 58;
export const MESH_MAX_COMMAND = 57;
export const MESH_HEADER = 10;
export const MESH_MAX_REPLY = 125;

// A forward through a relay (mcc/cmd/<RELAY KEY>) and its result (mcc/r/<RID>), sealed under K_fwd.
export const ROUTES = Object.freeze({ direct: 0, flood: 1, 'flood-wide': 2 });
export const FORWARD_PATH = 57;
export const FORWARD_BODY = 132;
export const FORWARD_MIN_BODY = 74;
export const FORWARD_SIZE = 2 + NONCE_LEN + 4 + 4 + RID_LEN + 32 + 1 + 1 + FORWARD_PATH + 1 + FORWARD_BODY + TAG_LEN;
export const FORWARD_RESULT_PLAIN = 256;
export const FORWARD_RESULT_PATH = 64;
export const FORWARD_MAX_RESPONSE = 167;
export const FORWARD_RESULT_SIZE = 1 + NONCE_LEN + FORWARD_RESULT_PLAIN + TAG_LEN;
// 10..12 are lou-21's refusals of a guest forward, through a stranger's relay.
export const FORWARD_STATUSES = Object.freeze(['answered', 'no-answer', 'off', 'expired', 'replay', 'bad-body', 'busy',
  'rate-limited', 'clock-unset', 'send-failed', 'guest-cap', 'guests-full', 'target-cap']);
export const SENT = Object.freeze({ nothing: 0, direct: 1, flood: 2 });
export const SNR_NONE = 0x80;
export const PATH_NONE = 0xff;
export const FORWARD_MAX_TTL = 300; // a relay refuses an expiry further ahead of its clock
export const ALIVE_FLAG_RELAY = 0x10; // relaying is own, on an image that can relay

export const ALIVE_MAX = Object.freeze({ version: 31, region: 29, name: 32 });
export const ALIVE_FILTER = `${TOPIC_ROOT}alive/+`;

// A message could not be built. Never carries a key.
export class Mcc3Error extends Error {
  constructor(message) { super(message); this.name = 'Mcc3Error'; }
}

// A message did not open. `outcome` is the firmware's name for why (results.json).
export class Refused extends Error {
  constructor(outcome) { super(outcome); this.name = 'Refused'; this.outcome = outcome; }
}

const lenient = new TextDecoder('utf-8');

function keyHex(value) {
  let key = null;
  try { key = nodeKey(value || ''); } catch { key = null; }
  if (!key) throw new Mcc3Error('a node is named by its whole public key, 64 hex characters');
  return key;
}

function u32(value) {
  if (!(Number.isInteger(value) && value >= 0 && value <= 0xffffffff)) {
    throw new Mcc3Error('a counter, expiry or clock fits in 32 bits');
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

const readU32 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, true);

// -- keys ------------------------------------------------------------------------------------

// { cmd, mesh, alive, fwd }: four 32-byte keys from S and the node's key.
export function deriveKeys(secret, nodeKeyHex) {
  const node = keyHex(nodeKeyHex);
  const one = (info) => hkdf(sha256, secret, new Uint8Array(0), utf8(info + node), 32);
  return Object.freeze({ cmd: one(INFO.cmd), mesh: one(INFO.mesh), alive: one(INFO.alive), fwd: one(INFO.fwd) });
}

// The owner's side: the command key's handle and the node's key.
export function ownerKeys(handle, nodeKeyHex) {
  const node = keyHex(nodeKeyHex);
  return deriveKeys(handle.sharedSecret(node), node);
}

// The node's side: the node's identity handle and the owner's command key.
export function nodeKeys(nodeHandle, commandKeyHex) {
  return deriveKeys(nodeHandle.sharedSecret(keyHex(commandKeyHex)), nodeHandle.publicKeyHex);
}

// -- topics ----------------------------------------------------------------------------------

// A reply id: 16 random bytes, once per broker session.
export const newRid = () => globalThis.crypto.getRandomValues(new Uint8Array(RID_LEN));

export const commandTopic = (nodeKeyHex) => `${TOPIC_ROOT}cmd/${keyHex(nodeKeyHex)}`;
export const aliveTopic = (nodeKeyHex) => `${TOPIC_ROOT}alive/${keyHex(nodeKeyHex)}`;
export const pingTopic = (nodeKeyHex) => `${TOPIC_ROOT}ping/${keyHex(nodeKeyHex)}`;

export function replyTopic(rid) {
  if (!(rid instanceof Uint8Array) || rid.length !== RID_LEN) throw new Mcc3Error(`a reply id is ${RID_LEN} bytes`);
  return `${TOPIC_ROOT}r/${toHex(rid, true)}`;
}

// The node key of `mcc/cmd|alive|ping/<KEY>` (upper case as published), else null.
export function nodeFromTopic(topic) {
  const parts = String(topic || '').split('/');
  if (parts.length !== 3 || `${parts[0]}/` !== TOPIC_ROOT || !['cmd', 'alive', 'ping'].includes(parts[1])) return null;
  return /^[0-9A-F]{64}$/.test(parts[2]) ? parts[2] : null;
}

// -- helpers ---------------------------------------------------------------------------------

function unb64(payload) {
  const text = payload instanceof Uint8Array ? lenient.decode(payload) : String(payload ?? '');
  try { return unb64url(text); } catch { throw new Refused('bad-fields'); }
}

// The command as UTF-8 under today's character rule (printable, no '|', 1..160 bytes) and the road's limit.
function commandBytes(command, limit) {
  try { signedPart(0, 0, String(command ?? '')); } catch (e) { throw new Mcc3Error(e.message); }
  const data = utf8(command);
  if (data.length > limit) throw new Mcc3Error(`a command on this road is 1..${limit} bytes, this one is ${data.length}`);
  return data;
}

function commandOk(data, limit) {
  if (data.length < 1 || data.length > limit) return false;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return false; }
  return isPrintable(text) && !text.includes('|');
}

// Trailing zero bytes off (the padding).
function unpad(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return bytes.subarray(0, end);
}

// At most `limit` bytes, cut on a UTF-8 character boundary.
function cutUtf8(data, limit) {
  if (data.length <= limit) return data;
  let end = limit;
  while (end > 0 && (data[end] & 0xc0) === 0x80) end -= 1;
  return data.subarray(0, end);
}

function pad(data, sizes) {
  for (const size of sizes) if (data.length <= size) return concat(data, new Uint8Array(size - data.length));
  throw new Mcc3Error('too long');
}

const randomNonce = () => globalThis.crypto.getRandomValues(new Uint8Array(NONCE_LEN));
const asNonce = (nonce) => (nonce == null ? randomNonce() : (typeof nonce === 'string' ? fromHex(nonce) : nonce));

// What the command key signs. `rid` is null on the mesh road.
export function signedBytes(nodeKeyHex, road, flags, counter, expiry, rid, data) {
  return concat(utf8(SIG_LABEL), fromHex(keyHex(nodeKeyHex)), Uint8Array.of(road, flags), u32(counter), u32(expiry),
    rid || new Uint8Array(0), data);
}

function verify(publicHex, message, signature) {
  try { return ed25519.verify(signature, message, fromHex(publicHex)); } catch { return false; }
}

function openAead(key, nonce, aad, sealed) {
  try { return chacha20poly1305(key, nonce, aad).decrypt(sealed); } catch { throw new Refused('sig-invalid'); }
}

export const meshNonce = (counter) => concat(new Uint8Array(8), u32(counter));

// RFC 8439 ChaCha20 from block 1: ChaCha20-Poly1305's ciphertext without its tag.
const meshStream = (key, counter, data) => chacha20(key, meshNonce(counter), data, undefined, 1);

// -- command on MQTT (mcc/cmd/<KEY>) ---------------------------------------------------------

// The base64url payload for `mcc/cmd/<KEY>`. `nonce` is for the test vectors only.
export function sealCommand(handle, nodeKeyHex, counter, expiry, rid, command, { nonce = null, keys = null } = {}) {
  const node = keyHex(nodeKeyHex);
  const data = commandBytes(command, MAX_COMMAND);
  if (!(rid instanceof Uint8Array) || rid.length !== RID_LEN) throw new Mcc3Error(`a reply id is ${RID_LEN} bytes`);
  const k = keys || ownerKeys(handle, node);
  const n = asNonce(nonce);
  const sig = handle.sign(signedBytes(node, ROAD_MQTT, 0, counter, expiry, rid, data));
  const header = concat(Uint8Array.of(KIND.command, 0), n);
  const plain = concat(u32(counter), u32(expiry), rid, sig, pad(data, COMMAND_PADS));
  return b64url(concat(header, chacha20poly1305(k.cmd, n, header).encrypt(plain)));
}

// The node's side before its policy checks: { counter, expiry, rid, command }, or Refused with
// the outcome the node counts. Replay, expiry, deny list and rate limit are the node's.
export function openCommand(nodeHandle, commandKeyHex, payload, { keys = null } = {}) {
  const raw = unb64(payload);
  if (!COMMAND_SIZES.includes(raw.length) || raw[0] !== KIND.command) throw new Refused('bad-fields');
  if (raw[1] !== 0) throw new Refused('bad-version');
  const k = keys || nodeKeys(nodeHandle, commandKeyHex);
  const header = raw.subarray(0, 14);
  const plain = openAead(k.cmd, header.subarray(2), header, raw.subarray(14));
  const counter = readU32(plain, 0);
  const expiry = readU32(plain, 4);
  const rid = plain.slice(8, 24);
  const sig = plain.subarray(24, 88);
  const data = unpad(plain.subarray(88));
  if (!commandOk(data, MAX_COMMAND)) throw new Refused('command-chars');
  if (!verify(commandKeyHex, signedBytes(nodeHandle.publicKeyHex, ROAD_MQTT, 0, counter, expiry, rid, data), sig)) {
    throw new Refused('sig-invalid');
  }
  return { counter, expiry, rid, command: lenient.decode(data) };
}

// -- result on MQTT (mcc/r/<RID>) ------------------------------------------------------------

// What the node publishes on `mcc/r/<RID>`; for the vectors and the test fakes.
export function sealResult(keys, counter, code, clock, command, reply, { nonce = null } = {}) {
  const cmd = utf8(command);
  if (cmd.length > MAX_COMMAND) throw new Mcc3Error(`a command is at most ${MAX_COMMAND} bytes`);
  let body = concat(u32(counter), Uint8Array.of(code), u32(clock), Uint8Array.of(cmd.length), cmd);
  body = concat(body, cutUtf8(utf8(reply), RESULT_PADS[RESULT_PADS.length - 1] - body.length));
  const n = asNonce(nonce);
  const header = concat(Uint8Array.of(KIND.result), n);
  return b64url(concat(header, chacha20poly1305(keys.cmd, n, header).encrypt(pad(body, RESULT_PADS))));
}

// { counter, code, clock, command, reply }, or Refused('sig-invalid') when it does not open
// under these keys (another node's, or altered). The caller tries the keys of the nodes it
// awaits on this RID and matches the counter.
export function openResult(keys, payload) {
  const raw = unb64(payload);
  if (!RESULT_SIZES.includes(raw.length) || raw[0] !== KIND.result) throw new Refused('bad-fields');
  const header = raw.subarray(0, 13);
  const plain = openAead(keys.cmd, header.subarray(1), header, raw.subarray(13));
  const n = plain[9];
  if (n > MAX_COMMAND) throw new Refused('bad-fields');
  return {
    counter: readU32(plain, 0), code: plain[4], clock: readU32(plain, 5),
    command: lenient.decode(plain.subarray(10, 10 + n)), reply: lenient.decode(unpad(plain.subarray(10 + n))),
  };
}

// -- the mesh road (ANON_REQ sub-type 0xC2) --------------------------------------------------

// Refuse a command the 0xC2 road cannot carry, before anything is signed or any radio opened.
export function checkMeshCommand(command) {
  const size = utf8(command || '').length;
  if (size < 1 || size > MESH_MAX_COMMAND) {
    throw new Mcc3Error(`over the mesh a command to lou-20 and later is 1..${MESH_MAX_COMMAND} bytes; this one is ${size}`);
  }
}

// The 136-byte request, the companion's 4-byte tag first (the app sends the other 132). A
// resend of a counter must send these same bytes. `flags` is 0, or FLAG_ZERO_HOP in a request a
// relay sends straight to its neighbour; it is signed.
export function sealMeshRequest(handle, nodeKeyHex, counter, expiry, command, { companionTag = 0, keys = null, flags = 0 } = {}) {
  const node = keyHex(nodeKeyHex);
  const data = commandBytes(command, MESH_MAX_COMMAND);
  if (!MESH_FLAGS.includes(flags)) throw new Mcc3Error('a mesh request\'s flags are 0 or 0x02 (answer with zero hops)');
  const k = keys || ownerKeys(handle, node);
  const sig = handle.sign(signedBytes(node, ROAD_MESH, flags, counter, expiry, null, data));
  const plain = concat(u32(expiry), sig, data, new Uint8Array(MESH_COMMAND_FIELD - data.length));
  return concat(u32(companionTag), Uint8Array.of(MESH_SUBTYPE, flags), u32(counter), meshStream(k.mesh, counter, plain));
}

// The node's side, up to the signature: { tag, flags, counter, expiry, command } or Refused.
export function openMeshRequest(nodeHandle, commandKeyHex, request, { lastCounter = null, keys = null } = {}) {
  if (request.length < MESH_REQUEST_LEN || request[4] !== MESH_SUBTYPE) throw new Refused('bad-fields');
  const flags = request[5];
  if (!MESH_FLAGS.includes(flags)) throw new Refused('bad-version');
  const counter = readU32(request, 6);
  if (lastCounter !== null && lastCounter !== undefined && counter <= lastCounter) throw new Refused('replay');
  const k = keys || nodeKeys(nodeHandle, commandKeyHex);
  const plain = meshStream(k.mesh, counter, request.slice(MESH_HEADER, MESH_REQUEST_LEN));
  const expiry = readU32(plain, 0);
  const sig = plain.subarray(4, 68);
  const data = unpad(plain.subarray(68));
  if (!commandOk(data, MESH_MAX_COMMAND)) throw new Refused('command-chars');
  if (!verify(commandKeyHex, signedBytes(nodeHandle.publicKeyHex, ROAD_MESH, flags, counter, expiry, null, data), sig)) {
    throw new Refused('sig-invalid');
  }
  return { tag: readU32(request, 0), flags, counter, expiry, command: lenient.decode(data) };
}

// The node's response (not padded), sealed under K_cmd; for the vectors and the test fakes.
export function sealMeshResponse(keys, companionTag, counter, code, clock, reply, { nonce = null } = {}) {
  const rep = utf8(reply);
  if (rep.length > MESH_MAX_REPLY) throw new Mcc3Error(`a mesh reply is at most ${MESH_MAX_REPLY} bytes`);
  const n = asNonce(nonce);
  const header = concat(Uint8Array.of(KIND.result), n);
  const sealed = chacha20poly1305(keys.cmd, n, header).encrypt(concat(u32(counter), Uint8Array.of(code), u32(clock), rep));
  return concat(u32(companionTag), header, sealed);
}

// { tag, counter, code, clock, reply }, or Refused.
// MeshCore carries a datagram in whole 16-byte cipher blocks and hands it over zero-filled to
// the block edge, so up to 15 zero bytes may follow the response's tag: each shorter length is
// tried, and the tag says which one is the response.
export const MESH_BLOCK = 16;
export function openMeshResponse(keys, response) {
  const least = 4 + 1 + NONCE_LEN + 9 + TAG_LEN;
  if (response.length < least || response[4] !== KIND.result) throw new Refused('bad-fields');
  const header = response.subarray(4, 17);
  let end = response.length;
  for (let i = 0; i < MESH_BLOCK; i++) {
    let plain;
    try { plain = openAead(keys.cmd, header.subarray(1), header, response.subarray(17, end)); } catch (e) {
      if (!(e instanceof Refused) || response[end - 1] !== 0 || end - 1 < least) throw e;
      end -= 1;
      continue;
    }
    return {
      tag: readU32(response, 0), counter: readU32(plain, 0), code: plain[4], clock: readU32(plain, 5),
      reply: lenient.decode(plain.subarray(9)),
    };
  }
  throw new Refused('sig-invalid');
}

// -- a forward through a relay (mcc/cmd/<RELAY KEY>) and its result (mcc/r/<RID>) ------------

// How many bytes a MeshCore path length stands for (bits 6-7 hash size - 1, bits 0-5 hash
// count), or null when the size is the reserved one or the path does not fit `room`.
export function pathBytes(pathLen, room) {
  const size = (pathLen >> 6) + 1;
  const count = pathLen & 63;
  return size === 4 || size * count > room ? null : size * count;
}

const forwardBodyOk = (body) => (body[0] === MESH_SUBTYPE ? body.length === FORWARD_BODY
  : body[0] === MESH_V1_SUBTYPE && body.length >= FORWARD_MIN_BODY && body.length <= FORWARD_BODY);

// The base64url payload for `mcc/cmd/<RELAY KEY>` that has the relay transmit `body` (a mesh
// request from its sub-type byte on: the 132 bytes of a 0xC2, or a 0xC1) to the target. `keys`
// are the RELAY's: the AEAD under K_fwd is the whole proof, the request inside carries the
// owner's signature for the target. Refuses what a relay would answer `bad-body`. `pathField`
// is for the test vectors only.
export function sealForward(keys, relayKeyHex, counter, expiry, rid, targetKeyHex, route, body, opts = {}) {
  const n = asNonce(opts.nonce);
  const header = concat(Uint8Array.of(KIND.forward, 0), n);
  const plain = forwardPlain(relayKeyHex, counter, expiry, rid, targetKeyHex, route, body, opts);
  return b64url(concat(header, chacha20poly1305(keys.fwd, n, header).encrypt(plain)));
}

// The sealed body of a forward, the same for the owner's and a guest's.
function forwardPlain(relayKeyHex, counter, expiry, rid, targetKeyHex, route, body,
  { pathLen = 0, path = new Uint8Array(0), pathField = null } = {}) {
  const relay = keyHex(relayKeyHex);
  const target = keyHex(targetKeyHex);
  if (!(rid instanceof Uint8Array) || rid.length !== RID_LEN) throw new Mcc3Error(`a reply id is ${RID_LEN} bytes`);
  if (!Object.values(ROUTES).includes(route)) throw new Mcc3Error('a route is 0 (direct), 1 (flood) or 2 (flood-wide)');
  if (pathBytes(pathLen, FORWARD_PATH) !== path.length) {
    throw new Mcc3Error(`the path does not match its length byte, or is over ${FORWARD_PATH} bytes`);
  }
  if (!forwardBodyOk(body)) throw new Mcc3Error('a relay forwards a 0xC2 request of 132 bytes or a 0xC1 request of 74..132 bytes');
  if (target === relay) throw new Mcc3Error('a relay does not forward to itself');
  return concat(u32(counter), u32(expiry), rid, fromHex(target), Uint8Array.of(route, pathLen),
    pad(pathField || path, [FORWARD_PATH]), Uint8Array.of(body.length), pad(body, [FORWARD_BODY]));
}

// The relay's side, the checks that need no state: { counter, expiry, rid, target, route,
// pathLen, path, body } or Refused. `bad-fields` is "not a forward"; `bad-version` and
// `sig-invalid` are silent; `bad-body` is answered. The switch, the clock, the expiry, the
// replay guard and the budget are the relay's own. For the vectors and the test fakes.
export function openForward(relayHandle, commandKeyHex, payload, { keys = null } = {}) {
  const raw = unb64(payload);
  if (raw.length !== FORWARD_SIZE || raw[0] !== KIND.forward) throw new Refused('bad-fields');
  if (raw[1] !== 0) throw new Refused('bad-version');
  const k = keys || nodeKeys(relayHandle, commandKeyHex);
  const header = raw.subarray(0, 14);
  return forwardFields(relayHandle, openAead(k.fwd, header.subarray(2), header, raw.subarray(14)));
}

function forwardFields(relayHandle, p) {
  const target = toHex(p.subarray(24, 56), true);
  const route = p[56];
  const pathLen = p[57];
  const used = pathBytes(pathLen, FORWARD_PATH);
  const bodyLen = p[115];
  const body = p.slice(116, 116 + bodyLen);
  if (bodyLen > FORWARD_BODY || !forwardBodyOk(body) || !Object.values(ROUTES).includes(route) || used === null
    || target === relayHandle.publicKeyHex) throw new Refused('bad-body');
  return { counter: readU32(p, 0), expiry: readU32(p, 4), rid: p.slice(8, 24), target, route, pathLen,
    path: p.slice(58, 58 + used), body };
}

// What the relay publishes on `mcc/r/<RID>`; for the vectors and the test fakes. `snr` is in
// quarter-dB, null for none; `pathLen` null when the answer taught no path; `response` is the
// target's answer after its 4-byte tag.
export function sealForwardResult(keys, counter, status, clock,
  { sent = SENT.nothing, snr = null, pathLen = null, path = new Uint8Array(0), response = new Uint8Array(0), nonce = null } = {}) {
  if (pathLen !== null && pathBytes(pathLen, FORWARD_RESULT_PATH) !== path.length) {
    throw new Mcc3Error(`the path does not match its length byte, or is over ${FORWARD_RESULT_PATH} bytes`);
  }
  if (response.length > FORWARD_MAX_RESPONSE) throw new Mcc3Error(`a forwarded response is at most ${FORWARD_MAX_RESPONSE} bytes`);
  if (snr !== null && !(Number.isInteger(snr) && snr >= -127 && snr <= 127)) throw new Mcc3Error('an SNR is -127..127 quarter-dB');
  const plain = concat(u32(counter), Uint8Array.of(status), u32(clock),
    Uint8Array.of(sent, snr === null ? SNR_NONE : snr & 0xff, pathLen === null ? PATH_NONE : pathLen),
    pad(pathLen === null ? new Uint8Array(0) : path, [FORWARD_RESULT_PATH]), Uint8Array.of(response.length), response);
  const n = asNonce(nonce);
  const header = concat(Uint8Array.of(KIND.forward_result), n);
  return b64url(concat(header, chacha20poly1305(keys.fwd, n, header).encrypt(pad(plain, [FORWARD_RESULT_PLAIN]))));
}

// { counter, status, name, clock, sent, snr, pathLen, path, response } under the RELAY's keys,
// or Refused('sig-invalid') when it does not open under them (another relay's, or altered).
// `name` is the status in words (null for one not known here), `snr` quarter-dB or null,
// `pathLen` null when no path was taught. `response` is the target's answer after its tag:
// openMeshResponse(target keys, four zero bytes + response) for a 0xC2 request.
export function openForwardResult(keys, payload) {
  const raw = unb64(payload);
  if (raw.length !== FORWARD_RESULT_SIZE || raw[0] !== KIND.forward_result) throw new Refused('bad-fields');
  const header = raw.subarray(0, 13);
  const p = openAead(keys.fwd, header.subarray(1), header, raw.subarray(13));
  const pathLen = p[11];
  const used = pathLen === PATH_NONE ? 0 : pathBytes(pathLen, FORWARD_RESULT_PATH);
  const n = p[76];
  if (used === null || n > FORWARD_MAX_RESPONSE) throw new Refused('bad-fields');
  const status = p[4];
  return {
    counter: readU32(p, 0), status, name: FORWARD_STATUSES[status] ?? null, clock: readU32(p, 5), sent: p[9],
    snr: p[10] === SNR_NONE ? null : (p[10] << 24) >> 24, pathLen: pathLen === PATH_NONE ? null : pathLen,
    path: p.slice(12, 12 + used), response: p.slice(77, 77 + n),
  };
}

// -- alive (mcc/alive/<KEY>, retained) -------------------------------------------------------

export const ALIVE_FIELDS = Object.freeze(['boot', 'sequence', 'uptime', 'clock', 'last_counter', 'interval', 'flags',
  'mesh', 'fingerprint', 'via', 'version', 'region', 'name']);

const lp = (text, limit) => { const data = cutUtf8(utf8(text), limit); return concat(Uint8Array.of(data.length), data); };

// The node's alive payload; for the vectors and the test fakes. The region is folded to lower case.
export function sealAlive(keys, f, { nonce = null } = {}) {
  const plain = concat(u32(f.boot), u32(f.sequence), u32(f.uptime), u32(f.clock), u32(f.last_counter), u32(f.interval),
    Uint8Array.of(f.flags, f.mesh), fromHex(f.fingerprint), Uint8Array.of(f.via, 0),
    lp(f.version, ALIVE_MAX.version), lp(String(f.region).toLowerCase(), ALIVE_MAX.region), lp(f.name, ALIVE_MAX.name));
  const n = asNonce(nonce);
  const header = concat(Uint8Array.of(KIND.alive), n);
  return b64url(concat(header, chacha20poly1305(keys.alive, n, header).encrypt(pad(plain, [ALIVE_PLAIN]))));
}

// The fields of an alive message that opens under these keys (and `relay`: the node relays for
// its owner), or Refused: one that does not
// open is another owner's node (or altered). An empty payload (the will) is the caller's.
export function openAlive(keys, payload) {
  const raw = unb64(payload);
  if (raw.length !== ALIVE_SIZE || raw[0] !== KIND.alive) throw new Refused('bad-fields');
  const header = raw.subarray(0, 13);
  const p = openAead(keys.alive, header.subarray(1), header, raw.subarray(13));
  const out = {};
  ALIVE_FIELDS.slice(0, 6).forEach((name, i) => { out[name] = readU32(p, 4 * i); });
  Object.assign(out, { flags: p[24], mesh: p[25], fingerprint: toHex(p.subarray(26, 30), true), via: p[30],
    relay: Boolean(p[24] & ALIVE_FLAG_RELAY) });
  let at = 32;
  for (const name of ['version', 'region', 'name']) {
    const n = p[at];
    if (at + 1 + n > ALIVE_PLAIN) throw new Refused('bad-fields');
    out[name] = lenient.decode(p.subarray(at + 1, at + 1 + n));
    at += 1 + n;
  }
  return out;
}

// -- the signed announce and the shared node store (lou-21) ----------------------------------
//
// A node without Wi-Fi floods an announce over the mesh, signed with its own identity key. Any
// lou-21 Observer that hears it hands it to the command server, which keeps one entry per node,
// retained on `mcc/node/<KEY>`: the newest signed announce and the Observers that caught it
// (planning/firmware/otm10g-shared-store-design-20261127.md, sections 1 and 6).
//
//   K_malive  HKDF-SHA256(S, salt empty, "mcc3/malive/" + KEY)  the sealed part; KEY the announcing node's
//   owner tag SHA-256("mcc3/own|" command key, node key, boot, sequence)[0:4]
//   signature Ed25519 by the node over "mcc3/ann|" + bytes 1..100
//
// test/malive-vectors.json (the firmware's own, in mccontrol-spec from v0.6.0) pins the signed
// announces byte for byte; protocol.json's `mcc3_store` carries these constants.

export const INFO_MALIVE = 'mcc3/malive/';
export const OWN_LABEL = 'mcc3/own|';
export const ANN_LABEL = 'mcc3/ann|';
export const KIND_ANNOUNCE = 0x4d;
export const KIND_NODE = 0x4e;
export const ANNOUNCE_BODY = 101; // the announce before its signature: what sprint X07 flooded
export const ANNOUNCE_SIZE = ANNOUNCE_BODY + SIG_LEN; // 165
export const ANNOUNCE_SEALED = 47;
export const ANNOUNCE_TAG = 8; // the Poly1305 tag is cut to its first 8 bytes
export const ANNOUNCE_MAX = Object.freeze({ version: 14, name: 16 });
export const NODE_FILTER = `${TOPIC_ROOT}node/+`;
// 40 bytes a catcher.
export const NODE_CATCHER_SIZE = 40;
export const NODE_HEAD = 1 + ANNOUNCE_SIZE - 1 + 1; // kind, the announce from byte 1, the count
// How the catching Observer heard the announce: a zero-hop state packet, direct along a path, a flood.
export const VIA = Object.freeze({ zeroHop: 0, direct: 1, flood: 2 });

const labelled = (secret, info, nodeKeyHex) => hkdf(sha256, secret, new Uint8Array(0), utf8(info + keyHex(nodeKeyHex)), 32);

// K_malive, from S and the announcing node's key.
export const maliveKey = (secret, nodeKeyHex) => labelled(secret, INFO_MALIVE, nodeKeyHex);

export const nodeTopic = (nodeKeyHex) => `${TOPIC_ROOT}node/${keyHex(nodeKeyHex)}`;

// The node KEY of `mcc/node/<KEY>`, else null.
export function nodeEntryKey(topic) {
  const parts = String(topic || '').split('/');
  if (parts.length !== 3 || `${parts[0]}/` !== TOPIC_ROOT || parts[1] !== 'node') return null;
  return /^[0-9A-F]{64}$/.test(parts[2]) ? parts[2] : null;
}

// The four bytes by which an owner knows an announce is for its command key: one SHA-256.
export function ownerTag(commandKeyHex, nodeKeyHex, boot, sequence) {
  return sha256(concat(utf8(OWN_LABEL), fromHex(keyHex(commandKeyHex)), fromHex(keyHex(nodeKeyHex)), u32(boot), u32(sequence)))
    .subarray(0, 4);
}

const announceNonce = (boot, sequence) => concat(new Uint8Array(4), u32(boot), u32(sequence));
const u16 = (value) => Uint8Array.of(value & 0xff, (value >> 8) & 0xff);
const same = (a, b) => { let d = a.length ^ b.length; for (let i = 0; i < a.length && i < b.length; i += 1) d |= a[i] ^ b[i]; return d === 0; };
const i8 = (value) => (value << 24) >> 24;

// The first 101 bytes of an announce, unsigned; for the vectors, the test fakes and the demo.
// `key` is K_malive; f: { boot, sequence, uptime, clock, last_counter, flags, battery_mv, version, name }.
export function sealAnnounce(key, commandKeyHex, nodeKeyHex, f) {
  const node = fromHex(keyHex(nodeKeyHex));
  const plain = concat(u32(f.uptime), u32(f.clock), u32(f.last_counter), Uint8Array.of(f.flags), u16(f.battery_mv),
    lp(f.version, ANNOUNCE_MAX.version), lp(f.name, ANNOUNCE_MAX.name));
  const head = concat(node.subarray(0, 1), node, Uint8Array.of(KIND_ANNOUNCE), ownerTag(commandKeyHex, nodeKeyHex, f.boot, f.sequence),
    u32(f.boot), u32(f.sequence));
  const sealed = chacha20poly1305(key, announceNonce(f.boot, f.sequence), head.subarray(1)).encrypt(pad(plain, [ANNOUNCE_SEALED]));
  return concat(head, sealed.subarray(0, ANNOUNCE_SEALED + ANNOUNCE_TAG));
}

const announceSigned = (raw) => concat(utf8(ANN_LABEL), raw.subarray(1, ANNOUNCE_BODY));

// The 165 bytes a node floods: the 101 of sealAnnounce and the node's signature over them.
// `nodeHandle` is the node's identity (lib/key/handle.js); for the vectors, the fakes and the demo.
export function signAnnounce(nodeHandle, body) {
  if (!(body instanceof Uint8Array) || body.length !== ANNOUNCE_BODY) throw new Mcc3Error(`an unsigned announce is ${ANNOUNCE_BODY} bytes`);
  if (toHex(body.subarray(1, 33), true) !== nodeHandle.publicKeyHex.toUpperCase()) throw new Mcc3Error('an announce is signed by the node it names');
  return concat(body, nodeHandle.sign(announceSigned(body)));
}

// Is this a signed announce (size and kind)?
export const isAnnounce = (raw) => raw instanceof Uint8Array && raw.length === ANNOUNCE_SIZE && raw[33] === KIND_ANNOUNCE;

// Is the announce's owner tag this command key's? One SHA-256, no X25519.
export function announceIsFor(commandKeyHex, raw) {
  if (!isAnnounce(raw)) return false;
  return same(raw.subarray(34, 38), ownerTag(commandKeyHex, toHex(raw.subarray(1, 33), true), readU32(raw, 38), readU32(raw, 42)));
}

// Does the node named in the announce sign it?
export const announceSignatureOk = (raw) => isAnnounce(raw)
  && verify(toHex(raw.subarray(1, 33), true), announceSigned(raw), raw.subarray(ANNOUNCE_BODY, ANNOUNCE_SIZE));

// The fields of the first 101 bytes (and node_key), or Refused: 'not-announce' for another kind
// or a size under 101, 'other-owner' when its owner tag is not this command key's,
// 'does-not-open' when the seal does not verify under `key` (K_malive of the node it names). The
// tag on the wire is the Poly1305 tag's first 8 bytes: the whole tag is made again here and its
// start compared. The signature is not looked at: openAnnounce does that.
export function openAnnounceBody(key, commandKeyHex, raw) {
  if (!(raw instanceof Uint8Array) || (raw.length !== ANNOUNCE_BODY && raw.length !== ANNOUNCE_SIZE) || raw[33] !== KIND_ANNOUNCE) {
    throw new Refused('not-announce');
  }
  const node = toHex(raw.subarray(1, 33), true);
  const boot = readU32(raw, 38);
  const sequence = readU32(raw, 42);
  if (!same(raw.subarray(34, 38), ownerTag(commandKeyHex, node, boot, sequence))) throw new Refused('other-owner');
  const nonce = announceNonce(boot, sequence);
  const aad = raw.subarray(1, 46);
  const p = chacha20(key, nonce, raw.subarray(46, 46 + ANNOUNCE_SEALED), undefined, 1);
  const again = chacha20poly1305(key, nonce, aad).encrypt(p);
  if (!same(again.subarray(ANNOUNCE_SEALED, ANNOUNCE_SEALED + ANNOUNCE_TAG), raw.subarray(46 + ANNOUNCE_SEALED, ANNOUNCE_BODY))) {
    throw new Refused('does-not-open');
  }
  const out = { node_key: node, boot, sequence, uptime: readU32(p, 0), clock: readU32(p, 4), last_counter: readU32(p, 8),
    flags: p[12], battery_mv: p[13] | (p[14] << 8) };
  let at = 15;
  for (const name of ['version', 'name']) {
    const n = p[at];
    if (n > ANNOUNCE_MAX[name] || at + 1 + n > ANNOUNCE_SEALED) throw new Refused('bad-fields');
    out[name] = lenient.decode(p.subarray(at + 1, at + 1 + n));
    at += 1 + n;
  }
  return out;
}

// A signed announce, checked in the order the note gives: size and kind ('not-announce'), the
// owner tag ('other-owner', one SHA-256), the node's signature ('bad-signature', the firmware's word), then the seal
// ('does-not-open'). `key` is K_malive of the node it names.
export function openAnnounce(key, commandKeyHex, raw) {
  if (!isAnnounce(raw)) throw new Refused('not-announce');
  if (!announceIsFor(commandKeyHex, raw)) throw new Refused('other-owner');
  if (!announceSignatureOk(raw)) throw new Refused('bad-signature');
  return openAnnounceBody(key, commandKeyHex, raw);
}

// The retained entry of `mcc/node/<KEY>`, as the command server publishes it; for the test
// fakes and the demo. catchers: [{ key, arrival (server clock, s), snr (quarter dB), hops, via, list (0 current, 1 previous) }].
export function sealNodeEntry(announce, catchers = []) {
  if (!isAnnounce(announce)) throw new Mcc3Error(`a node entry holds a signed announce of ${ANNOUNCE_SIZE} bytes`);
  if (catchers.length > 255) throw new Mcc3Error('at most 255 catchers');
  return b64url(concat(Uint8Array.of(KIND_NODE), announce.subarray(1), Uint8Array.of(catchers.length),
    ...catchers.map((c) => concat(fromHex(keyHex(c.key)), u32(c.arrival), Uint8Array.of(c.snr & 0xff, c.hops, c.via, c.list)))));
}

// What a node entry says, unchecked (the caller tests the tag, then the signature, then the
// seal): { node_key, boot, sequence, announce (its 165 bytes, byte 0 rebuilt), report (the
// first 4 bytes of the signature, hex), catchers }, or Refused('bad-fields').
export function openNodeEntry(payload) {
  const raw = unb64(payload);
  if (raw.length < NODE_HEAD || raw[0] !== KIND_NODE) throw new Refused('bad-fields');
  const count = raw[NODE_HEAD - 1];
  if (raw.length !== NODE_HEAD + count * NODE_CATCHER_SIZE) throw new Refused('bad-fields');
  const announce = concat(raw.subarray(1, 2), raw.subarray(1, ANNOUNCE_SIZE));
  if (!isAnnounce(announce)) throw new Refused('bad-fields');
  const catchers = [];
  for (let i = 0; i < count; i += 1) {
    const at = NODE_HEAD + i * NODE_CATCHER_SIZE;
    catchers.push({ key: toHex(raw.subarray(at, at + 32), true), arrival: readU32(raw, at + 32), snr: i8(raw[at + 36]),
      hops: raw[at + 37], via: raw[at + 38], list: raw[at + 39] });
  }
  return { node_key: toHex(announce.subarray(1, 33), true), boot: readU32(announce, 38), sequence: readU32(announce, 42),
    announce, report: toHex(announce.subarray(ANNOUNCE_BODY, ANNOUNCE_BODY + 4), true), catchers };
}

// -- a guest forward: relaying through a stranger's Observer (lou-21, section 5) --------------
//
//   guest   the guest key: an Ed25519 key pair on the seed HKDF-SHA256(command seed, salt empty,
//           "mcc3/guestkey/") (handle.guest(), operator 2026-11-28, L21-G12), so a relay never sees
//           the owner's command key; made again each time, never stored, never shown
//   K_gfwd  HKDF-SHA256(X25519(guest key, relay identity), salt empty, "mcc3/gfwd/" + relay KEY, 64
//           upper-case hex characters as for mcc3/fwd/)
//   wire    'G' guest key (32) nonce (12) ChaCha20-Poly1305[K_gfwd](the body of a forward), AAD the 45 bytes before it
//
// The result comes back as a forward's does (openForwardResult), sealed under K_gfwd.

export const INFO_GFWD = 'mcc3/gfwd/';
export const KIND_GUEST_FORWARD = 0x47;
export const GUEST_FORWARD_SIZE = 1 + 32 + NONCE_LEN + (FORWARD_SIZE - 2 - NONCE_LEN);

// { fwd: K_gfwd } from S (the guest key with the relay) and the relay's key: the shape
// openForwardResult takes.
export const guestKeys = (secret, relayKeyHex) => Object.freeze({ fwd: labelled(secret, INFO_GFWD, relayKeyHex) });

// The base64url payload for `mcc/cmd/<RELAY KEY>` by which a guest (any guest key) has a
// stranger's relay transmit `body` to the target. Arguments as sealForward's, with the guest key
// (handle.guest(), never the command key) in clear.
export function sealGuestForward(keys, guestKeyHex, relayKeyHex, counter, expiry, rid, targetKeyHex, route, body, opts = {}) {
  const n = asNonce(opts.nonce);
  const header = concat(Uint8Array.of(KIND_GUEST_FORWARD), fromHex(keyHex(guestKeyHex)), n);
  const plain = forwardPlain(relayKeyHex, counter, expiry, rid, targetKeyHex, route, body, opts);
  return b64url(concat(header, chacha20poly1305(keys.fwd, n, header).encrypt(plain)));
}

// The relay's side, for the fakes and the demo: { guest, counter, expiry, rid, target, route,
// pathLen, path, body, keys } or Refused as openForward.
export function openGuestForward(relayHandle, payload) {
  const raw = unb64(payload);
  if (raw.length !== GUEST_FORWARD_SIZE || raw[0] !== KIND_GUEST_FORWARD) throw new Refused('bad-fields');
  const guest = toHex(raw.subarray(1, 33), true);
  let secret;
  try { secret = relayHandle.sharedSecret(guest); } catch { throw new Refused('sig-invalid'); }   // not a key
  const keys = guestKeys(secret, relayHandle.publicKeyHex);
  const header = raw.subarray(0, 45);
  return { guest, keys, ...forwardFields(relayHandle, openAead(keys.fwd, header.subarray(33), header, raw.subarray(45))) };
}
