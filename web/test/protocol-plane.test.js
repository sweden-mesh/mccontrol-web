// plane.js against the in-memory broker with lou-20 nodes (mcc3-fakes.js): one sealed command on
// mcc/cmd/<KEY>, its sealed result on the session's RID, a throwaway login per session, and the
// alive scan (ours, someone else's, the will, a stale replay), which publishes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mcc3 from '../lib/protocol/mcc3.js';
import { newSession, newer, openAliveWith, scanAlive, sendMcc3, session } from '../lib/protocol/plane.js';
import { configFor } from '../lib/protocol/transport.js';
import { toHex } from '../lib/bytes.js';
import { data } from './protocol-helpers.js';
import { M, aliveFields, connectVia, mcc3Broker, nodeKey, otherNodeKey, otherOwnerKey, ownerKey } from './mcc3-fakes.js';

const owner = ownerKey();
const node = nodeKey();
const NODE = node.publicKeyHex;
const config = { ...configFor(data('brokers'), ''), wait_secs: 2 };
const K = mcc3.ownerKeys(owner, NODE);

test('one sealed command, its sealed result on the session RID; the login is a throwaway key, the same all session', async () => {
  newSession();
  const broker = mcc3Broker({ nodes: [{ handle: node, commandKey: owner.publicKeyHex, answer: (c) => ({ code: 0, reply: `> ran ${c}` }) }] });
  const out = await sendMcc3({ config, handle: owner, keys: K, nodeKeyHex: NODE, command: 'get name', counter: 1795000100, waitSecs: 2, connect: connectVia(broker) });
  assert.equal(out.topic, `mcc/cmd/${NODE}`);
  assert.equal(out.result.verified, true);
  assert.equal(out.result.code, 0);
  assert.equal(out.result.reply, '> ran get name');
  assert.equal(out.result.counter, 1795000100);
  assert.equal(broker.opened[0].command, 'get name');
  assert.equal(toHex(broker.opened[0].rid, true), toHex(session().rid, true));
  const login = broker.connects[0].username;
  assert.match(login, /^v1_[0-9A-F]{64}$/);
  assert.notEqual(login, `v1_${owner.publicKeyHex}`, 'the command key never logs in');
  const subs = broker.received.filter((p) => p.type === 'subscribe').flatMap((p) => p.topics.map((t) => t.topic));
  assert.deepEqual(subs, [mcc3.replyTopic(session().rid)]);
  await sendMcc3({ config, handle: owner, keys: K, nodeKeyHex: NODE, command: 'ver', counter: 1795000101, waitSecs: 2, connect: connectVia(broker) });
  assert.equal(broker.connects[1].username, login, 'one throwaway key per session');
  newSession();
  await sendMcc3({ config, handle: owner, keys: K, nodeKeyHex: NODE, command: 'ver', counter: 1795000102, waitSecs: 2, connect: connectVia(broker) });
  assert.notEqual(broker.connects[2].username, login, 'a new session draws a new one');
});

test('another node\'s answer on the RID, another counter, or another owner\'s command: not the result', async () => {
  newSession();
  const other = otherNodeKey();
  const otherKeys = mcc3.nodeKeys(other, owner.publicKeyHex);
  const broker = mcc3Broker({
    nodes: [{ handle: node, commandKey: owner.publicKeyHex, answer: () => null }],
    extra: () => {},
  });
  // the node is silent; a stranger answers on our RID with the right counter, and our node with another counter
  broker.opts.onPublish = (b, p) => {
    const rid = mcc3.replyTopic(session().rid);
    b.publish(rid, mcc3.sealResult(otherKeys, 7, 0, 0, 'ver', 'forged'));
    b.publish(rid, mcc3.sealResult(mcc3.nodeKeys(node, owner.publicKeyHex), 8, 0, 0, 'ver', 'old'));
  };
  const out = await sendMcc3({ config, handle: owner, keys: K, nodeKeyHex: NODE, command: 'ver', counter: 7, waitSecs: 0.4, connect: connectVia(broker) });
  assert.equal(out.result, null);
  const wrongOwner = mcc3Broker({ nodes: [{ handle: node, commandKey: owner.publicKeyHex }] });
  const stranger = otherOwnerKey();
  const r = await sendMcc3({ config, handle: stranger, keys: mcc3.ownerKeys(stranger, NODE), nodeKeyHex: NODE, command: 'ver',
    counter: 9, waitSecs: 0.3, connect: connectVia(wrongOwner) });
  assert.equal(r.result, null);
  assert.equal(wrongOwner.opened.length, 0, 'the node opens nothing sealed by another key');
});

test('the plane refuses a plain ws:// broker and a node without its whole key', async () => {
  await assert.rejects(sendMcc3({ config: { ...config, insecure: true }, handle: owner, keys: K, nodeKeyHex: NODE, command: 'ver', counter: 1 }),
    mcc3.Mcc3Error);
  await assert.rejects(sendMcc3({ config, handle: owner, keys: K, nodeKeyHex: NODE.slice(0, 8), command: 'ver', counter: 1 }), mcc3.Mcc3Error);
});

test('alive: ours opens, someone else\'s does not, the will is offline, a stale one is ignored; S cached; nothing published', async () => {
  newSession();
  const other = otherNodeKey();
  const OTHER = other.publicKeyHex;
  const stranger = mcc3.ownerKeys(otherOwnerKey(), OTHER);
  const retained = {
    [mcc3.aliveTopic(NODE)]: M.alive[0].payload,
    [mcc3.aliveTopic(OTHER)]: mcc3.sealAlive(stranger, aliveFields({ name: 'not mine' })),
    [`mcc/alive/${'E'.repeat(64)}`]: '',
  };
  const broker = mcc3Broker({ retained });
  const secrets = {};
  const seen = await scanAlive({ config, handle: owner, secrets, waitSecs: 0.4, connect: connectVia(broker) });
  assert.equal(seen[NODE].state, 'ours');
  assert.deepEqual(seen[NODE].fields, M.alive[0].opened);
  assert.equal(seen[OTHER].state, 'foreign');
  assert.equal(seen['E'.repeat(64)].state, 'empty');
  assert.deepEqual(Object.keys(secrets).sort(), [NODE, OTHER].sort());
  assert.equal(secrets[NODE], M.keys.shared_secret);
  assert.equal(broker.received.filter((p) => p.type === 'publish').length, 0, 'a scan only reads');
  const subs = broker.received.filter((p) => p.type === 'subscribe').flatMap((p) => p.topics.map((t) => t.topic));
  assert.deepEqual(subs, ['mcc/alive/+']);
  // a cached S is used as it is: a wrong one opens nothing
  const wrong = { [NODE]: '00'.repeat(32) };
  assert.equal(openAliveWith(owner, wrong, NODE, M.alive[0].payload)[0], 'foreign');
  assert.equal(openAliveWith(owner, {}, NODE, new Uint8Array(0))[0], 'empty');
  // newer: a higher (boot, sequence) replaces a lower one
  assert.equal(newer({ boot: 3, sequence: 2 }, { boot: 3, sequence: 1 }), true);
  assert.equal(newer({ boot: 3, sequence: 1 }, { boot: 3, sequence: 1 }), false);
  assert.equal(newer({ boot: 2, sequence: 9 }, { boot: 3, sequence: 1 }), false);
  assert.equal(newer({ boot: 4, sequence: 1 }, { boot: 3, sequence: 9 }), true);
});

test('alive: a refused subscription is said', async () => {
  const { createFakeBroker } = await import('../lib/demo/broker.js');
  const refusing = createFakeBroker({ grant: () => 0x80 });
  await assert.rejects(scanAlive({ config, handle: owner, secrets: {}, waitSecs: 0.3, connect: connectVia(refusing) }), /refused the subscription/);
});
