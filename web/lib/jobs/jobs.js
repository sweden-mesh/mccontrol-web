// The jobs the screens start: send, run a set, discover and adopt, refresh names and versions,
// and update one node's firmware. A port of mccontrol/actions.py and the group semantics of
// api/jobs.py (RM-4): a send to several nodes or a group is one signed per-node command each,
// on its own topic; a member that cannot take the command is reported and the rest still go.
// There is no broadcast of any kind (IATA-2): an area (a county, from the nodes' own `region
// home`) is each of the owner's nodes there, one sealed command each, in random order and spaced
// (scheme.js); a command that transmits and the mesh road are refused for an area.
//
// The plane is the node's (scheme.js): mcc3 for lou-20 and later (sealed, `mcc/cmd/<KEY>` on the
// shared command server, no IATA; plane.js), the old per-node IATA scheme for lou-19 and older,
// which is how they still take `ota update`. The mesh road picks 0xC2 or 0xC1 the same way.
// discoverAlive() finds the owner's nodes from their retained alive messages; the shared secret
// with every node key seen is cached beside the key (ring.loadSecrets / saveSecrets).
//
//   const jobs = createJobs({ ring, stores, rules, brokers, results, configOf });   // results: lib/data/results.json
//   await jobs.send({ command, nodes: ['4AC61A7F'] | group: 'canary' | area: 'se-jkp', road, onProgress, signal })
//
// `road` (W-16) is 'mqtt' (the default), 'mesh', 'relay' or 'auto' (road.js): the mesh goes through the
// companion `companion()` returns (lib/mesh/companion.js), one node at a time, and an outcome
// says which road it took. Silence over the mesh is silence, never a refusal.
//
// 'relay' (relay.js) has another node of the owner's transmit the mesh request and hand the
// answer back over MQTT: `relay: { node, route, confirmed }`, to ONE node, by the owner's own
// send. A flood needs `confirmed: true`. Auto takes a relay only for a node without MQTT or
// silent on it, with no companion connected and a way that is no flood. A group, several nodes,
// an area, a set, a refresh and an update never go through a relay.
//
// Every job holds the key (ring.hold()) from its first signature to its last, so an auto-lock
// in between lets it finish, and touches the idle clock when it ends. A locked key is a
// JobError('locked') before anything is signed. Every answer, refusal and silence lands in the
// history store as it comes; reads are kept on the device; `ver` and `get name` update it.
import { configFor, discover as realDiscover, send as realSend, DISCOVERY_COMMAND } from '../protocol/transport.js';
import { forwardMcc3 as realForwardMcc3, newer, scanAlive as realScanAlive, sendMcc3 as realSendMcc3 } from '../protocol/plane.js';
import { FLAG_ZERO_HOP, commandTopic as mcc3Topic, deriveKeys } from '../protocol/mcc3.js';
import { meshTopic } from '../protocol/mesh.js';
import { DEFAULT_TTL_SECS } from '../protocol/constants.js';
import { fromHex, toHex } from '../bytes.js';
import { actSpacing, areaOf, oldRegion, scheme, shuffled } from './scheme.js';
import { commandTopic } from '../protocol/topics.js';
import { codeName } from '../protocol/results.js';
import { blocker, fillSteps, JobError, meshBlocker } from './checks.js';
import { MESH_AFTER_MINS, chooseRoad, mqttHeardAt } from './road.js';
import { MESH_WAIT_SECS, meshAnswer, meshBody, sendOverMesh as realMeshSend } from '../mesh/send.js';
import {
  FORWARD_TTL_SECS, RELAY_ROUTES, RELAY_WAIT_SECS, WIRE_ROUTE, autoRelay, hearsTarget, isFlood, relayRefusal,
} from './relay.js';

export { JobError } from './checks.js';

const signalAborted = (signal) => Boolean(signal?.aborted);

const sleepFor = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

// The value of a `> value` reply, or the reply itself.
// The codes a CompanionError carries (lib/mesh/companion.js): said as a companion failure.
const COMPANION_CODES = Object.freeze({ companion: 1, timeout: 1, closed: 1, full: 1, refused: 1 });

const ALIVE_STATES = Object.freeze({ ours: 'online', empty: 'offline', foreign: 'not-yours' });

// What a device keeps of its alive: the state, when it was read, and the opened fields.
function aliveRecord(fields, state, at) {
  const rec = { state, at: new Date(at).toISOString() };
  if (fields) {
    for (const k of ['boot', 'sequence', 'uptime', 'clock', 'last_counter', 'interval', 'flags', 'mesh', 'fingerprint',
      'version', 'region', 'name', 'relay']) rec[k] = fields[k];
    rec.old_scheme = Boolean(fields.flags & 1);
  }
  return rec;
}

export const valueOf = (reply) => String(reply || '').replace(/^>\s*/, '').trim();

export function createJobs({
  ring, stores, rules, brokers, results, transport = { send: realSend, discover: realDiscover }, connect,
  plane = { send: realSendMcc3, scan: realScanAlive, forward: realForwardMcc3 }, random = Math.random,
  waitSecs = null, sleep = sleepFor, configExtra = {}, configOf = (region) => configFor(brokers, region),
  companion = () => null, meshSend = realMeshSend, meshAfterMins = () => MESH_AFTER_MINS, mqttSeen = null,
  now = () => Date.now(), readOnly = false,
}) {
  const wait = () => waitSecs ?? brokers.wait_secs ?? 20;
  // A request over the mesh, sealed or not: a lou-20 node answers a flooded one 15-30 s after it arrives.
  const meshWait = () => waitSecs ?? Math.max(brokers.wait_secs ?? 20, MESH_WAIT_SECS);
  // `configOf(region)`: the page passes settings-store's brokerConfig, so a region this device
  // sends to its own broker is honoured; the default is the exported table alone.
  const config = (region) => ({ ...configOf(region), ...configExtra });

  async function withKey(work) {
    // The demo's own gate (W-39e): read-only, whatever a screen lets through. Every job that signs,
    // publishes or reads the plane comes through here.
    if (readOnly) throw new JobError('demo', {}, 'The demo does not send.');
    const handle = ring.handle();
    if (!handle) throw new JobError('locked', {}, 'The key is locked.');
    const release = ring.hold();
    try {
      return await work(handle);
    } finally {
      release();
      ring.touch();
    }
  }

  // The mcc3 shared secrets, sealed beside the key; {} when the keyring keeps none.
  async function loadSecrets() {
    try { return (await ring.loadSecrets?.()) || {}; } catch { return {}; }
  }
  async function saveSecrets(map) {
    try { await ring.saveSecrets?.(map); } catch { /* kept for this job only */ }
  }

  // K_cmd, K_mesh, K_alive, K_fwd for the node with `key`, from the cached S (a new one is stored).
  async function keysFor(handle, key) {
    const secrets = await loadSecrets();
    if (!secrets[key]) {
      secrets[key] = toHex(handle.sharedSecret(key), true);
      await saveSecrets(secrets);
    }
    return deriveKeys(fromHex(secrets[key]), key);
  }

  const wholeKey = (device) => {
    const key = String(device.key || '').toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(key)) throw new JobError('mcc3NoKey', { name: device.name || device.node }, 'mcc3 needs the whole key');
    return key;
  };

  const batchId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const label = (d) => d.name || d.node;

  async function keysOf() {
    const keys = {};
    for (const d of await stores.devices.list()) if (d.key) keys[d.node] = d.key;
    return keys;
  }

  // Store what came back from `device` for `command`: a history event, the device's last
  // result and last heard, a kept read, and its version or name.
  async function land(device, command, topic, result, batch, note = '', road = 'mqtt', relay = null) {
    const event = await stores.history.append({
      batch, node: device.node, region: null, command, topic, note, road, relay,
      code: result ? result.code : null,
      codeName: result && result.code !== null ? codeName(results, result.code) : null,
      reply: result ? result.reply : null,
      verified: result ? result.verified : null,
    });
    const changes = {
      lastSent: event.at,
      lastResult: { at: event.at, command, code: event.code, codeName: event.codeName, verified: event.verified },
    };
    if (result && result.verified !== false) {
      changes.lastHeard = event.at;      // a refusal too proves it is there
      changes[road === 'mqtt' ? 'lastHeardMqtt' : 'lastHeardMesh'] = event.at;   // the auto road asks which way
    }
    await stores.devices.update(device.node, changes);
    if (result && result.ok) {
      if (rules.isRead(command)) await stores.devices.rememberRead(device.node, command, result.reply || 'OK', result.verified);
      const value = valueOf(result.reply);
      if (command === 'ver' && value) await stores.devices.update(device.node, { ver: value.slice(0, 60) });
      // The node's own word on its relaying, until its next alive says it again.
      const relaying = /^set mqtt\.relay (off|own)$/.exec(command);
      if (relaying && device.alive) await stores.devices.update(device.node, { alive: { ...device.alive, relay: relaying[1] === 'own' } });
      if (command === 'get name' && value && !device.name) {
        try { await stores.devices.update(device.node, { name: value.slice(0, 40) }); } catch { /* the name is taken */ }
      }
    }
    return event;
  }

  // One sealed mcc3 command to one lou-20 node on `mcc/cmd/<KEY>` through the shared command
  // server; the counter is stored before it is sent.
  async function sendSealed(handle, device, command, { batch, signal, onProgress, index = 0, count = 1, note }) {
    const key = wholeKey(device);
    const keys = await keysFor(handle, key);
    const counter = await stores.devices.nextCounter(device.node);
    const progress = (elapsed, total, answered) => {
      onProgress?.({ phase: 'waiting', road: 'mqtt', node: device.node, name: label(device), index, count, elapsed, total, answered: answered.length });
      return Boolean(signal?.aborted);
    };
    const { topic, result } = await plane.send({
      config: config(''), handle, keys, nodeKeyHex: key, command, counter, waitSecs: wait(), progress, signal, connect,
    });
    const event = await land(device, command, topic, result, batch, note || 'mcc3');
    return { device, result, event, v2: false, mcc3: true, road: 'mqtt' };
  }

  // One signed command to one device over MQTT: { device, result, event, road } (result null = no answer).
  async function sendMqtt(handle, device, command, opts) {
    if (scheme(rules, device) === 'mcc3') return sendSealed(handle, device, command, opts);
    const { batch, keys, signal, onProgress, index = 0, count = 1, note } = opts;
    const region = oldRegion(device);
    if (!region) throw new JobError('noRegion', { name: label(device) }, 'no IATA code known for this node');
    const topic = commandTopic(region, device.node, device.key);
    const v2Key = device.key && rules.speaksV2(device.ver) ? device.key : null;
    const progress = (elapsed, total, answered) => {
      onProgress?.({ phase: 'waiting', road: 'mqtt', node: device.node, name: label(device), index, count, elapsed, total, answered: answered.length });
      return Boolean(signal?.aborted);
    };
    const { answers } = await transport.send({
      config: config(region), handle, topic, command, nodesToHear: [device.node], waitSecs: wait(),
      keys, v2Key, progress, signal, connect,
    });
    const result = answers[device.node] || null;
    const event = await land(device, command, topic, result, batch, note);
    return { device, result, event, v2: Boolean(v2Key), road: 'mqtt' };
  }

  // The same over the mesh, through the companion (actions.send_mesh). With `fallback` (the
  // auto road) a mesh-closed answer -- the node's MQTT works -- is recorded and sent again over MQTT.
  async function sendMesh(handle, device, command, opts) {
    const { batch, signal, onProgress, index = 0, count = 1, why = null, fallback = false } = opts;
    const block = blocker(rules, { command, device, road: 'mesh' }) || meshBlocker(rules, command, device);
    if (block) throw new JobError(block.code, block.vars, block.vars.detail || block.code);
    const radio = companion();
    if (!radio || radio.closed) throw new JobError('noCompanion', {}, 'no companion is connected');
    onProgress?.({ phase: 'sending', road: 'mesh', node: device.node, name: label(device), index, count });
    const sealed = scheme(rules, device) === 'mcc3';
    const keys = sealed ? await keysFor(handle, wholeKey(device)) : null;
    const counter = sealed ? await stores.devices.nextCounter(device.node) : null;
    const out = await meshSend({
      companion: radio, handle, keyHex: device.key, region: oldRegion(device), meshOnly: rules.deviceMeshOnly(device), keys, counter,
      name: label(device), command, ttl: brokers.ttl_secs ?? undefined, waitSecs: meshWait(), signal,
      progress: (elapsed, total) => {
        onProgress?.({ phase: 'waiting', road: 'mesh', node: device.node, name: label(device), index, count, elapsed, total, answered: 0 });
        return Boolean(signal?.aborted);
      },
    });
    const note = why ? `mesh: ${why.code}` : '';
    if (fallback && out.result?.code === 19) {
      await land(device, command, out.topic, out.result, batch, 'mesh closed: sent over MQTT', 'mesh');
      const fresh = (await stores.devices.get(device.node)) || device;
      const again = await sendMqtt(handle, fresh, command, opts);
      return { ...again, why: { code: 'meshClosed', vars: {} } };
    }
    const event = await land(device, command, out.topic, out.result, batch, note, 'mesh');
    return { device, result: out.result, event, v2: false, road: 'mesh', why, info: out.info };
  }

  // The same request through a relay (relay.js): sealed for the target exactly as the companion
  // road builds it, wrapped in a forward to the relay on `mcc/cmd/<RELAY KEY>`, the relay's
  // result awaited on this session's RID and the target's answer read with the target's keys.
  // Both counters (the target's, the forward's) are stored before anything is sent. A relay that
  // heard no answer is silence, never a refusal: the node may have run the command.
  async function sendRelay(handle, device, command, opts) {
    const { batch, signal, onProgress, index = 0, count = 1, why = null, relay = null, fallback = false } = opts;
    const block = blocker(rules, { command, device, road: 'relay' }) || meshBlocker(rules, command, device);
    if (block) throw new JobError(block.code, block.vars, block.vars.detail || block.code);
    const via = relay?.node ? await stores.devices.get(relay.node) : null;
    const not = relayRefusal(rules, via, device, now());
    if (not) throw new JobError(not.code, not.vars, 'this node cannot relay now');
    const route = relay.route;
    if (!RELAY_ROUTES.includes(route)) throw new JobError('relayRoute', {}, `a route is one of ${RELAY_ROUTES.join(', ')}`);
    if (isFlood(route) && relay.confirmed !== true) throw new JobError('relayFloodConfirm', {}, 'a flood through a relay is confirmed each time');
    const stored = route === 'path' ? device.relayPaths?.[via.node] : null;
    if (route === 'path' && !stored) throw new JobError('relayNoPath', { name: label(via) }, 'no path is stored for this relay');
    const sealed = scheme(rules, device) === 'mcc3';
    const key = wholeKey(device);
    const relayKey = wholeKey(via);
    const keys = sealed ? await keysFor(handle, key) : null;
    const relayKeys = await keysFor(handle, relayKey);
    const secs = Math.floor(now() / 1000);
    const counter = await stores.devices.nextCounter(device.node);
    const topic = sealed ? mcc3Topic(key) : meshTopic(oldRegion(device), key, rules.deviceMeshOnly(device));
    // Zero hops back only where the relay sends with none and the target knows the flag (0xC2).
    const flags = sealed && route === 'neighbour' ? FLAG_ZERO_HOP : 0;
    const body = meshBody({ handle, key, topic, counter, command, ttl: brokers.ttl_secs ?? DEFAULT_TTL_SECS, nowSecs: secs, keys, flags });
    const forwardCounter = await stores.devices.nextForwardCounter(via.node);
    onProgress?.({ phase: 'sending', road: 'relay', node: device.node, name: label(device), index, count });
    const out = await plane.forward({
      config: config(''), keys: relayKeys, relayKeyHex: relayKey, targetKeyHex: key, counter: forwardCounter,
      route: WIRE_ROUTE[route], body, pathLen: stored ? stored.pathLen : 0, path: stored ? fromHex(stored.path) : new Uint8Array(0),
      waitSecs: waitSecs ?? RELAY_WAIT_SECS, ttl: FORWARD_TTL_SECS, now: secs, signal, connect,
      progress: (elapsed, total) => {
        onProgress?.({ phase: 'waiting', road: 'relay', node: device.node, name: label(device), index, count, elapsed, total, answered: 0 });
        return Boolean(signal?.aborted);
      },
    });
    const r = out.result;
    const result = r?.name === 'answered' ? meshAnswer(keys, r.response, device.node, command, counter) : null;
    const info = { relay: via.node, relayName: label(via), route, status: r ? (r.name || `unknown-${r.status}`) : null,
      sent: r ? r.sent : null, snr: r && r.snr !== null ? r.snr / 4 : null };
    if (r && r.pathLen !== null) {
      const fresh = (await stores.devices.get(device.node)) || device;
      await stores.devices.update(device.node, { relayPaths: { ...(fresh.relayPaths || {}),
        [via.node]: { pathLen: r.pathLen, path: toHex(r.path, true), at: new Date(now()).toISOString() } } });
    }
    if (r?.name === 'off' && via.alive) await stores.devices.update(via.node, { alive: { ...via.alive, relay: false } });
    const kept = { node: info.relay, route, status: info.status, sent: info.sent, snr: info.snr };
    if (fallback && result?.code === 19) {
      await land(device, command, out.topic, result, batch, 'mesh closed: sent over MQTT', 'relay', kept);
      const fresh = (await stores.devices.get(device.node)) || device;
      const again = await sendMqtt(handle, fresh, command, opts);
      return { ...again, why: { code: 'meshClosed', vars: {} } };
    }
    const event = await land(device, command, out.topic, result, batch, why ? `relay: ${why.code}` : '', 'relay', kept);
    return { device, result, event, v2: false, road: 'relay', why, info };
  }

  // When Beacon last saw the node's status, or null; never throws.
  async function seen(device) {
    if (!mqttSeen) return null;
    try { return await mqttSeen(device); } catch { return null; }
  }

  // One signed command to one device by `road`: { device, result, event, road, why?, info? }.
  async function sendOne(handle, device, command, opts) {
    const via = opts.road || 'mqtt';
    if (via === 'mqtt' && !rules.deviceMeshOnly(device)) return sendMqtt(handle, device, command, opts);
    // A relay is the owner's choice for this one send: `relayOk` comes from send() alone, for one node.
    if (via === 'relay') {
      if (!opts.relayOk) throw new JobError('relayOne', {}, 'a relay carries one command to one node, by hand');
      return sendRelay(handle, device, command, opts);
    }
    const heardAt = via === 'auto' ? mqttHeardAt(device, await seen(device)) : null;
    const choice = chooseRoad(rules, { device, command, via, meshAfterMins: meshAfterMins(), heardAt, now: now() });
    if (choice.road === 'mesh') {
      // Auto with no companion: a relay, for a node without MQTT or silent on it, by a way that
      // is no flood (autoRelay offers nothing else). Otherwise the mesh road as before.
      const radio = companion();
      const silent = choice.why?.code === 'meshOnly' || choice.why?.code === 'notHeard';
      if (via === 'auto' && opts.relayOk && silent && (!radio || radio.closed)) {
        const pick = autoRelay(rules, await stores.devices.list(), device, now());
        if (pick) {
          return sendRelay(handle, device, command, { ...opts, why: choice.why, fallback: true,
            relay: { node: pick.relay.node, route: pick.route } });
        }
      }
      return sendMesh(handle, device, command, { ...opts, why: choice.why, fallback: via === 'auto' });
    }
    if (via !== 'auto') return sendMqtt(handle, device, command, opts);
    try {
      return await sendMqtt(handle, device, command, opts);
    } catch (e) {
      if (e instanceof JobError || e?.name === 'AbortError' || signalAborted(opts.signal)) throw e;
      return sendMesh(handle, device, command, { ...opts, why: { code: 'mqttUnreachable', vars: { detail: e.message } } });
    }
  }

  // The nodes a target names: { devices, area, group } where area is set only for an area act.
  async function targets({ nodes = null, group = null, area = null }) {
    const given = [nodes?.length ? 'nodes' : null, group ? 'group' : null, area ? 'area' : null].filter(Boolean);
    if (given.length !== 1) throw new JobError('oneTarget', {}, 'exactly one target: nodes, a group or an area');
    if (area) {
      const a = String(area).trim().toLowerCase();
      const inArea = (await stores.devices.list()).filter((d) => areaOf(d) === a);
      if (!inArea.length) throw new JobError('emptyArea', { area: a }, `no node of yours in ${a}`);
      return { devices: inArea, area: a, group: null };
    }
    if (group) {
      const g = await stores.groups.get(group);
      if (!g) throw new JobError('noGroup', { group }, `no group named ${group}`);
      if (!g.members.length) throw new JobError('emptyGroup', { group: g.id }, `group ${g.id} has no nodes`);
      return { devices: await Promise.all(g.members.map((m) => stores.devices.get(m))), area: null, group: g.id };
    }
    const found = await Promise.all(nodes.map((n) => stores.devices.get(n)));
    const missing = nodes.filter((_, i) => !found[i]);
    if (missing.length) throw new JobError('noNode', { node: missing[0] }, `no node ${missing[0]}`);
    return { devices: found, area: null, group: null };
  }

  // The same check for every command before any is signed; a blocker for an area or for
  // a lone node stops the job, while in a group or a multi-node send it marks that member.
  function vet(commands, target, road = 'mqtt') {
    if (road === 'relay' && (target.area || target.group || target.devices.length !== 1)) {
      throw new JobError('relayOne', {}, 'a relay carries a command to one node at a time');
    }
    for (const command of commands) {
      if (road !== 'mqtt' && !target.area) continue;           // per node, by the road it takes
      const deny = target.area ? blocker(rules, { command, area: target.area, road })
        : blocker(rules, { command, device: { region: 'XX', key: 'F'.repeat(64), ver: null, name: '' }, road });
      if (deny && deny.code !== 'oldAscii') throw new JobError(deny.code, deny.vars, deny.vars.detail || deny.code);
    }
  }

  // One command to each node of an area, one sealed per-node command each (never a broadcast), in
  // random order and spaced (scheme.js); a node that cannot take it is reported and the rest
  // still go. A summary line lands in history. { outcomes, answered, asked, event }.
  async function areaAct(handle, target, command, { batch, keys, signal, onProgress }) {
    const order = shuffled(target.devices, random);
    const [low, high] = actSpacing(rules, command);
    const outcomes = [];
    for (const [index, device] of order.entries()) {
      if (index && !signal?.aborted) {
        const secs = low + random() * (high - low);
        onProgress?.({ phase: 'spacing', area: target.area, index, count: order.length, secs: Math.round(secs) });
        await sleep(secs * 1000, signal);
      }
      if (signal?.aborted) {
        outcomes.push({ node: device.node, name: label(device), sent: false, result: null, reason: { code: 'cancelled', vars: {} } });
        continue;
      }
      const reason = blocker(rules, { command, device, road: 'mqtt' });
      if (reason) { outcomes.push({ node: device.node, name: label(device), sent: false, result: null, reason }); continue; }
      onProgress?.({ phase: 'sending', area: target.area, node: device.node, name: label(device), index, count: order.length });
      try {
        const one = await sendMqtt(handle, device, command, { batch, keys, signal, onProgress, index, count: order.length });
        outcomes.push({ node: device.node, name: label(device), sent: true, result: one.result, event: one.event, road: 'mqtt' });
      } catch (e) {
        const why = e instanceof JobError ? { code: e.code, vars: e.vars } : { code: 'broker', vars: { detail: e.message } };
        outcomes.push({ node: device.node, name: label(device), sent: false, result: null, reason: why });
      }
    }
    const answered = outcomes.filter((o) => o.result).length;
    const event = await stores.history.append({
      batch, node: null, region: target.area, command, topic: `area/${target.area}/act`, code: null, reply: null,
      verified: null, note: `${answered} of ${order.length} answered`,
    });
    return { outcomes, answered, asked: order.length, event };
  }

  // Send one command. Resolves to { batch, command, target, outcomes: [{ node, name, sent,
  // result, reason?, event? }], answered, asked }. `reason` ({ code, vars }) is why a member
  // was not sent to; `result` null with sent true is silence.
  async function send({ command, nodes, group, area, road = 'mqtt', relay = null, onProgress, signal } = {}) {
    const text = String(command || '').split(/\s+/).filter(Boolean).join(' ');
    const target = await targets({ nodes, group, area });
    vet([text], target, road);
    const batch = batchId();
    return withKey(async (handle) => {
      const keys = await keysOf();
      if (target.area) {
        const out = await areaAct(handle, target, text, { batch, keys, signal, onProgress });
        return { batch, command: text, target, outcomes: out.outcomes, answered: out.answered, asked: out.asked };
      }
      const outcomes = [];
      const many = target.devices.length > 1 || target.group;
      for (const [index, device] of target.devices.entries()) {
        if (signal?.aborted) {
          outcomes.push({ node: device.node, name: label(device), sent: false, result: null, reason: { code: 'cancelled', vars: {} } });
          continue;
        }
        const reason = blocker(rules, { command: text, device, road });
        if (reason) {
          if (!many) throw new JobError(reason.code, reason.vars, reason.code);
          outcomes.push({ node: device.node, name: label(device), sent: false, result: null, reason });
          continue;
        }
        onProgress?.({ phase: 'sending', node: device.node, name: label(device), index, count: target.devices.length });
        try {
          const one = await sendOne(handle, device, text, { batch, keys, signal, onProgress, index, count: target.devices.length, road,
            relay, relayOk: !many });
          outcomes.push({ node: device.node, name: label(device), sent: true, result: one.result, event: one.event, v2: one.v2,
            road: one.road, why: one.why || null, info: one.info || null });
        } catch (e) {
          if (!many) throw e;
          const reason = e instanceof JobError ? { code: e.code, vars: e.vars }
            : { code: e?.code && String(e.code) in COMPANION_CODES ? 'companion' : 'broker', vars: { detail: e.message } };
          outcomes.push({ node: device.node, name: label(device), sent: false, result: null, reason });
        }
      }
      const sent = outcomes.filter((o) => o.sent);
      return { batch, command: text, target, outcomes, answered: sent.filter((o) => o.result).length, asked: sent.length };
    });
  }

  // Run a set's steps in order to each target node (an area's nodes one after another, never a
  // broadcast), stopping at the first refusal or silence. { batch, steps, runs: [{ node, name,
  // stoppedAt, outcomes: [per step] }] } -- stoppedAt null when every step was answered ok.
  async function runSet({ steps, arg = '', nodes, group, area, onStep, onProgress, signal } = {}) {
    const filled = fillSteps(steps, arg);
    const target = await targets({ nodes, group, area });
    vet(filled, target);
    const batch = batchId();
    return withKey(async (handle) => {
      const keys = await keysOf();
      const runs = [];
      for (const device of target.devices) {
        const run = { node: device.node, name: label(device), stoppedAt: null, outcomes: [], reason: null };
        runs.push(run);
        const reason = filled.map((c) => blocker(rules, { command: c, device })).find(Boolean);
        if (reason) { run.reason = reason; run.stoppedAt = 0; continue; }
        for (const [i, command] of filled.entries()) {
          if (signal?.aborted) { run.stoppedAt = i; run.reason = { code: 'cancelled', vars: {} }; break; }
          onStep?.({ step: i, steps: filled.length, command, node: device.node, name: label(device) });
          let one;
          try {
            one = await sendOne(handle, device, command, { batch, keys, signal, onProgress });
          } catch (e) {
            run.stoppedAt = i;
            run.reason = { code: 'broker', vars: { detail: e.message } };
            break;
          }
          run.outcomes.push({ command, result: one.result, event: one.event });
          if (!one.result?.ok) { run.stoppedAt = i; break; }
        }
      }
      return { batch, steps: filled, runs };
    });
  }

  // The nodes in `region` that answer a command signed with this key, each marked with the
  // device it already is (knownAs) and, where the firmware answers `get name`, its name.
  async function discover({ region, onProgress, signal } = {}) {
    const r = String(region || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(r)) throw new JobError('badRegion', {}, 'a region is its IATA code');
    return withKey(async (handle) => {
      const progress = (elapsed, total, answered) => {
        onProgress?.({ phase: 'waiting', region: r, elapsed, total, answered: answered.length });
        return Boolean(signal?.aborted);
      };
      const found = await transport.discover({ config: config(r), handle, region: r, waitSecs: wait(), progress, signal, connect });
      const known = new Map((await stores.devices.list()).map((d) => [d.node, d]));
      const entries = [];
      for (const e of found) {
        const mine = known.get(e.node);
        // The key in an answer's topic is the broker's word, not the node's: a hostile broker
        // can name any key with the node's prefix. A stored key is never replaced from here (that
        // would send v2 commands sealed to the broker's key); a missing one is learnt only from
        // an answer that was not forged. A different key is reported, not adopted.
        let keyChanged = false;
        if (mine && e.key && mine.key !== e.key) {
          if (mine.key) keyChanged = true;
          else if (e.verified !== false) await stores.devices.update(e.node, { key: e.key });
        }
        entries.push({ ...e, keyChanged, knownAs: mine ? label(mine) : null, name: '' });
      }
      if (entries.length && !signal?.aborted) {
        try {
          const { answers } = await transport.send({
            config: config(r), handle, topic: commandTopic(r), command: 'get name',
            nodesToHear: entries.map((e) => e.node), waitSecs: Math.min(10, wait()),
            keys: Object.fromEntries(entries.filter((e) => e.key).map((e) => [e.node, e.key])), signal, connect,
          });
          for (const e of entries) {
            const a = answers[e.node];
            if (a?.ok && a.reply) e.name = valueOf(a.reply).slice(0, 40);
          }
        } catch { /* names stay empty; they are given by hand */ }
      }
      return entries;
    });
  }

  // W-24's "Check": ONE signed `ver` over the mesh, through the companion, to a possible
  // mesh-only node that is not in the list. A mesh-only node signs and is signed for on
  // meshcore/mesh/{PUBKEY}/cmd, so no IATA is needed. Only on the owner's press, never by itself.
  // An answer (any code: a refusal is signed by the node too) proves the node holds this key: it
  // is added as mesh-only (by its whole key, with no region) and the answer lands in history like
  // any send. Silence adds nothing. { answered, result, device | null, info }
  async function checkMeshNode({ candidate, signal, onProgress } = {}) {
    const key = String(candidate?.key || '').toUpperCase();
    const name = String(candidate?.name || '').trim();
    if (!/^[0-9A-F]{64}$/.test(key)) throw new JobError('meshNoKey', { name: name || candidate?.node || '?' });
    const r = '';
    return withKey(async (handle) => {
      const radio = companion();
      if (!radio || radio.closed) throw new JobError('noCompanion', {}, 'no companion is connected');
      const node = key.slice(0, 8);
      onProgress?.({ phase: 'sending', road: 'mesh', node, name: name || node, index: 0, count: 1 });
      const out = await meshSend({
        companion: radio, handle, keyHex: key, region: r, meshOnly: true, name, command: 'ver',
        ttl: brokers.ttl_secs ?? undefined, waitSecs: meshWait(), signal,
        progress: (elapsed, total) => {
          onProgress?.({ phase: 'waiting', road: 'mesh', node, name: name || node, index: 0, count: 1, elapsed, total, answered: 0 });
          return Boolean(signal?.aborted);
        },
      });
      if (!out.result) return { answered: false, result: null, device: null, info: out.info };
      const existing = await stores.devices.get(node);
      const device = existing || await adopt({ node, key, region: r, name, verified: null });
      await stores.devices.update(device.node, { meshOnly: true });
      await land(await stores.devices.get(device.node), 'ver', out.topic, out.result, batchId(), 'mesh-only check', 'mesh');
      return { answered: true, result: out.result, device: await stores.devices.get(device.node), info: out.info };
    });
  }

  // "Check neighbours": ONE `neighbors` read to a relay over MQTT (no airtime: the table is built
  // from the adverts it heard), and whether the target's key is in it. The finding is kept on the
  // target with its time; a reply that proves nothing either way changes nothing.
  // { result, hears: true | false | null }
  async function checkNeighbours({ relay, target, signal, onProgress } = {}) {
    const via = await stores.devices.get(relay);
    const device = await stores.devices.get(target);
    if (!via || !device) throw new JobError('noNode', { node: via ? target : relay }, 'no such node');
    const out = await send({ command: 'neighbors', nodes: [via.node], road: 'mqtt', signal, onProgress });
    const result = out.outcomes[0]?.result || null;
    const found = result?.ok && result.verified !== false ? hearsTarget(result.reply, device.key || device.node) : null;
    if (found) {
      const fresh = (await stores.devices.get(device.node)) || device;
      await stores.devices.update(device.node, { relayHears: { ...(fresh.relayHears || {}),
        [via.node]: { hears: found.hears, snr: found.snr, at: new Date(now()).toISOString() } } });
    }
    return { result, hears: found ? found.hears : null };
  }

  // Remember a discovered node. A taken name gets -2, -3 ... A node found by its alive has a
  // whole key and no region: mcc3 needs none.
  async function adopt(entry, name = '') {
    const all = await stores.devices.list();
    const base = String(name || entry.name || '').trim();
    let chosen = base;
    for (let n = 2; chosen && all.some((d) => d.name.toLowerCase() === chosen.toLowerCase()); n += 1) chosen = `${base}-${n}`;
    const key = entry.verified === false ? null : (entry.key || null);   // never a key from a forged answer
    const added = await stores.devices.add({ node: entry.node.slice(0, 8), key, region: entry.region || '', name: chosen, notes: '' });
    return entry.alive ? stores.devices.update(added.node, { alive: entry.alive, ...(entry.alive.version ? { ver: entry.alive.version } : {}) }) : added;
  }

  // Your nodes, wherever they are, from the retained alive messages (IATA-2 §6): every
  // `mcc/alive/<KEY>` is tried with your command key (the shared secret per node cached beside
  // the key), and those that open are yours. A device you have whose alive is empty is offline;
  // one whose alive no longer opens is no longer yours (rekeyed). Reads only; nothing is sent.
  // Updates the devices it knows; resolves to [{ node, key, name, version, state, knownAs, alive }]
  // (state: 'online' | 'offline' | 'not-yours'); adopting a new one is the caller's (adopt).
  async function discoverAlive({ onProgress, signal, waitSecs = null } = {}) {
    return withKey(async (handle) => {
      const secrets = await loadSecrets();
      const before = Object.keys(secrets).length;
      const total = waitSecs ?? Math.min(10, wait());
      const seen = await plane.scan({
        config: config(''), handle, secrets, waitSecs: total, signal, connect,
        progress: (elapsed, all, ours) => { onProgress?.({ phase: 'waiting', elapsed, total: all, answered: ours.length }); return Boolean(signal?.aborted); },
      });
      if (Object.keys(secrets).length !== before) await saveSecrets(secrets);
      const devices = await stores.devices.list();
      const byKey = new Map(devices.filter((d) => d.key).map((d) => [d.key.toUpperCase(), d]));
      const entries = [];
      for (const [key, { state, fields, at }] of Object.entries(seen)) {
        let d = byKey.get(key) || null;
        if (!d && state === 'ours') {        // a device kept by its id alone: its alive gives the key
          const bare = devices.find((x) => x.node === key.slice(0, 8) && !x.key);
          if (bare) d = await stores.devices.update(bare.node, { key });
        }
        if (state !== 'ours' && !d) continue;           // someone else's node: nothing to say
        let rec = aliveRecord(fields, ALIVE_STATES[state], at);
        if (d) {
          const old = d.alive || null;
          if (state === 'ours' && old?.state === 'online' && !newer(fields, old)) rec = old;   // a replay of an older one
          else if (state !== 'ours') rec = { ...(old || {}), state: rec.state, at: rec.at };
          const changes = { alive: rec };
          if (state === 'ours' && rec.version) changes.ver = rec.version.slice(0, 60);
          if (state === 'ours' && !d.name && rec.name) changes.name = rec.name.slice(0, 40);
          try { d = await stores.devices.update(d.node, changes); } catch { d = await stores.devices.update(d.node, { alive: rec }); }
        }
        entries.push({
          node: key.slice(0, 8), key, name: fields?.name || '', version: fields?.version || '', state: rec.state,
          knownAs: d ? label(d) : null, alive: rec,
        });
      }
      return entries.sort((a, b) => (a.name || a.node).toLowerCase().localeCompare((b.name || b.node).toLowerCase()));
    });
  }

  // `get name` and `ver` to each node, one signed read each: an unnamed node takes its own
  // name, every node keeps its version. { named, versioned, outcomes: [{ node, name, command, result, reason? }] }
  async function refresh({ nodes, onProgress, signal } = {}) {
    const devices = (await Promise.all((nodes || []).map((n) => stores.devices.get(n)))).filter(Boolean);
    const batch = batchId();
    return withKey(async (handle) => {
      const keys = await keysOf();
      let named = 0; let versioned = 0;
      const outcomes = [];
      for (const [index, device] of devices.entries()) {
        for (const command of ['get name', 'ver']) {
          if (signal?.aborted) return { named, versioned, outcomes };
          onProgress?.({ phase: 'sending', node: device.node, name: label(device), command, index, count: devices.length });
          const fresh = await stores.devices.get(device.node);
          try {
            const one = await sendOne(handle, fresh, command, { batch, keys, signal, onProgress, index, count: devices.length });
            outcomes.push({ node: device.node, name: label(fresh), command, result: one.result });
            if (one.result?.ok && command === 'ver') versioned += 1;
            if (one.result?.ok && command === 'get name' && !fresh.name && valueOf(one.result.reply)) named += 1;
          } catch (e) {
            outcomes.push({ node: device.node, name: label(fresh), command, result: null, reason: { code: 'broker', vars: { detail: e.message } } });
          }
        }
      }
      return { named, versioned, outcomes };
    });
  }

  // Update one node's firmware to `target` (a release tag, e.g. v1.18.0-lou-18): `ota update`
  // to that node alone, then `ver` every `pollSecs` until it reports that revision or later,
  // or `maxSecs` pass. onStage({ stage: 'asking' | 'restarting' | 'checking' | 'done', ... }).
  // Resolves to { ok, version, reason? }. Refused before signing when the deny list or the
  // node's firmware does not admit `ota update`.
  async function update({ node, target, onStage, signal, pollSecs = 30, maxSecs = 900 } = {}) {
    const device = await stores.devices.get(node);
    if (!device) throw new JobError('noNode', { node }, `no node ${node}`);
    const command = 'ota update';
    const block = blocker(rules, { command, device });
    if (block) throw new JobError('otaRefused', { detail: block.vars.detail || block.code }, block.vars.detail || block.code);
    if (device.ver && !rules.admits(device.ver, command)) {
      throw new JobError('otaRefused', { detail: `${device.ver}` }, 'the firmware does not admit ota update');
    }
    const want = rules.revision(target);
    const batch = batchId();
    return withKey(async (handle) => {
      const keys = await keysOf();
      onStage?.({ stage: 'asking' });
      const first = await sendOne(handle, device, command, { batch, keys, signal, note: `update to ${target}` });
      if (!first.result?.ok) return { ok: false, version: device.ver, result: first.result };
      onStage?.({ stage: 'restarting', reply: first.result.reply });
      const started = Date.now();
      while (!signal?.aborted && (Date.now() - started) / 1000 < maxSecs) {
        await sleep(pollSecs * 1000, signal);
        if (signal?.aborted) break;
        onStage?.({ stage: 'checking', elapsed: Math.round((Date.now() - started) / 1000), total: maxSecs });
        const fresh = await stores.devices.get(node);
        let one;
        try {
          one = await sendOne(handle, fresh, 'ver', { batch, keys, signal });
        } catch {
          continue;                                // the broker may drop us while the node restarts
        }
        const version = valueOf(one.result?.reply);
        if (one.result?.ok && version && want !== null && (rules.revision(version) ?? -1) >= want) {
          onStage?.({ stage: 'done', version });
          return { ok: true, version };
        }
      }
      return { ok: false, version: (await stores.devices.get(node)).ver, reason: { code: signal?.aborted ? 'cancelled' : 'timeout', vars: {} } };
    });
  }

  return Object.freeze({ send, runSet, discover, discoverAlive, adopt, refresh, update, checkMeshNode, checkNeighbours, DISCOVERY_COMMAND });
}
