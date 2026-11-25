// The demo's nodes (W-39i, W-39k): simulated lou-20 repeaters on the in-page command server
// (lib/demo/broker.js), speaking the real mcc3 bytes with lib/protocol/mcc3.js's node side. Each
// holds its own invented key and the demo owner's key as its command key, keeps a sealed retained
// alive, and takes a command in the firmware's order: the seal opens, the signature holds, the
// counter is greater than the last, it has not expired, the deny list, the rate limit; then it runs
// it and answers sealed on the reply topic named inside the command. A node that relays takes a
// forward for the mesh-only node behind it. Nothing here reaches a network.
//
// `rekey <new public key>` (lou-20): signed by the key in use, it makes the new key wait in the
// node's memory for 60 minutes of the demo's clock, or until it restarts. The first command that
// opens under the waiting key makes it the node's command key: the answer and the next alive are
// sealed to it, and the old key opens nothing any more. A forward is the key in use's only.
//
//   const plane = demoPlane(world, { rules });
//   plane.broker.WebSocket     what the page's mqtt client is given
//   plane.nodes                Map(KEY -> the node's state), for the tests
//
// `delay(node, what)` is the milliseconds a node takes to answer (1 to 4 s in the page, 0 in a test);
// `now()` its clock.
import { createFakeBroker } from './broker.js';
import { answer, newState } from './answers.js';
import { DEMO_REGION, near } from './world.js';
import * as mcc3 from '../protocol/mcc3.js';
import { keyFromSeed } from '../key/handle.js';
import { fromHex, fromUtf8 } from '../bytes.js';

export const RATE_PER_HOUR = 50;
// The firmware counts airtime (5 % of 15 minutes, then 1 %); here that is about so many sends.
export const FORWARDS_PER_HOUR = 60;
export const FLOOD_GAP_MS = 60000;
export const REKEY_WAIT_MS = 60 * 60 * 1000;
export const REKEY_OK = 'OK - the new key waits 60 min: send a command signed by it';
export const REKEY_USE = 'Err - use: rekey <the new PUBLIC key, 43 base64url characters>';
export const REKEY_SAME = 'Err - that is the key in use';

// The new key of `rekey <43 base64url characters>` as 64 upper-case hex, or null (mqttCtrlRekeyParse):
// exactly 32 bytes, the two spare bits zero.
export function rekeyParse(command) {
  const m = /^rekey ([A-Za-z0-9_-]{43})$/.exec(String(command || ''));
  if (!m) return null;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let bits = '';
  for (const ch of m[1]) bits += alphabet.indexOf(ch).toString(2).padStart(6, '0');
  if (bits.slice(256) !== '00') return null;
  let hex = '';
  for (let i = 0; i < 256; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex.toUpperCase();
}
const isRekey = (command) => /^rekey( |$)/.test(String(command || ''));
const HOUR = 3600000;
const UPLINK = 0x02;
// lib/data/results.json's codes, by name.
const CODE = Object.freeze({ ok: 0, replay: 9, expired: 10, 'not-allowed': 14, 'rate-limited': 17 });
// mcc3.FORWARD_STATUSES by name.
const FWD = Object.freeze({ answered: 0, 'no-answer': 1, off: 2, expired: 3, replay: 4, busy: 6, 'rate-limited': 7 });

export const demoDelay = (node, what) => (what === 'relay' ? 2500 : 1000) + ((node.i * 677) % 3000);

export function demoPlane(world, { rules, now = () => Date.now(), delay = demoDelay, timers = globalThis } = {}) {
  const owner = world.owner.key;
  const nodes = new Map();
  const started = now();
  for (const n of world.nodes) {
    if (!['wifi', 'relay', 'mesh'].includes(n.kind)) continue;   // offline, older firmware, never heard: not on this plane
    const handle = keyFromSeed(fromHex(n.seedHex));
    nodes.set(n.key, { n, handle, owner, pending: null, keys: mcc3.nodeKeys(handle, owner), state: { ...newState(world, n), started: started - (9 + n.i * 3) * 86400000 },
      lastCounter: 100 + n.i * 7, lastMesh: null, lastForward: null, sequence: 0, sent: [], forwards: [], floods: [] });
  }
  const later = (ms, fn) => (ms > 0 ? timers.setTimeout(fn, ms) : fn());
  const within = (list, at) => list.filter((t) => at - t < HOUR);
  const rebooting = (x) => now() < x.state.rebootUntil;

  // The key that waits on a node, while its hour runs; a restart forgets it too.
  function waiting(x) {
    if (x.pending && now() - x.pending.since >= REKEY_WAIT_MS) x.pending = null;
    return x.pending;
  }
  // Open what arrived with the key in use; failing that with the key that waits, which then takes over.
  function opened(x, open) {
    try { return open(x.owner); } catch (e) {
      const p = waiting(x);
      if (!p) throw e;
      const out = open(p.key);
      x.owner = p.key;
      x.keys = mcc3.nodeKeys(x.handle, p.key);
      x.pending = null;
      return out;
    }
  }

  // The sealed alive a node on Wi-Fi keeps on the server: again after every command, as the
  // firmware's does at its interval, with its last counter.
  function alive(x) {
    const at = now();
    const uptime = Math.floor((at - x.state.started) / 1000);
    x.sequence += 1;
    const relays = x.state.settings['relay'] === 'own' && rules.canRelay(x.state.version) === true;
    broker.retain(mcc3.aliveTopic(x.n.key), mcc3.sealAlive(x.keys, { boot: x.state.boot, sequence: Math.floor(uptime / 900) + x.sequence, uptime,
      clock: Math.floor(at / 1000), last_counter: x.lastCounter, interval: 900, flags: UPLINK | (relays ? mcc3.ALIVE_FLAG_RELAY : 0), mesh: 1,
      fingerprint: x.owner.slice(0, 8), via: x.rekeyed ? 2 : 0, version: x.state.version, region: DEMO_REGION, name: x.state.name }));
  }

  const neighbours = (x) => world.nodes.filter((m) => near(x.n, m) && m.heard !== null && m.kind !== 'offline')
    .map((m, k) => ({ key: m.key, secsAgo: 60 + k * 190 + x.n.i * 7, snr4: -14 + ((k * 13 + x.n.i * 5) % 44) }));

  // What the node does with a command it has opened: { code, reply }.
  function run(x, command, counter, expiry, { road }) {
    const at = now();
    const clock = Math.floor(at / 1000);
    const last = road === 'mesh' ? x.lastMesh : x.lastCounter;
    if (last !== null && counter <= last) return { code: CODE.replay, reply: '' };
    if (expiry < clock) return { code: CODE.expired, reply: '' };
    if (road === 'mesh') x.lastMesh = counter; else x.lastCounter = counter;
    const refusal = road === 'mesh' ? rules.meshRefusal(command, true) : rules.refusal(command);
    if (refusal) return { code: CODE['not-allowed'], reply: '' };
    x.sent = within(x.sent, at);
    if (x.sent.length >= RATE_PER_HOUR) return { code: CODE['rate-limited'], reply: '' };
    x.sent.push(at);
    // `rekey` never reaches the console: the node itself keeps the offered key, in memory.
    if (isRekey(command)) {
      const key = rekeyParse(command);
      if (!key) return { code: CODE.ok, reply: REKEY_USE };
      if (key === x.owner) return { code: CODE.ok, reply: REKEY_SAME };
      x.pending = { key, since: at };
      return { code: CODE.ok, reply: REKEY_OK };
    }
    const wasRelay = x.state.settings['relay'];
    const wasName = x.state.name;
    const out = answer(x.state, command, { now: at, neighbours: neighbours(x) });
    if (rebooting(x)) {
      x.pending = null;      // a key that waits is in RAM only
      // A restart: silent for the while, then up again with a new boot number and a fresh alive.
      later(Math.max(0, x.state.rebootUntil - at) || 0, () => { x.state.boot += 1; x.state.started = now(); x.sequence = 0; if (x.n.kind !== 'mesh') alive(x); });
    } else if (x.n.kind !== 'mesh' && (wasRelay !== x.state.settings['relay'] || wasName !== x.state.name)) alive(x);
    return out;
  }

  // A forward (kind F) to a node that relays: the relay's own order, then the radio and the target.
  function forward(x, payload) {
    let f;
    try { f = mcc3.openForward(x.handle, x.owner, payload); } catch { return false; }
    const at = now();
    const clock = Math.floor(at / 1000);
    const say = (status, more = {}) => later(delay(x.n, 'relay'), () => broker.publish(mcc3.replyTopic(f.rid), mcc3.sealForwardResult(x.keys, f.counter, status, clock, more)));
    if (x.state.settings['relay'] !== 'own') return say(FWD.off), true;
    if (f.expiry < clock || f.expiry > clock + mcc3.FORWARD_MAX_TTL) return say(FWD.expired), true;
    if (x.lastForward !== null && f.counter <= x.lastForward) return say(FWD.replay), true;
    x.lastForward = f.counter;
    const flood = f.route !== mcc3.ROUTES.direct;
    x.forwards = within(x.forwards, at); x.floods = within(x.floods, at);
    if (x.forwards.length >= FORWARDS_PER_HOUR || (flood && x.floods.some((t) => at - t < FLOOD_GAP_MS))) return say(FWD['rate-limited']), true;
    x.forwards.push(at); if (flood) x.floods.push(at);
    const sent = flood ? mcc3.SENT.flood : mcc3.SENT.direct;
    const target = nodes.get(String(f.target).toUpperCase());
    // Out of reach: not a node of this world on the mesh, restarting, or too far for one hop without a flood.
    if (!target || rebooting(target) || (!flood && !near(x.n, target.n))) return say(FWD['no-answer'], { sent }), true;
    let req;
    const was = target.owner;
    try { req = opened(target, (key) => mcc3.openMeshRequest(target.handle, key, concatTag(f.body))); } catch { return say(FWD['no-answer'], { sent }), true; }
    if (target.owner !== was) target.rekeyed = true;
    const a = run(target, req.command, req.counter, req.expiry ?? clock + 60, { road: 'mesh' });
    const response = mcc3.sealMeshResponse(target.keys, 0, req.counter, a.code, clock, a.reply || '').subarray(4);
    return say(FWD.answered, { sent, snr: 18 + (target.n.i % 9), response }), true;
  }
  // The companion's 4-byte tag goes before a mesh request's body; a relay has none.
  const concatTag = (body) => { const out = new Uint8Array(4 + body.length); out.set(body, 4); return out; };

  const broker = createFakeBroker({
    onPublish(b, p) {
      const key = mcc3.nodeFromTopic(p.topic);
      const x = key && p.topic === mcc3.commandTopic(key) ? nodes.get(key) : null;
      if (!x || x.n.kind === 'mesh' || rebooting(x)) return;      // not on Wi-Fi, or restarting: silence
      const payload = fromUtf8(p.payload);
      if (forward(x, payload)) return;
      let cmd;
      const was = x.owner;
      try { cmd = opened(x, (key) => mcc3.openCommand(x.handle, key, payload)); } catch { return; }   // not ours, or altered: silence
      if (x.owner !== was) x.rekeyed = true;
      const a = run(x, cmd.command, cmd.counter, cmd.expiry, { road: 'mqtt' });
      const clock = Math.floor(now() / 1000);
      later(delay(x.n, 'command'), () => {
        b.publish(mcc3.replyTopic(cmd.rid), mcc3.sealResult(x.keys, cmd.counter, a.code, clock, cmd.command, a.reply || ''));
        if (!rebooting(x)) alive(x);
      });
    },
  });
  for (const x of nodes.values()) if (x.n.kind !== 'mesh') alive(x);
  return Object.freeze({ broker, nodes, world });
}
