// The MQTT client against a fake WebSocket and an in-memory broker that speaks real bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMqttClient } from '../lib/protocol/mqtt-client.js';
import { fromUtf8 } from '../lib/bytes.js';
import { createFakeBroker, serverPublish } from '../lib/demo/broker.js';

const tick = (ms = 5) => new Promise((r) => { setTimeout(r, ms); });

async function until(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await tick(2);
  }
}

function client(broker, extra = {}) {
  const messages = [];
  const states = [];
  const c = createMqttClient({
    url: 'wss://broker.test/', username: 'u', password: 'p', clientId: 'test-1', WebSocket: broker.WebSocket,
    onMessage: (topic, payload, packet) => messages.push({ topic, text: fromUtf8(payload), packet }),
    onStatus: (s, d) => states.push([s, d]),
    ...extra,
  });
  return { c, messages, states };
}

for (const chunk of ['whole', 'bytes', 'merge']) {
  test(`a whole session, broker frames ${chunk}`, async () => {
    const broker = createFakeBroker({ chunk, grant: (topic, qos) => (topic.startsWith('no/') ? 0x80 : qos) });
    const { c, messages } = client(broker);
    await c.connect();
    assert.equal(c.state, 'connected');
    const sock = broker.sockets[0];
    assert.deepEqual(sock.protocols, ['mqtt']);
    assert.equal(sock.binaryType, 'arraybuffer');
    const [conn] = broker.connects;
    assert.deepEqual([conn.proto, conn.level, conn.username, conn.password, conn.clientId, conn.keepalive],
      ['MQTT', 4, 'u', 'p', 'test-1', 30]);

    assert.deepEqual(await c.subscribe([{ topic: 'a/+/res', qos: 1 }, { topic: 'no/x', qos: 1 }]), [1, 0x80]);
    assert.deepEqual(await c.subscribe('b/0', 0), [0]);

    await c.publish('a/1/res', 'one', { qos: 1 });                // PUBACK came back
    await c.publish('b/0', Uint8Array.of(0x68, 0x69));            // QoS 0
    await until(() => messages.length === 2);
    assert.deepEqual(messages.map((m) => [m.topic, m.text]), [['a/1/res', 'one'], ['b/0', 'hi']]);
    await until(() => broker.received.some((p) => p.type === 'puback' && p.id === 7));   // we acked QoS 1

    await c.unsubscribe('b/0');
    await c.publish('b/0', 'gone', { qos: 1 });
    await tick(20);
    assert.equal(messages.length, 2);

    await c.close();
    assert.equal(c.state, 'closed');
    assert.ok(broker.received.some((p) => p.type === 'disconnect'));
    await assert.rejects(c.publish('a/1/res', 'x', { qos: 1 }), /not connected/);
  });
}

test('a refused login says why', async () => {
  const broker = createFakeBroker({ auth: () => 4 });
  const { c } = client(broker);
  await assert.rejects(c.connect(), /refused the connection: bad user name or password/);
  assert.equal(c.state, 'closed');
});

test('an unreachable broker and a silent one', async () => {
  const refused = createFakeBroker({ refuseSocket: true });
  await assert.rejects(client(refused).c.connect(), /cannot reach wss:\/\/broker.test\//);
  const silent = createFakeBroker({ auth: () => { throw new Error('never answers'); } });
  silent.handle = () => {};
  const { c } = client(silent, { connectTimeoutMs: 30 });
  await assert.rejects(c.connect(), /did not answer the connection/);
});

test('a socket that closes before it opens is tried again, three times at most', async () => {
  const flaky = (fails) => {
    const good = createFakeBroker();
    const bad = createFakeBroker({ refuseSocket: true });
    let made = 0;
    const WebSocket = function WebSocket(...a) { made += 1; return new (made <= fails ? bad : good).WebSocket(...a); };
    return { good, WebSocket, made: () => made };
  };
  const timers = { setTimeout: (f, ms) => setTimeout(f, [300, 600, 1200].includes(ms) ? 1 : ms), clearTimeout };
  const two = flaky(3);
  const ok = client(two.good, { WebSocket: two.WebSocket, timers });
  await ok.c.connect();
  assert.equal(ok.c.state, 'connected');
  assert.equal(two.made(), 4);
  await ok.c.close();
  const three = flaky(4);
  await assert.rejects(client(three.good, { WebSocket: three.WebSocket, timers }).c.connect(), /cannot reach/);
  assert.equal(three.made(), 4);
  const refused = createFakeBroker({ auth: () => 4 });       // a refusal is not tried again
  await assert.rejects(client(refused, { timers }).c.connect(), /refused the connection/);
  assert.equal(refused.sockets.length, 1);
});

test('keepalive: PINGREQ at half the interval, and a dead broker is noticed', async () => {
  const broker = createFakeBroker();
  const { c, states } = client(broker, { keepalive: 1 });       // a ping every 500 ms
  await c.connect();
  await until(() => broker.received.filter((p) => p.type === 'pingreq').length >= 1, 1500);
  broker.opts.answerPing = false;
  await until(() => c.state === 'closed', 3000);
  assert.match(states.at(-1)[1], /stopped answering/);
});

test('reconnect: backoff, subscriptions renewed, an unacknowledged publish sent again', async () => {
  const broker = createFakeBroker();
  const { c, messages, states } = client(broker, { reconnect: { minMs: 10, maxMs: 40 } });
  await c.connect();
  await c.subscribe([{ topic: 'r/#', qos: 1 }]);
  broker.opts.ackPublish = false;
  const pending = c.publish('r/1', 'again', { qos: 1 });
  await until(() => broker.received.some((p) => p.type === 'publish' && p.topic === 'r/1'));
  broker.opts.ackPublish = true;
  broker.sockets[0].serverClose(1006);
  await until(() => broker.sockets.length === 2 && c.state === 'connected');
  assert.ok(states.some(([s]) => s === 'reconnecting'));
  await pending;                                                  // acked on the new connection
  const resent = broker.received.filter((p) => p.type === 'publish' && p.topic === 'r/1');
  assert.equal(resent.at(-1).dup, true);
  await until(() => broker.received.filter((p) => p.type === 'subscribe').length === 2);
  broker.publish('r/2', 'after');
  await until(() => messages.some((m) => m.topic === 'r/2'));
  await c.close();
});

test('without reconnect a lost connection fails what was waiting', async () => {
  const broker = createFakeBroker({ ackPublish: false });
  const { c } = client(broker);
  await c.connect();
  const p = c.publish('x', 'y', { qos: 1 });
  broker.sockets[0].serverClose(1006);
  await assert.rejects(p, /closed \(1006\)/);
  assert.equal(c.state, 'closed');
});

test('packet size limits both ways, and text frames', async () => {
  const broker = createFakeBroker();
  const { c, states } = client(broker, { maxPacketSize: 64 });
  await c.connect();
  await assert.rejects(c.publish('t', 'x'.repeat(100), { qos: 1 }), /over the limit of 64/);
  broker.sockets[0].deliver(serverPublish('t', 'y'.repeat(100)));
  await until(() => c.state === 'closed');
  assert.match(states.at(-1)[1], /over the limit of 64/);

  const b2 = createFakeBroker();
  const second = client(b2);
  await second.c.connect();
  b2.sockets[0].deliverText('hello');
  await until(() => second.c.state === 'closed');
  assert.match(second.states.at(-1)[1], /text frame/);
});
