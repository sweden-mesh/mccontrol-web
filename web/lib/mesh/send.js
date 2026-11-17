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
// `progress(elapsedSecs, totalSecs)` is called through the wait; returning true stops it. A
// result of null is silence: never a refusal (a replay, a bad signature, a node without the
// road, a closed road or its budget all say nothing).
import { checkCommand, meshBuild, meshTopic, parseMeshResponse } from '../protocol/mesh.js';
import { nodeKey } from '../protocol/topics.js';
import { DEFAULT_TTL_SECS } from '../protocol/constants.js';
import { CompanionError } from './companion.js';

const TICK_MS = 200;

export async function sendOverMesh({
  companion, handle, keyHex, region, meshOnly = false, name = '', command, counter = null,
  ttl = DEFAULT_TTL_SECS, waitSecs = 30, progress = null, signal = null, now = () => Date.now(),
}) {
  checkCommand(command);
  const topic = meshTopic(region, keyHex, meshOnly);
  const key = nodeKey(keyHex);
  if (!companion || companion.closed) throw new CompanionError('no companion is connected', 'closed');
  const count = counter ?? Math.floor(now() / 1000);
  const body = meshBuild(handle, topic, count, command, { ttl, now: Math.floor(now() / 1000) });
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
  const result = data === null ? null : parseMeshResponse(data, { node: key.slice(0, 8), command, counter: count });
  return { topic, body, result, info, counter: count };
}
