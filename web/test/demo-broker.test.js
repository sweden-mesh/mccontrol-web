// The in-page command server (W-39h): retained messages, as a real broker keeps them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBroker } from '../lib/demo/broker.js';
import { createMqttClient } from '../lib/protocol/mqtt-client.js';
import { fromUtf8 } from '../lib/bytes.js';

const client = (broker, onMessage) => createMqttClient({ url: 'wss://demo.invalid/', WebSocket: broker.WebSocket, onMessage });
const tick = () => new Promise((ok) => setTimeout(ok, 20));

test('a retained message reaches a later subscriber whose filter matches, and only the newest', async () => {
  const broker = createFakeBroker();
  broker.retain('mcc/alive/AA', 'one');
  broker.retain('mcc/alive/AA', 'two');
  broker.retain('mcc/alive/BB', 'bee');
  broker.retain('other/x', 'no');
  const got = [];
  const c = client(broker, (topic, bytes) => got.push([topic, fromUtf8(bytes)]));
  await c.connect();
  await c.subscribe([{ topic: 'mcc/alive/+', qos: 1 }]);
  await tick();
  assert.deepEqual(got.sort(), [['mcc/alive/AA', 'two'], ['mcc/alive/BB', 'bee']]);
  await c.close();
});

test('an empty retained payload clears the topic; a live subscriber hears each change', async () => {
  const broker = createFakeBroker();
  const live = [];
  const a = client(broker, (topic, bytes) => live.push([topic, bytes.length]));
  await a.connect();
  await a.subscribe([{ topic: 'mcc/alive/+', qos: 0 }]);
  broker.retain('mcc/alive/AA', 'up');
  broker.retain('mcc/alive/AA', '');
  await tick();
  assert.deepEqual(live, [['mcc/alive/AA', 2], ['mcc/alive/AA', 0]]);
  const late = [];
  const b = client(broker, (topic) => late.push(topic));
  await b.connect();
  await b.subscribe([{ topic: '#', qos: 0 }]);
  await tick();
  assert.deepEqual(late, []);
  await a.close(); await b.close();
});
