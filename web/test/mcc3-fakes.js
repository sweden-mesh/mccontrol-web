// lou-20 nodes on the in-memory broker (protocol-fake-broker.js), with the spec's vector keys:
// each opens a sealed command on its own `mcc/cmd/<KEY>` the way the firmware does (mcc3.js's
// node side), and answers on the RID named inside it with a sealed result. Retained alive
// messages are handed to whoever subscribes `mcc/alive/+`. Nothing here reaches a network.
import { readFileSync } from 'node:fs';
import { createFakeBroker, matches } from './protocol-fake-broker.js';
import { createMqttClient } from '../lib/protocol/mqtt-client.js';
import * as mcc3 from '../lib/protocol/mcc3.js';
import { keyFromSeed } from '../lib/key/handle.js';
import { fromHex, fromUtf8 } from '../lib/bytes.js';

export const M = JSON.parse(readFileSync(new URL('./mcc3-vectors.json', import.meta.url), 'utf8'));
export const ownerKey = () => keyFromSeed(fromHex(M.keys.seeds.command));
export const otherOwnerKey = () => keyFromSeed(fromHex(M.keys.seeds.other_owner));
export const nodeKey = () => keyFromSeed(fromHex(M.keys.seeds.node));
export const otherNodeKey = () => keyFromSeed(fromHex(M.keys.seeds.other_node));

export const connectVia = (broker) => (opts) => createMqttClient({ ...opts, WebSocket: broker.WebSocket });

// nodes: [{ handle, commandKey, answer(command) -> { code, reply } | null (silent), lastCounter }]
// retained: { topic: payload } for mcc/alive/<KEY>.
export function mcc3Broker({ nodes = [], retained = {}, extra = null } = {}) {
  const opened = [];
  const broker = createFakeBroker({
    chunk: 'merge',
    grant(topic, qos) {
      setTimeout(() => {
        for (const [t, payload] of Object.entries(retained)) if (matches(topic, t)) broker.publish(t, payload);
      }, 0);
      return qos;
    },
    onPublish(b, p) {
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
  return broker;
}

export const aliveFields = (over = {}) => ({ ...M.alive[0].fields, ...over });
