// One signed command to one node over the mesh, through an open companion (companion.js). A
// port of mccontrol/mesh.py's send and _send: the 59-byte check and the topic come before any
// signing; the node is looked up as a contact and added when it is not one (with no path, so
// the first request floods and the node's path return teaches the companion one); the request
// goes; the answer is waited for by its tag.
//
//   const out = await sendOverMesh({ companion, handle, keyHex, region, meshOnly, name, command,
//     counter, ttl, waitSecs, progress, signal })
//   out = { topic, body, result | null, info: { contact: 'known' | 'added', path: 'flood' | 'direct, N hop(s)' } }
//
// With `keys` (the node's mcc3 keys, IATA-2) the request is lou-20's 0xC2 instead: sealed to the
// node under K_mesh with a 57-byte command, its answer opened under K_cmd; the topic named is
// `mcc/cmd/<KEY>`, never a region. The companion can read neither.
//
// `progress(elapsedSecs, totalSecs)` is called through the wait; returning true stops it. A
// result of null is silence: never a refusal (a replay, a bad signature, a node without the
// road, a closed road or its budget all say nothing).
import { checkCommand, meshBuild, meshTopic, parseMeshResponse } from '../protocol/mesh.js';
import { checkMeshCommand, commandTopic as mcc3Topic, openMeshResponse, sealMeshRequest } from '../protocol/mcc3.js';
import { makeResult } from '../protocol/results.js';
import { concat } from '../bytes.js';
import { nodeKey } from '../protocol/topics.js';
import { DEFAULT_TTL_SECS, MESH } from '../protocol/constants.js';
import { CompanionError } from './companion.js';

const TICK_MS = 200;

export async function sendOverMesh({
  companion, handle, keyHex, region, meshOnly = false, name = '', command, counter = null,
  ttl = DEFAULT_TTL_SECS, waitSecs = 30, progress = null, signal = null, now = () => Date.now(), keys = null,
}) {
  if (keys) checkMeshCommand(command); else checkCommand(command);
  const topic = keys ? mcc3Topic(keyHex) : meshTopic(region, keyHex, meshOnly);
  const key = nodeKey(keyHex);
  if (!companion || companion.closed) throw new CompanionError('no companion is connected', 'closed');
  const count = counter ?? Math.floor(now() / 1000);
  const body = keys
    ? sealMeshRequest(handle, key, count, Math.floor(now() / 1000) + ttl, command, { keys }).subarray(4)
    : meshBuild(handle, topic, count, command, { ttl, now: Math.floor(now() / 1000) });
  const info = {};
  let c = await companion.contact(key);
  if (c === null) {
    if (!(await companion.addContact(key, name))) {
      throw new CompanionError('the companion would not take the node as a contact (its contact list may be full)', 'full');
    }
    info.contact = 'added';
    c = { hops: -1 };
  } else {
    info.contact = 'known';
  }
  info.path = c.hops < 0 ? 'flood' : `direct, ${c.hops} hop(s)`;
  info.hops = c.hops;
  const sent = await companion.send(key, body);
  if (sent.flood) { info.path = 'flood'; info.hops = -1; }
  const total = Math.max(waitSecs, (sent.timeoutMs || 0) / 1000);
  const start = now();
  let data = null;
  while (data === null) {
    const elapsed = (now() - start) / 1000;
    if (progress?.(Math.min(elapsed, total), total) || signal?.aborted || companion.closed || elapsed >= total) break;
    data = await companion.response(sent.tag, Math.min(TICK_MS, (total - elapsed) * 1000), signal);
  }
  const result = data === null ? null
    : keys ? openMcc3(keys, data, key.slice(0, 8), command, count)
      : parseMeshResponse(data, { node: key.slice(0, 8), command, counter: count });
  return { topic, body, result, info, counter: count };
}

// A sealed 0xC2 response as the companion hands it (after the tag) as a Result, or null when it
// does not open under K_cmd or answers another counter.
function openMcc3(keys, data, node, command, counter) {
  let r;
  try { r = openMeshResponse(keys, concat(new Uint8Array(4), data instanceof Uint8Array ? data : new Uint8Array(data || []))); } catch { return null; }
  if (r.counter !== counter) return null;
  return Object.freeze({ ...makeResult(node, r.counter, r.code, command, r.reply, true), clock: r.clock >= MESH.clock_set_from ? r.clock : null, road: 'mesh' });
}
