// Publish a signed envelope and collect the nodes' answers: a port of mccontrol/transport.py
// over the MQTT-over-WebSocket client. One connection per command, opened and closed here;
// the result topics are subscribed before the command is published, so a fast node cannot
// answer before anyone listens.
//
// `config` is { broker, region, port, path, ttl_secs, username?, password? }: `broker` is the
// host name (the token's audience), `port` and `path` the broker's WebSocket listener
// (configFor() fills them from lib/data/brokers.json). A username in config signs in with
// that pair; otherwise the key handle's token does.
//
// Every function takes `connect` to replace createMqttClient (tests pass a fake broker), and
// reports silence as silence: a node missing from the answers did not answer in time.
import { createMqttClient } from './mqtt-client.js';
import { SUBACK_FAILURE } from './mqtt-codec.js';
import { DEFAULT_TTL_SECS, KEY_HEX_LEN, NODE_HEX_LEN, TOPIC_PREFIX, TOKEN } from './constants.js';
import { buildV1, buildV2 } from './envelope.js';
import { parseAny } from './results.js';
import { registerPayload } from './registration.js';
import { makeToken, username as tokenUsername } from './token.js';
import {
  commandTopic, commandTopicOf, nodeFromResultTopic, regionResultTopics, registerAckTopic, resultTopic,
  REGISTER_TOPIC,
} from './topics.js';
import { fromUtf8 } from '../bytes.js';

// The read discovery broadcasts: harmless, admitted everywhere, answered only by nodes that
// verified the signature -- so any answer proves the node holds this key.
export const DISCOVERY_COMMAND = 'get autoreply';
export const TICK_MS = 200;

const nowSecs = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// The configuration for one region: its own broker when brokers.json names one, else the
// shared broker; the WebSocket listener's port and path.
export function configFor(brokers, region, extra = {}) {
  const r = (region || '').trim().toUpperCase();
  return {
    broker: brokers.regions[r] || brokers.shared,
    region: r,
    port: brokers.websocket.port,
    path: brokers.websocket.path,
    ttl_secs: brokers.ttl_secs,
    wait_secs: brokers.wait_secs,
    ...extra,
  };
}

// wss://host[:port]/path
export function brokerUrl(config) {
  const port = config.port && Number(config.port) !== 443 ? `:${config.port}` : '';
  const scheme = config.insecure ? 'ws' : 'wss';      // ws only for a local test broker
  return `${scheme}://${config.broker}${port}${config.path || '/'}`;
}

// [username, password] for the broker: the configured pair, else the key's token.
export function login(config, handle, { now = nowSecs() } = {}) {
  if (config.username) return [config.username, config.password || ''];
  if (!handle) return ['', ''];
  return [tokenUsername(handle), makeToken(handle, config.broker, { now })];
}

// A connected client, or a readable error.
export async function openClient(config, handle, { connect = createMqttClient, onMessage, timeoutMs = 10000 } = {}) {
  const [username, password] = login(config, handle);
  const client = connect({ url: brokerUrl(config), username, password, onMessage, connectTimeoutMs: timeoutMs });
  await client.connect();
  return client;
}

// Wait up to `total` seconds, calling progress(elapsed, total, answered()) every tick (a
// screen draws a bar from it); stop early when done() or when progress returns true (the
// person cancelled), or when `signal` aborts. The answers so far are kept either way.
export async function waitFor(total, done, answered, progress, { signal, tickMs = TICK_MS, clock = () => performance.now() } = {}) {
  const start = clock();
  for (;;) {
    const elapsed = (clock() - start) / 1000;
    if (progress && progress(Math.min(elapsed, total), total, answered())) return;
    if (done() || elapsed >= total || (signal && signal.aborted)) return;
    await sleep(Math.min(tickMs, Math.max(0, (total - elapsed) * 1000)));
  }
}

const own = (region) => `${TOPIC_PREFIX}${region.toUpperCase()}/`;

// A message on a result topic as [node id, key or null, Result or null].
function readResult(topic, payload, handle, keys) {
  const leaf = nodeFromResultTopic(topic);
  if (!leaf) return [null, null, null];
  const node = leaf.slice(0, NODE_HEX_LEN);
  const keyHex = leaf.length === KEY_HEX_LEN ? leaf : (keys[node] || null);
  const result = parseAny(payload, node, { handle, topic, keyHex, commandTopic: commandTopicOf(topic) });
  return [node, leaf.length === KEY_HEX_LEN ? leaf : null, result];
}

// Sign `command` for `topic`, publish it, and collect results from `nodesToHear` (node ids).
// With `v2Key` (the node's whole key) it goes as v2 and its r3 answer is opened; else v1.
// Resolves to { payload, answers: { node: Result } }.
export async function send({
  config, handle, topic, command, nodesToHear = [], waitSecs = 20, ttl, counter, progress,
  keys = {}, v2Key = null, signal, connect, now = nowSecs(),
}) {
  const c = counter ?? now;
  const t = ttl || config.ttl_secs || DEFAULT_TTL_SECS;
  const payload = v2Key ? buildV2(handle, topic, c, command, v2Key, { ttl: t, now })
    : buildV1(handle, topic, c, command, { ttl: t, now });
  const answers = {};
  const wanted = new Set(nodesToHear);
  const prefix = own(config.region);
  const onMessage = (msgTopic, bytes) => {
    if (!msgTopic.startsWith(prefix)) return;          // another region on the same broker
    const [node, , result] = readResult(msgTopic, bytes, handle, keys);
    if (!result || result.counter !== c) return;
    answers[node] = result;
  };
  const client = await openClient(config, handle, { connect, onMessage });
  try {
    if (wanted.size) {
      await client.subscribe([...wanted].map((node) => ({ topic: resultTopic(config.region, node, keys[node]), qos: 1 })));
    }
    await client.publish(topic, payload, { qos: 1 });
    if (wanted.size) {
      await waitFor(waitSecs, () => [...wanted].every((n) => n in answers), () => Object.keys(answers),
        progress, { signal });
    }
  } finally {
    await client.close();
  }
  return { payload, answers: { ...answers } };
}

// The nodes in `region` that accept this key: [{ node, region, code, reply, key, verified }].
// One signed broadcast of a harmless read, then every answer on the region's result topics.
export async function discover({ config, handle, region, waitSecs = 10, counter, progress, signal, connect, now = nowSecs() }) {
  const c = counter ?? now;
  const r = region.toUpperCase();
  const topic = commandTopic(r);
  const payload = buildV1(handle, topic, c, DISCOVERY_COMMAND, { ttl: config.ttl_secs || DEFAULT_TTL_SECS, now });
  const found = {};
  const prefix = own(r);
  const onMessage = (msgTopic, bytes) => {
    if (!msgTopic.startsWith(prefix)) return;
    const [node, key, result] = readResult(msgTopic, bytes, handle, {});
    if (!result || result.counter !== c) return;
    found[node] = { node, region: r, code: result.code, reply: result.reply, key, verified: result.verified };
  };
  const client = await openClient(config, handle, { connect, onMessage });
  try {
    await client.subscribe([{ topic: regionResultTopics(r), qos: 1 }]);
    await client.publish(topic, payload, { qos: 1 });
    await waitFor(waitSecs, () => false, () => Object.keys(found), progress, { signal });
  } finally {
    await client.close();
  }
  return Object.values(found).sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
}

// Publish the signed registration line and wait for the broker's acknowledgement:
// { ok, detail }. ok only on an explicit `ok`; silence is said as such.
export async function register({ config, handle, waitSecs = 10, connect, now = nowSecs(), signal }) {
  const ack = registerAckTopic(handle.publicKeyHex);
  let text = null;
  const onMessage = (msgTopic, bytes) => {
    if (msgTopic !== ack) return;
    try { text = fromUtf8(bytes).trim(); } catch { text = '(not text)'; }
  };
  const client = await openClient(config, handle, { connect, onMessage });
  try {
    await client.subscribe([{ topic: ack, qos: 1 }]);
    await client.publish(REGISTER_TOPIC, registerPayload(handle, { now }), { qos: 1 });
    await waitFor(waitSecs, () => text !== null, () => [], null, { signal });
  } finally {
    await client.close();
  }
  if (text === null) return { ok: false, detail: `no acknowledgement in ${Math.round(waitSecs)} s` };
  return { ok: text === 'ok', detail: text };
}

// Can we reach the broker, sign in, subscribe to a result topic and publish? Returns
// [{ step, ok, detail }] in the order tried, stopping at the first failure. The publish goes
// to a test topic (meshcore/TEST/<own key>/res), which no repeater listens on.
export async function testConnection({ config, handle, timeoutSecs = 10, connect }) {
  const steps = [];
  const [user] = login(config, handle);
  const how = config.username ? `as ${user}`
    : (user ? `token login as ${user.slice(0, 12)}... (your key is the identity)` : 'with no credentials');
  const ownKey = user.startsWith(TOKEN.username_prefix) ? user.slice(TOKEN.username_prefix.length) : 'mccontrol-test';
  const topic = `${TOPIC_PREFIX}TEST/${ownKey}/res`;
  let got = false;
  let client;
  try {
    client = await openClient(config, handle, {
      connect, timeoutMs: timeoutSecs * 1000, onMessage: (t) => { if (t === topic) got = true; },
    });
  } catch (e) {
    steps.push({ step: 'connect and sign in', ok: false, detail: e.message });
    return steps;
  }
  steps.push({ step: 'connect and sign in', ok: true, detail: `${config.broker}:${config.port || 443} ${how}` });
  try {
    const granted = await withTimeout(client.subscribe([{ topic, qos: 1 }]), timeoutSecs,
      `no answer to the subscription in ${timeoutSecs} s`);
    if (granted[0] === SUBACK_FAILURE) {
      steps.push({ step: 'subscribe to a result topic', ok: false, detail: `the broker refused the subscription to ${topic}` });
      return steps;
    }
    steps.push({ step: 'subscribe to a result topic', ok: true, detail: topic });
    await withTimeout(client.publish(topic, 'mccontrol connection test', { qos: 1 }), timeoutSecs,
      `no acknowledgement of the publish in ${timeoutSecs} s`);
    steps.push({ step: 'publish', ok: true, detail: 'accepted by the broker' });
    await waitFor(timeoutSecs, () => got, () => [], null);
    steps.push(got
      ? { step: 'receive what we published', ok: true, detail: 'the broker relays this topic' }
      : { step: 'receive what we published', ok: false,
        detail: `nothing came back in ${timeoutSecs} s: the broker accepts publishes but does not deliver them to subscribers, or drops this topic` });
  } catch (e) {
    steps.push({ step: 'subscribe or publish', ok: false, detail: e.message });
  } finally {
    await client.close();
  }
  return steps;
}

function withTimeout(promise, secs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), secs * 1000); }),
  ]).finally(() => clearTimeout(timer));
}
