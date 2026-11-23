// lou-20 nodes on the in-memory broker (protocol-fake-broker.js), with the spec's vector keys:
// each opens a sealed command on its own `mcc/cmd/<KEY>` the way the firmware does (mcc3.js's
// node side), and answers on the RID named inside it with a sealed result. Retained alive
// messages are handed to whoever subscribes `mcc/alive/+`. A relay (`relays`) opens a forward on
// its command topic as lou-20 does, plays the radio and the target behind it, and answers with a
// sealed forward result. Nothing here reaches a network.
import { readFileSync } from 'node:fs';
import { createFakeBroker, matches } from '../lib/demo/broker.js';
import { createMqttClient } from '../lib/protocol/mqtt-client.js';
import * as mcc3 from '../lib/protocol/mcc3.js';
import { keyFromSeed } from '../lib/key/handle.js';
import { fromHex, fromUtf8, toHex } from '../lib/bytes.js';
import { meshNode } from './mesh-fakes.js';

export const M = JSON.parse(readFileSync(new URL('./mcc3-vectors.json', import.meta.url), 'utf8'));
export const ownerKey = () => keyFromSeed(fromHex(M.keys.seeds.command));
export const otherOwnerKey = () => keyFromSeed(fromHex(M.keys.seeds.other_owner));
export const nodeKey = () => keyFromSeed(fromHex(M.keys.seeds.node));
export const otherNodeKey = () => keyFromSeed(fromHex(M.keys.seeds.other_node));

export const connectVia = (broker) => (opts) => createMqttClient({ ...opts, WebSocket: broker.WebSocket });

// nodes: [{ handle, commandKey, answer(command) -> { code, reply } | null (silent), lastCounter }]
// retained: { topic: payload } for mcc/alive/<KEY>.
// relays: [{ handle, commandKey, on = true, clock() -> unix seconds (0: unset), busy, forwardsLeft = 10,
//   floodsLeft = 2, sendFails, snr = 22, targets: [{ handle, region, lou20 = true, answer(command) ->
//   { code, reply } | null, taught: { pathLen, path (hex) } }] }] -- a target not listed is out of reach.
export function mcc3Broker({ nodes = [], retained = {}, extra = null, relays = [] } = {}) {
  const opened = [];
  const forwards = [];
  // The relay's order (wire-format-mcc3.md): silent until it opens, then every outcome answered.
  function relay(b, r, payload) {
    let f;
    try { f = mcc3.openForward(r.handle, r.commandKey, payload); } catch { return; }
    const keys = mcc3.nodeKeys(r.handle, r.commandKey);
    const clock = r.clock ? r.clock() : Math.floor(Date.now() / 1000);
    const seen = { relay: r.handle.publicKeyHex, ...f, rid: toHex(f.rid, true), path: toHex(f.path, true), status: null };
    forwards.push(seen);
    const say = (status, more = {}) => {
      seen.status = mcc3.FORWARD_STATUSES[status];
      b.publish(mcc3.replyTopic(f.rid), mcc3.sealForwardResult(keys, f.counter, status, clock, more));
    };
    if (r.on === false) return say(2);
    if (!clock) return say(8);
    if (f.expiry < clock || f.expiry > clock + mcc3.FORWARD_MAX_TTL) return say(3);
    if (r.lastForward !== undefined && f.counter <= r.lastForward) return say(4);
    r.lastForward = f.counter;
    if (r.busy) return say(6);
    const flood = f.route !== mcc3.ROUTES.direct;
    if ((r.forwardsLeft ?? 10) < 1 || (flood && (r.floodsLeft ?? 2) < 1)) return say(7);
    if (r.sendFails) return say(9);
    r.forwardsLeft = (r.forwardsLeft ?? 10) - 1;
    if (flood) r.floodsLeft = (r.floodsLeft ?? 2) - 1;
    const sent = flood ? mcc3.SENT.flood : mcc3.SENT.direct;
    const t = (r.targets || []).find((x) => x.handle.publicKeyHex === f.target);
    seen.requests = [];
    const node = t && meshNode({ ownerKey: r.commandKey, region: t.region || 'mesh', answer: t.answer, clock,
      mcc3: t.lou20 === false ? null : { node: t.handle }, opened: seen.requests });
    const response = node ? node(f.target, f.body, new Uint8Array(4)) : null;
    const taught = t?.taught ? { pathLen: t.taught.pathLen, path: fromHex(t.taught.path) } : {};
    return response ? say(0, { sent, snr: r.snr ?? 22, response, ...taught }) : say(1, { sent, ...taught });
  }
  const broker = createFakeBroker({
    chunk: 'merge',
    grant(topic, qos) {
      setTimeout(() => {
        for (const [t, payload] of Object.entries(retained)) if (matches(topic, t)) broker.publish(t, payload);
      }, 0);
      return qos;
    },
    onPublish(b, p) {
      for (const r of relays) if (p.topic === mcc3.commandTopic(r.handle.publicKeyHex)) relay(b, r, fromUtf8(p.payload));
      for (const n of nodes) {
        if (p.topic !== mcc3.commandTopic(n.handle.publicKeyHex)) continue;
        let cmd;
        try { cmd = mcc3.openCommand(n.handle, n.commandKey, fromUtf8(p.payload)); } catch { continue; }   // silent
        opened.push({ node: n.handle.publicKeyHex, ...cmd });
        if (n.lastCounter !== undefined && cmd.counter <= n.lastCounter) continue;
        n.lastCounter = cmd.counter;
        const a = n.answer ? n.answer(cmd.command) : { code: 0, reply: 'OK' };
        if (!a) continue;
        const keys = mcc3.nodeKeys(n.handle, n.commandKey);
        const reply = mcc3.replyTopic(cmd.rid);
        if (extra) extra(b, reply, cmd);
        b.publish(reply, mcc3.sealResult(keys, cmd.counter, a.code, 1795000005, cmd.command, a.reply));
      }
    },
  });
  broker.opened = opened;
  broker.forwards = forwards;
  return broker;
}

export const aliveFields = (over = {}) => ({ ...M.alive[0].fields, ...over });
