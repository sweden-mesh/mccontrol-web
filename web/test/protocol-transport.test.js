// transport.js against the in-memory broker, with a simulated node that verifies our
// signature, opens v2, and answers r1, r2 or r3 the way the firmware does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '../vendor/noble-curves/ed25519.js';
import { createMqttClient } from '../lib/protocol/mqtt-client.js';
import { brokerUrl, configFor, discover, login, register, send, testConnection } from '../lib/protocol/transport.js';
import { openSealed, pad, seal, signedMessage, v2Key } from '../lib/protocol/envelope.js';
import { DIR_COMMAND, DIR_RESULT, R3_PADS } from '../lib/protocol/constants.js';
import { commandTopic, registerAckTopic } from '../lib/protocol/topics.js';
import { b64url, unb64url } from '../lib/protocol/text.js';
import { fromHex, fromUtf8, toHex, utf8 } from '../lib/bytes.js';
import { createFakeBroker } from './protocol-fake-broker.js';
import { V, data, nodeHandle, ownerHandle } from './protocol-helpers.js';

const owner = ownerHandle();
const node = nodeHandle();
const NODE = V.node_key.slice(0, 8);
const config = { ...configFor(data('brokers'), 'jkg'), wait_secs: 2 };

// The node: checks the outer signature, answers v1 as r2 (signed) and v2 as r3 (sealed).
function nodeBroker({ answer = true, refuse = null, refuseV2 = null, extra = [] } = {}) {
  return createFakeBroker({
    chunk: 'merge',
    onPublish(broker, p) {
      const text = fromUtf8(p.payload);
      if (p.topic === 'mccontrol/register') {
        broker.publish(registerAckTopic(text.split('|')[1]), 'ok');
        return;
      }
      if (!p.topic.endsWith('/cmd') || !answer) return;
      const split = text.lastIndexOf('|');
      const ok = ed25519.verify(fromHex(text.slice(split + 1)), signedMessage(p.topic, text.slice(0, split)),
        fromHex(owner.publicKeyHex));
      if (!ok) return;                                // a node publishes nothing for a bad signature
      const [tag, counter, expiry, body] = text.slice(0, split).split('|');
      const res = p.topic.replace(/cmd$/, 'res').replace(/\/all\//, `/${V.node_key}/`);
      for (const line of extra) broker.publish(line[0], line[1]);
      if (tag === 'v2' && refuseV2 !== null) {        // refused: a node-signed r2, the command field empty (OTM-8)
        const line = `r2|${counter}|${refuseV2}||`;
        broker.publish(res, `${line}|${toHex(node.sign(signedMessage(res, line)), true)}`);
        return;
      }
      if (tag === 'v2') {
        const key = v2Key(node, owner.publicKeyHex, p.topic);
        const command = fromUtf8(openSealed(key, DIR_COMMAND, Number(counter), utf8(`v2|${counter}|${expiry}`), unb64url(body)))
          .replace(/\0+$/, '');
        const plain = pad(utf8(`0|${command}|> sealed ${command}`), R3_PADS);
        const sealed = seal(key, DIR_RESULT, Number(counter), utf8(`r3|${counter}`), plain);
        broker.publish(res, `r3|${counter}|${b64url(sealed)}`);
        return;
      }
      const code = refuse ?? 0;
      const line = `r2|${counter}|${code}|${body}|> answer to ${body}`;
      const sig = toHex(node.sign(signedMessage(res, line)), true);
      broker.publish(res, `${line}|${sig}`);
    },
  });
}

const connectVia = (broker) => (opts) => createMqttClient({ ...opts, WebSocket: broker.WebSocket });

test('config, URL and login', () => {
  assert.equal(config.broker, 'mqtt-meshcore.louie.se');
  assert.equal(config.region, 'JKG');
  assert.equal(brokerUrl(config), 'wss://mqtt-meshcore.louie.se/');
  assert.equal(brokerUrl({ broker: 'localhost', port: 9001, path: '/mqtt', insecure: true }), 'ws://localhost:9001/mqtt');
  const [user, pass] = login(config, owner, { now: V.token.now });
  assert.equal(user, V.token.username);
  assert.equal(pass, V.token.password);
  assert.deepEqual(login({ ...config, username: 'a', password: 'b' }, owner), ['a', 'b']);
  assert.deepEqual(login(config, null), ['', '']);
});

test('send v1: the node answers r2, verified against its key', async () => {
  const broker = nodeBroker();
  const topic = commandTopic('JKG', NODE, V.node_key);
  const ticks = [];
  const { payload, answers } = await send({
    config, handle: owner, topic, command: 'get name', nodesToHear: [NODE], keys: { [NODE]: V.node_key },
    waitSecs: 2, connect: connectVia(broker), progress: (e, t, a) => { ticks.push(a.length); },
  });
  assert.match(payload, /^v1\|/);
  assert.equal(answers[NODE].reply, '> answer to get name');
  assert.equal(answers[NODE].verified, true);
  assert.equal(answers[NODE].ok, true);
  assert.equal(broker.connects[0].username, V.token.username);
  assert.ok(broker.received.some((p) => p.type === 'disconnect'));
  // subscribed before publishing
  const kinds = broker.received.map((p) => p.type);
  assert.ok(kinds.indexOf('subscribe') < kinds.indexOf('publish'));
  assert.ok(ticks.length >= 1);
});

test('send v2: sealed both ways, opened with the same key', async () => {
  const broker = nodeBroker();
  const topic = commandTopic('JKG', NODE, V.node_key);
  const { payload, answers } = await send({
    config, handle: owner, topic, command: 'ver', nodesToHear: [NODE], v2Key: V.node_key, keys: { [NODE]: V.node_key },
    waitSecs: 2, connect: connectVia(broker),
  });
  assert.match(payload, /^v2\|/);
  assert.equal(answers[NODE].reply, '> sealed ver');
  assert.equal(answers[NODE].verified, true);
});

test('send v2 refused: the node-signed r2 with no command is verified and names the command sent (OTM-8)', async () => {
  const broker = nodeBroker({ refuseV2: 9 });
  const topic = commandTopic('JKG', NODE, V.node_key);
  const { answers } = await send({
    config, handle: owner, topic, command: 'get name', nodesToHear: [NODE], v2Key: V.node_key, keys: { [NODE]: V.node_key },
    waitSecs: 2, connect: connectVia(broker),
  });
  assert.equal(answers[NODE].verified, true);
  assert.equal(answers[NODE].code, 9);
  assert.equal(answers[NODE].command, 'get name');
  assert.equal(answers[NODE].ok, false);
});

test('send: silence is silence, another region and an old counter are not answers', async () => {
  const other = `meshcore/VGR/${V.node_key}/res`;
  const broker = nodeBroker({ answer: false });
  const started = Date.now();
  const { answers } = await send({
    config, handle: owner, topic: commandTopic('JKG', NODE, V.node_key), command: 'ver',
    nodesToHear: [NODE], waitSecs: 0.3, connect: connectVia(broker),
  });
  assert.deepEqual(answers, {});
  assert.ok(Date.now() - started >= 280);
  // a cancel from the progress callback stops the wait at once
  const b2 = nodeBroker({ answer: false, extra: [[other, 'r1|1|0|ver|x']] });
  const t0 = Date.now();
  await send({ config, handle: owner, topic: commandTopic('JKG', NODE), command: 'ver', nodesToHear: [NODE],
    waitSecs: 5, connect: connectVia(b2), progress: () => true });
  assert.ok(Date.now() - t0 < 1000);
});

test('discover: a broadcast read, every node that answers', async () => {
  const broker = nodeBroker({ refuse: 17 });
  const found = await discover({ config, handle: owner, region: 'jkg', waitSecs: 0.3, connect: connectVia(broker) });
  assert.equal(found.length, 1);
  assert.deepEqual({ ...found[0] }, { node: NODE, region: 'JKG', code: 17, reply: '> answer to get autoreply', key: V.node_key, verified: true });
  const pub = broker.received.find((p) => p.type === 'publish');
  assert.equal(pub.topic, 'meshcore/JKG/all/cmd');
  const sub = broker.received.find((p) => p.type === 'subscribe');
  assert.deepEqual(sub.topics, [{ topic: 'meshcore/JKG/+/res', qos: 1 }]);
});

test('register: the signed line, and the broker\'s ok', async () => {
  const broker = nodeBroker();
  assert.deepEqual(await register({ config, handle: owner, waitSecs: 2, connect: connectVia(broker) }), { ok: true, detail: 'ok' });
  const silent = createFakeBroker();
  const r = await register({ config, handle: owner, waitSecs: 0.2, connect: connectVia(silent) });
  assert.equal(r.ok, false);
  assert.match(r.detail, /no acknowledgement/);
});

test('test connection: every step, and where it stops', async () => {
  const broker = createFakeBroker();
  const steps = await testConnection({ config, handle: owner, timeoutSecs: 2, connect: connectVia(broker) });
  assert.deepEqual(steps.map((s) => s.ok), [true, true, true, true]);
  assert.equal(steps[1].detail, `meshcore/TEST/${owner.publicKeyHex}/res`);

  const refusing = createFakeBroker({ grant: () => 0x80 });
  const s2 = await testConnection({ config, handle: owner, timeoutSecs: 2, connect: connectVia(refusing) });
  assert.deepEqual(s2.map((s) => s.ok), [true, false]);
  assert.match(s2[1].detail, /refused the subscription/);

  const badLogin = createFakeBroker({ auth: () => 5 });
  const s3 = await testConnection({ config, handle: owner, timeoutSecs: 2, connect: connectVia(badLogin) });
  assert.deepEqual(s3.map((s) => [s.step, s.ok]), [['connect and sign in', false]]);
  assert.match(s3[0].detail, /not authorized/);
});
