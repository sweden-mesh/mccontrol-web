// mcc3 on the broker: a sealed command to one node, its sealed result, and the alive scan. A port
// of mccontrol-cli's mccontrol/plane.py (b52384b).
//
// The plane of lou-20 and later (IATA-2), keyed by the node alone and sealed to the owner. No
// IATA, no region, no broadcast: a command goes to `mcc/cmd/<KEY>` of one node, its result comes
// back on `mcc/r/<RID>`, a reply topic named only inside the sealed command, and the owner finds
// its nodes by opening the retained `mcc/alive/<KEY>` messages.
//
// The command key signs and seals; it never touches the broker. The broker login is a throwaway
// key drawn once per session (this page, until newSession()), as is the RID, so the broker sees
// neither the owner nor which session is whose. The broker takes `mcc/cmd` on its TLS listeners
// only, which the page's wss:// is; a plain ws:// test broker is refused here.
//
// `connect` replaces createMqttClient (tests pass a fake broker). Nothing here is sent without a
// call to sendMcc3 or forwardMcc3; scanAlive only subscribes and reads.
import { throwawayKey } from '../key/handle.js';
import { makeResult } from './results.js';
import { DEFAULT_TTL_SECS, NODE_HEX_LEN } from './constants.js';
import { brokerUrl, waitFor } from './transport.js';
import { createMqttClient } from './mqtt-client.js';
import { SUBACK_FAILURE } from './mqtt-codec.js';
import { makeToken, username as tokenUsername } from './token.js';
import {
  ALIVE_FILTER, HEARD_FILTER, Mcc3Error, Refused, TOPIC_ROOT, commandTopic, deriveKeys, heardFromTopic, heardKey, maliveKey,
  newRid, nodeFromTopic, openAlive, openAnnounce, openForwardResult, openHeard, openResult, replyTopic, sealCommand, sealForward,
} from './mcc3.js';
import { fromHex, toHex } from '../bytes.js';
import { nodeKey } from './topics.js';

const nowSecs = () => Math.floor(Date.now() / 1000);

let current = null;

// { handle, rid }: the throwaway broker login and the reply id, drawn once per page session.
export function session() {
  if (!current) current = Object.freeze({ handle: throwawayKey(), rid: newRid() });
  return current;
}

// Forget the session: the next connection draws a new login key and RID.
export function newSession() {
  current?.handle.forget();
  current = null;
}

// A token login with the throwaway key, never a configured username (the broker gives a
// password-file login nothing under mcc/), and never a plain listener.
function connectPlane(config, { connect = createMqttClient, onMessage, timeoutMs = 10000, now = nowSecs() } = {}) {
  if (config.insecure) throw new Mcc3Error('the mcc/ plane takes commands on the broker\'s TLS listeners only (wss://)');
  const { handle } = session();
  const client = connect({
    url: brokerUrl(config), username: tokenUsername(handle), password: makeToken(handle, config.broker, { now }),
    onMessage, connectTimeoutMs: timeoutMs,
  });
  return client.connect().then(() => client);
}

// Seal `command` for the node with `nodeKeyHex`, publish it on `mcc/cmd/<KEY>` and wait for its
// sealed result on this session's RID. `keys` are the node's (ownerKeys, or from the cached S).
// Resolves to { topic, payload, result } -- result null is silence. A result opens only under
// K_cmd, which only the node and the owner hold, so one that opens is the node's own (verified).
export async function sendMcc3({
  config, handle, keys, nodeKeyHex, command, counter, waitSecs = 20, ttl, progress, signal, connect, now = nowSecs(),
}) {
  const key = nodeKey(nodeKeyHex || '');
  if (!key) throw new Mcc3Error('mcc3 needs the node\'s whole public key (64 hex)');
  const node = key.slice(0, NODE_HEX_LEN);
  const { rid } = session();
  const expiry = now + (ttl || config.ttl_secs || DEFAULT_TTL_SECS);
  const payload = sealCommand(handle, key, counter, expiry, rid, command, { keys });
  const topic = commandTopic(key);
  const reply = replyTopic(rid);
  let result = null;
  const onMessage = (msgTopic, bytes) => {
    if (msgTopic !== reply) return;
    let r;
    try { r = openResult(keys, bytes); } catch { return; }      // another node's answer on this RID, or altered
    if (r.counter !== counter) return;
    result = Object.freeze({ ...makeResult(node, counter, r.code, r.command || command, r.reply, true), clock: r.clock || null });
  };
  const client = await connectPlane(config, { connect, onMessage, now });
  try {
    await client.subscribe([{ topic: reply, qos: 1 }]);
    await client.publish(topic, payload, { qos: 1 });
    await waitFor(waitSecs, () => result !== null, () => (result ? [node] : []), progress, { signal });
  } finally {
    await client.close();
  }
  return { topic, payload, result };
}

// Have the relay with `relayKeyHex` transmit `body` (a mesh request from its sub-type byte on) to
// the target by `route` (0 direct along `path`, 1 flood, 2 flood-wide), and wait for its sealed
// result on this session's RID. `keys` are the RELAY's: a result opens only under its K_fwd, and
// the one awaited echoes `counter`. Resolves to { topic, payload, result } -- result (mcc3.js's
// openForwardResult) null is a relay that said nothing: older firmware, offline, or not ours.
export async function forwardMcc3({
  config, keys, relayKeyHex, targetKeyHex, counter, route, body, pathLen = 0, path = new Uint8Array(0),
  waitSecs = 135, ttl = 150, progress, signal, connect, now = nowSecs(),
}) {
  const key = nodeKey(relayKeyHex || '');
  if (!key) throw new Mcc3Error('a relay is named by its whole public key (64 hex)');
  const { rid } = session();
  const payload = sealForward(keys, key, counter, now + ttl, rid, targetKeyHex, route, body, { pathLen, path });
  const topic = commandTopic(key);
  const reply = replyTopic(rid);
  let result = null;
  const onMessage = (msgTopic, bytes) => {
    if (msgTopic !== reply) return;
    let r;
    try { r = openForwardResult(keys, bytes); } catch { return; }      // a command's result, another relay's, or altered
    if (r.counter === counter) result = r;
  };
  const client = await connectPlane(config, { connect, onMessage, now });
  try {
    await client.subscribe([{ topic: reply, qos: 1 }]);
    await client.publish(topic, payload, { qos: 1 });
    await waitFor(waitSecs, () => result !== null, () => (result ? [key.slice(0, NODE_HEX_LEN)] : []), progress, { signal });
  } finally {
    await client.close();
  }
  return { topic, payload, result };
}

// -- alive -------------------------------------------------------------------------------------

// [state, fields] for one alive message: ['ours', fields] when it opens under our command key,
// ['empty', null] for the will (the node went offline), ['foreign', null] when it does not open
// (another owner's node, or altered). `secrets` maps node KEY to S hex and gains the S of a key
// not seen before (one X25519); every later open is one AEAD.
export function openAliveWith(handle, secrets, key, payload) {
  if (!payload || !payload.length) return ['empty', null];
  let s = secrets[key];
  if (!s) s = secrets[key] = toHex(handle.sharedSecret(key), true);
  try {
    return ['ours', openAlive(deriveKeys(fromHex(s), key), payload)];
  } catch (e) {
    if (e instanceof Refused) return ['foreign', null];
    throw e;
  }
}

// Does an alive with `fields` replace one with `than`? A higher (boot, sequence) wins; anything
// lower is stale, a replay by the broker.
export function newer(fields, than) {
  if (!than) return true;
  const b = than.boot ?? -1;
  const q = than.sequence ?? -1;
  return fields.boot > b || (fields.boot === b && fields.sequence > q);
}

// One heard entry of our Observer node `catcherKey` (lou-21), opened twice: the entry with
// K_heard, then the announce inside with K_malive of the node it names. Resolves to the
// announce's fields, the entry's (heard_at, snr in quarter dB, hops, advert_*) and `by` (the
// catching node's key), or null: an entry or an announce that does not open is dropped, so a
// forged announce never shows as a node. `secrets` as openAliveWith's.
export function openHeardWith(handle, secrets, catcherKey, payload) {
  const secret = (key) => {
    if (!secrets[key]) secrets[key] = toHex(handle.sharedSecret(key), true);
    return fromHex(secrets[key]);
  };
  try {
    const { node_key: node, announce, ...entry } = openHeard(heardKey(secret(catcherKey), catcherKey), payload);
    return { ...openAnnounce(maliveKey(secret(node), node), handle.publicKeyHex, announce), ...entry, by: catcherKey };
  } catch (e) {
    if (e instanceof Refused || e instanceof Mcc3Error) return null;
    throw e;
  }
}

// { announced node KEY: entry } from opened heard entries: several of our nodes may have caught
// the same node, and the newest (boot, sequence) is kept.
export function newestHeard(entries) {
  const out = {};
  for (const e of entries) if (e && newer(e, out[e.node_key])) out[e.node_key] = e;
  return out;
}

const yieldNow = () => new Promise((r) => { setTimeout(r, 0); });

// Subscribe `mcc/alive/+` and read the retained snapshot (and any live update) for `waitSecs`.
// Resolves to { KEY: { state, fields, at } }, the newest per node. Reads only: nothing is
// published. The first sight of a key costs an X25519 (~1 ms); messages are opened in slices of
// `sliceMs` with a yield between, so a scan of thousands of keys leaves the page responsive.
//
// With `heard` (a Map), `mcc/heard/+/+` is read on the same connection and the map gains
// "<catching node KEY>/<slot>" -> payload, unopened: the caller opens those of its own nodes
// (openHeardWith). A command server that does not know the topic refuses that one filter;
// nothing is heard then, and nothing else changes.
export async function scanAlive({
  config, handle, secrets, waitSecs = 10, progress, signal, connect, now = () => Date.now(), sliceMs = 15, heard = null,
}) {
  const seen = {};
  const queue = [];
  let refused = false;
  const onMessage = (topic, bytes) => {
    const slot = heard ? heardFromTopic(topic) : null;
    if (slot) {
      if (bytes?.length) heard.set(`${slot.key}/${slot.slot}`, bytes); else heard.delete(`${slot.key}/${slot.slot}`);   // emptied
      return;
    }
    if (!topic.startsWith(`${TOPIC_ROOT}alive/`)) return;
    const key = nodeFromTopic(topic);
    if (key) queue.push([key, bytes]);
  };
  async function drain() {
    let start = performance.now();
    while (queue.length) {
      const [key, bytes] = queue.shift();
      const [state, fields] = openAliveWith(handle, secrets, key, bytes);
      const old = seen[key];
      if (!(state === 'ours' && old?.state === 'ours' && !newer(fields, old.fields))) seen[key] = { state, fields, at: now() };
      if (performance.now() - start > sliceMs) { await yieldNow(); start = performance.now(); }
    }
  }
  const client = await connectPlane(config, { connect, onMessage });
  try {
    const granted = await client.subscribe([{ topic: ALIVE_FILTER, qos: 1 }, ...(heard ? [{ topic: HEARD_FILTER, qos: 1 }] : [])]);
    if (granted?.[0] === SUBACK_FAILURE) refused = true;
    if (!refused) {
      const ours = () => Object.keys(seen).filter((k) => seen[k].state === 'ours');
      const started = now();
      while (!(signal?.aborted)) {
        await drain();
        const elapsed = (now() - started) / 1000;
        if (progress?.(Math.min(elapsed, waitSecs), waitSecs, ours()) || elapsed >= waitSecs) break;
        await waitFor(Math.min(0.2, waitSecs - elapsed), () => queue.length > 0, () => [], null, { signal });
      }
      await drain();
    }
  } finally {
    await client.close();
  }
  if (refused) throw new Error(`${config.broker} refused the subscription to ${ALIVE_FILTER}`);
  return seen;
}
