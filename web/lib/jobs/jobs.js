// The jobs the screens start: send, run a set, discover and adopt, refresh names and versions,
// and update one node's firmware. A port of mccontrol/actions.py and the group semantics of
// api/jobs.py (RM-4): a send to several nodes or a group is one signed per-node command each,
// on its own topic; a member that cannot take the command is reported and the rest still go.
// A region-wide send is one signed broadcast, with the broadcast rules.
//
//   const jobs = createJobs({ ring, stores, rules, brokers, results, configOf });   // results: lib/data/results.json
//   await jobs.send({ command, nodes: ['4AC61A7F'] | group: 'canary' | region: 'JKG', onProgress, signal })
//
// Every job holds the key (ring.hold()) from its first signature to its last, so an auto-lock
// in between lets it finish, and touches the idle clock when it ends. A locked key is a
// JobError('locked') before anything is signed. Every answer, refusal and silence lands in the
// history store as it comes; reads are kept on the device; `ver` and `get name` update it.
import { configFor, discover as realDiscover, send as realSend, DISCOVERY_COMMAND } from '../protocol/transport.js';
import { commandTopic } from '../protocol/topics.js';
import { codeName } from '../protocol/results.js';
import { blocker, fillSteps, JobError } from './checks.js';

export { JobError } from './checks.js';

const sleepFor = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

// The value of a `> value` reply, or the reply itself.
export const valueOf = (reply) => String(reply || '').replace(/^>\s*/, '').trim();

export function createJobs({
  ring, stores, rules, brokers, results, transport = { send: realSend, discover: realDiscover }, connect,
  waitSecs = null, sleep = sleepFor, configExtra = {}, configOf = (region) => configFor(brokers, region),
}) {
  const wait = () => waitSecs ?? brokers.wait_secs ?? 20;
  // `configOf(region)`: the page passes settings-store's brokerConfig, so a region this device
  // sends to its own broker is honoured; the default is the exported table alone.
  const config = (region) => ({ ...configOf(region), ...configExtra });

  async function withKey(work) {
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

  const batchId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const label = (d) => d.name || d.node;

  async function keysOf() {
    const keys = {};
    for (const d of await stores.devices.list()) if (d.key) keys[d.node] = d.key;
    return keys;
  }

  // Store what came back from `device` for `command`: a history event, the device's last
  // result and last heard, a kept read, and its version or name.
  async function land(device, command, topic, result, batch, note = '') {
    const event = await stores.history.append({
      batch, node: device.node, region: device.region, command, topic, note,
      code: result ? result.code : null,
      codeName: result && result.code !== null ? codeName(results, result.code) : null,
      reply: result ? result.reply : null,
      verified: result ? result.verified : null,
    });
    const changes = {
      lastSent: event.at,
      lastResult: { at: event.at, command, code: event.code, codeName: event.codeName, verified: event.verified },
    };
    if (result && result.verified !== false) changes.lastHeard = event.at;      // a refusal too proves it is there
    await stores.devices.update(device.node, changes);
    if (result && result.ok) {
      if (rules.isRead(command)) await stores.devices.rememberRead(device.node, command, result.reply || 'OK', result.verified);
      const value = valueOf(result.reply);
      if (command === 'ver' && value) await stores.devices.update(device.node, { ver: value.slice(0, 60) });
      if (command === 'get name' && value && !device.name) {
        try { await stores.devices.update(device.node, { name: value.slice(0, 40) }); } catch { /* the name is taken */ }
      }
    }
    return event;
  }

  // One signed command to one device: { device, result, event } (result null = no answer).
  async function sendOne(handle, device, command, { batch, keys, signal, onProgress, index = 0, count = 1, note }) {
    const topic = commandTopic(device.region, device.node, device.key);
    const v2Key = device.key && rules.speaksV2(device.ver) ? device.key : null;
    const progress = (elapsed, total, answered) => {
      onProgress?.({ phase: 'waiting', node: device.node, name: label(device), index, count, elapsed, total, answered: answered.length });
      return Boolean(signal?.aborted);
    };
    const { answers } = await transport.send({
      config: config(device.region), handle, topic, command, nodesToHear: [device.node], waitSecs: wait(),
      keys, v2Key, progress, signal, connect,
    });
    const result = answers[device.node] || null;
    const event = await land(device, command, topic, result, batch, note);
    return { device, result, event, v2: Boolean(v2Key) };
  }

  // The nodes a target names: { devices, region } where region is set only for a broadcast.
  async function targets({ nodes = null, group = null, region = null }) {
    const given = [nodes?.length ? 'nodes' : null, group ? 'group' : null, region ? 'region' : null].filter(Boolean);
    if (given.length !== 1) throw new JobError('oneTarget', {}, 'exactly one target: nodes, a group or a region');
    if (region) {
      const r = String(region).trim().toUpperCase();
      const inRegion = (await stores.devices.list()).filter((d) => d.region === r);
      return { devices: inRegion, region: r, group: null };
    }
    if (group) {
      const g = await stores.groups.get(group);
      if (!g) throw new JobError('noGroup', { group }, `no group named ${group}`);
      if (!g.members.length) throw new JobError('emptyGroup', { group: g.id }, `group ${g.id} has no nodes`);
      return { devices: await Promise.all(g.members.map((m) => stores.devices.get(m))), region: null, group: g.id };
    }
    const found = await Promise.all(nodes.map((n) => stores.devices.get(n)));
    const missing = nodes.filter((_, i) => !found[i]);
    if (missing.length) throw new JobError('noNode', { node: missing[0] }, `no node ${missing[0]}`);
    return { devices: found, region: null, group: null };
  }

  // The same check for every command before any is signed; a blocker for a region or for
  // a lone node stops the job, while in a group or a multi-node send it marks that member.
  function vet(commands, target) {
    for (const command of commands) {
      const deny = blocker(rules, { command, device: { region: 'X', ver: null, name: '' }, region: target.region });
      if (deny && deny.code !== 'oldAscii') throw new JobError(deny.code, deny.vars, deny.vars.detail || deny.code);
    }
  }

  // A region-wide broadcast of one command: { outcomes, answered, asked, event }.
  async function broadcast(handle, region, devices, command, { batch, keys, signal, onProgress }) {
    const topic = commandTopic(region);
    const hear = devices.map((d) => d.node);
    const progress = (elapsed, total, answered) => {
      onProgress?.({ phase: 'waiting', region, index: 0, count: hear.length, elapsed, total, answered: answered.length });
      return Boolean(signal?.aborted);
    };
    const { answers } = await transport.send({
      config: config(region), handle, topic, command, nodesToHear: hear, waitSecs: wait(), keys, progress, signal, connect,
    });
    const outcomes = [];
    for (const d of devices) {
      const result = answers[d.node] || null;
      outcomes.push({ node: d.node, name: label(d), sent: true, result, event: await land(d, command, topic, result, batch, 'broadcast') });
    }
    const answered = Object.keys(answers).length;
    const event = await stores.history.append({
      batch, node: null, region, command, topic, code: null, reply: null, verified: null,
      note: `${answered} of ${hear.length} answered`,
    });
    return { outcomes, answered, asked: hear.length, event };
  }

  // Send one command. Resolves to { batch, command, target, outcomes: [{ node, name, sent,
  // result, reason?, event? }], answered, asked }. `reason` ({ code, vars }) is why a member
  // was not sent to; `result` null with sent true is silence.
  async function send({ command, nodes, group, region, onProgress, signal } = {}) {
    const text = String(command || '').split(/\s+/).filter(Boolean).join(' ');
    const target = await targets({ nodes, group, region });
    vet([text], target);
    const batch = batchId();
    return withKey(async (handle) => {
      const keys = await keysOf();
      if (target.region) {
        const out = await broadcast(handle, target.region, target.devices, text, { batch, keys, signal, onProgress });
        return { batch, command: text, target, outcomes: out.outcomes, answered: out.answered, asked: out.asked };
      }
      const outcomes = [];
      const many = target.devices.length > 1 || target.group;
      for (const [index, device] of target.devices.entries()) {
        if (signal?.aborted) {
          outcomes.push({ node: device.node, name: label(device), sent: false, result: null, reason: { code: 'cancelled', vars: {} } });
          continue;
        }
        const reason = blocker(rules, { command: text, device });
        if (reason) {
          if (!many) throw new JobError(reason.code, reason.vars, reason.code);
          outcomes.push({ node: device.node, name: label(device), sent: false, result: null, reason });
          continue;
        }
        onProgress?.({ phase: 'sending', node: device.node, name: label(device), index, count: target.devices.length });
        try {
          const one = await sendOne(handle, device, text, { batch, keys, signal, onProgress, index, count: target.devices.length });
          outcomes.push({ node: device.node, name: label(device), sent: true, result: one.result, event: one.event, v2: one.v2 });
        } catch (e) {
          if (!many) throw e;
          outcomes.push({ node: device.node, name: label(device), sent: false, result: null, reason: { code: 'broker', vars: { detail: e.message } } });
        }
      }
      const sent = outcomes.filter((o) => o.sent);
      return { batch, command: text, target, outcomes, answered: sent.filter((o) => o.result).length, asked: sent.length };
    });
  }

  // Run a set's steps in order to each target node (or broadcast each to a region), stopping
  // at the first refusal or silence. { batch, steps, runs: [{ node | region, name, stoppedAt,
  // outcomes: [per step] }] } -- stoppedAt null when every step was answered ok.
  async function runSet({ steps, arg = '', nodes, group, region, onStep, onProgress, signal } = {}) {
    const filled = fillSteps(steps, arg);
    const target = await targets({ nodes, group, region });
    vet(filled, target);
    const batch = batchId();
    return withKey(async (handle) => {
      const keys = await keysOf();
      const runs = [];
      if (target.region) {
        const run = { region: target.region, name: target.region, stoppedAt: null, outcomes: [] };
        for (const [i, command] of filled.entries()) {
          if (signal?.aborted) { run.stoppedAt = i; break; }
          onStep?.({ step: i, steps: filled.length, command, name: target.region });
          const out = await broadcast(handle, target.region, target.devices, command, { batch, keys, signal, onProgress });
          run.outcomes.push(out);
          if (out.answered < out.asked || out.outcomes.some((o) => !o.result?.ok)) { run.stoppedAt = i; break; }
        }
        runs.push(run);
        return { batch, steps: filled, runs };
      }
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
        if (mine && e.key && mine.key !== e.key) await stores.devices.update(e.node, { key: e.key });
        entries.push({ ...e, knownAs: mine ? label(mine) : null, name: '' });
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

  // Remember a discovered node. A taken name gets -2, -3 ...
  async function adopt(entry, name = '') {
    const all = await stores.devices.list();
    const base = String(name || entry.name || '').trim();
    let chosen = base;
    for (let n = 2; chosen && all.some((d) => d.name.toLowerCase() === chosen.toLowerCase()); n += 1) chosen = `${base}-${n}`;
    return stores.devices.add({ node: entry.node, key: entry.key || null, region: entry.region, name: chosen, notes: '' });
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

  return Object.freeze({ send, runSet, discover, adopt, refresh, update, DISCOVERY_COMMAND });
}
