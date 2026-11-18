// mcc3: the control plane keyed by the node and sealed to the owner (lou-20 and later). A port
// of mccontrol-cli's mccontrol/mcc3.py; the wire format is mccontrol-spec's
// docs/wire-format-mcc3.md and test/mcc3-vectors.json pins every function byte for byte.
//
//   S        X25519(node identity, owner command key)        the same from either side
//   K_cmd    HKDF-SHA256(S, salt empty, "mcc3/cmd/"   + KEY)  MQTT commands and results, mesh responses
//   K_mesh   HKDF-SHA256(S, salt empty, "mcc3/mesh/"  + KEY)  mesh requests (ChaCha20, no tag)
//   K_alive  HKDF-SHA256(S, salt empty, "mcc3/alive/" + KEY)  alive messages
//   signed   "mcc3/sig|" node key, road, flags, counter, expiry, RID (MQTT only), command
//
// KEY is the node's public key in upper-case hex. Every integer is little-endian; MQTT payloads
// are base64url without padding. The owner's side takes a key handle (lib/key/handle.js) and
// never a seed; the node's side (openCommand, openMeshRequest) is here for the vectors and the
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
export const INFO = Object.freeze({ cmd: 'mcc3/cmd/', mesh: 'mcc3/mesh/', alive: 'mcc3/alive/' });
export const ROAD_MQTT = 0x00;
export const ROAD_MESH = 0x01;
export const KIND = Object.freeze({ command: 0x43, result: 0x52, alive: 0x41 });
export const MESH_SUBTYPE = 0xc2;

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

// { cmd, mesh, alive }: three 32-byte keys from S and the node's key.
export function deriveKeys(secret, nodeKeyHex) {
  const node = keyHex(nodeKeyHex);
  const one = (info) => hkdf(sha256, secret, new Uint8Array(0), utf8(info + node), 32);
  return Object.freeze({ cmd: one(INFO.cmd), mesh: one(INFO.mesh), alive: one(INFO.alive) });
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
// resend of a counter must send these same bytes.
export function sealMeshRequest(handle, nodeKeyHex, counter, expiry, command, { companionTag = 0, keys = null } = {}) {
  const node = keyHex(nodeKeyHex);
  const data = commandBytes(command, MESH_MAX_COMMAND);
  const k = keys || ownerKeys(handle, node);
  const sig = handle.sign(signedBytes(node, ROAD_MESH, 0, counter, expiry, null, data));
  const plain = concat(u32(expiry), sig, data, new Uint8Array(MESH_COMMAND_FIELD - data.length));
  return concat(u32(companionTag), Uint8Array.of(MESH_SUBTYPE, 0), u32(counter), meshStream(k.mesh, counter, plain));
}

// The node's side, up to the signature: { tag, counter, expiry, command } or Refused.
export function openMeshRequest(nodeHandle, commandKeyHex, request, { lastCounter = null, keys = null } = {}) {
  if (request.length < MESH_REQUEST_LEN || request[4] !== MESH_SUBTYPE) throw new Refused('bad-fields');
  if (request[5] !== 0) throw new Refused('bad-version');
  const counter = readU32(request, 6);
  if (lastCounter !== null && lastCounter !== undefined && counter <= lastCounter) throw new Refused('replay');
  const k = keys || nodeKeys(nodeHandle, commandKeyHex);
  const plain = meshStream(k.mesh, counter, request.slice(MESH_HEADER, MESH_REQUEST_LEN));
  const expiry = readU32(plain, 0);
  const sig = plain.subarray(4, 68);
  const data = unpad(plain.subarray(68));
  if (!commandOk(data, MESH_MAX_COMMAND)) throw new Refused('command-chars');
  if (!verify(commandKeyHex, signedBytes(nodeHandle.publicKeyHex, ROAD_MESH, 0, counter, expiry, null, data), sig)) {
    throw new Refused('sig-invalid');
  }
  return { tag: readU32(request, 0), counter, expiry, command: lenient.decode(data) };
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
export function openMeshResponse(keys, response) {
  if (response.length < 4 + 1 + NONCE_LEN + 9 + TAG_LEN || response[4] !== KIND.result) throw new Refused('bad-fields');
  const header = response.subarray(4, 17);
  const plain = openAead(keys.cmd, header.subarray(1), header, response.subarray(17));
  return {
    tag: readU32(response, 0), counter: readU32(plain, 0), code: plain[4], clock: readU32(plain, 5),
    reply: lenient.decode(plain.subarray(9)),
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

// The fields of an alive message that opens under these keys, or Refused: one that does not
// open is another owner's node (or altered). An empty payload (the will) is the caller's.
export function openAlive(keys, payload) {
  const raw = unb64(payload);
  if (raw.length !== ALIVE_SIZE || raw[0] !== KIND.alive) throw new Refused('bad-fields');
  const header = raw.subarray(0, 13);
  const p = openAead(keys.alive, header.subarray(1), header, raw.subarray(13));
  const out = {};
  ALIVE_FIELDS.slice(0, 6).forEach((name, i) => { out[name] = readU32(p, 4 * i); });
  Object.assign(out, { flags: p[24], mesh: p[25], fingerprint: toHex(p.subarray(26, 30), true), via: p[30] });
  let at = 32;
  for (const name of ['version', 'region', 'name']) {
    const n = p[at];
    if (at + 1 + n > ALIVE_PLAIN) throw new Refused('bad-fields');
    out[name] = lenient.decode(p.subarray(at + 1, at + 1 + n));
    at += 1 + n;
  }
  return out;
}
