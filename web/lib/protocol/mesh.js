// The mesh road: a signed command carried to one node over LoRa, through the owner's own
// companion radio. A port of mccontrol/mesh.py; test/vectors.json's `mesh` pins it byte for
// byte, and the firmware's host tests pin the same worked vector
// (planning/firmware/otm-wire-format-20261117.md).
//
// A MeshCore anonymous request (CMD_SEND_ANON_REQ, 57) to the node's key carries, after the
// companion's own 4-byte tag:
//
//   C1 | counter (4, LE) | expiry (4, LE) | Ed25519 signature (64, raw) | command (1..59, UTF-8)
//
// signed exactly as on MQTT: "<topic>\n" + "v1|<counter>|<expiry>|<command>", for the node's
// command topic with its WHOLE key -- meshcore/<IATA>/<KEY>/cmd, or meshcore/mesh/<KEY>/cmd on a
// mesh-only node, which has no IATA. One signature is valid on both roads, and the node keeps
// one counter, so whichever road delivers first runs it.
//
// The answer, after the tag: node clock (4, LE) | counter (4, LE) | code (1) | reply (UTF-8,
// maybe cut inside a character). It is encrypted to us and MAC'd by the node, so it is the
// node's own word (verified: true). Silence is never a refusal.
import { concat, fromHex, utf8 } from '../bytes.js';
import { DEFAULT_TTL_SECS, MAX_FUTURE_SECS, MESH, TOPIC_PREFIX } from './constants.js';
import { signedMessage, signedPart } from './envelope.js';
import { makeResult } from './results.js';
import { nodeKey } from './topics.js';

const nowSecs = () => Math.floor(Date.now() / 1000);

// Refuse a command the road cannot carry, before anything is signed or any radio opened.
export function checkCommand(command) {
  const size = utf8(command || '').length;
  if (size < 1 || size > MESH.max_command) {
    throw new Error(`over the mesh a command is 1..${MESH.max_command} bytes; this one is ${size}`);
  }
}

// The command topic the node rebuilds and the signature covers: always the whole key.
export function meshTopic(region, keyHex, meshOnly = false) {
  let key = null;
  try { key = nodeKey(keyHex || ''); } catch { key = null; }
  if (!key) {
    throw new Error("the mesh road needs the node's whole public key (64 hex); discover the node or add its key");
  }
  if (meshOnly) return `${TOPIC_PREFIX}${MESH.mesh_only_region}/${key}/cmd`;
  if (!region) throw new Error("the mesh road signs for the node's region; the device has none");
  return `${TOPIC_PREFIX}${String(region).toUpperCase()}/${key}/cmd`;
}

const u32 = (n) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
};

// The body the app gives CMD_SEND_ANON_REQ after the node's key: 73 bytes + the command.
export function meshRequest(handle, topic, counter, expiry, command) {
  checkCommand(command);
  if (!(Number.isInteger(expiry) && expiry >= 0 && expiry <= 0xffffffff)) throw new Error('the expiry must fit in 32 bits');
  const signature = handle.sign(signedMessage(topic, signedPart(counter, expiry, command)));
  return concat(Uint8Array.of(MESH.subtype), u32(counter), u32(expiry), signature, utf8(command));
}

// meshRequest with the expiry now + ttl, as the MQTT road takes it.
export function meshBuild(handle, topic, counter, command, { ttl = DEFAULT_TTL_SECS, now = nowSecs() } = {}) {
  if (!(Number.isInteger(ttl) && ttl > 0 && ttl <= MAX_FUTURE_SECS)) throw new Error(`ttl is 1..${MAX_FUTURE_SECS} seconds`);
  return meshRequest(handle, topic, counter, now + ttl, command);
}

// The whole companion command frame: 57, the node's 32-byte key, the body.
export const meshFrame = (keyHex, body) => concat(Uint8Array.of(MESH.cmd_send_anon_req), fromHex(nodeKey(keyHex)), body);

const lenient = new TextDecoder('utf-8');
const strict = new TextDecoder('utf-8', { fatal: true });

// UTF-8 that may have been cut inside a sequence: the whole characters only.
function wholeText(data) {
  for (let cut = 0; cut <= Math.min(4, data.length); cut += 1) {
    try { return strict.decode(data.subarray(0, data.length - cut)); } catch { /* one byte less */ }
  }
  return lenient.decode(data);
}

// A response as the companion hands it (after the tag) as a Result with `clock` (null when the
// node's clock is unset) and `road: 'mesh'`, or null when it is too short or answers another
// counter.
// The mesh hands a datagram over zero-filled to its 16-byte block edge.
function unfilled(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return bytes.subarray(0, end);
}

export function parseMeshResponse(data, { node = null, command = '', counter = null } = {}) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
  if (bytes.length < MESH.response_head) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const clock = view.getUint32(0, true);
  const got = view.getUint32(4, true);
  if (counter !== null && counter !== undefined && got !== counter) return null;
  const base = makeResult(node, got, bytes[8], command, wholeText(unfilled(bytes.subarray(9))), true);
  return Object.freeze({ ...base, clock: clock >= MESH.clock_set_from ? clock : null, road: 'mesh' });
}

// The bytes a node answers with after the tag; for tests and fakes.
export const meshResponse = (clock, counter, code, reply = '') => concat(u32(clock), u32(counter), Uint8Array.of(code), utf8(reply));
