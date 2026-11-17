// Integration: the MQTT client against real brokers.
//
// 1. The live command broker (wss://mqtt-meshcore.louie.se/, plan §16): sign in with a token
//    from a throwaway seed made here, subscribe to that key's register-ack topic and a result
//    topic, disconnect. Nothing is published there, ever. MCCONTROL_LIVE=0 skips it (offline).
// 2. A local mosquitto with a websockets listener, spawned on a free port, for publish and
//    subscribe round trips. Skipped with a message when mosquitto is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect as tcpConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyFromSeed } from '../lib/key/handle.js';
import { createMqttClient } from '../lib/protocol/mqtt-client.js';
import { SUBACK_FAILURE } from '../lib/protocol/mqtt-codec.js';
import { brokerUrl, configFor, login, openClient, testConnection } from '../lib/protocol/transport.js';
import { registerAckTopic, resultTopic } from '../lib/protocol/topics.js';
import { fromUtf8 } from '../lib/bytes.js';
import { data } from './protocol-helpers.js';

const throwaway = () => keyFromSeed(globalThis.crypto.getRandomValues(new Uint8Array(32)));

test('live broker: token login, register-ack and result topics granted, no publish', {
  skip: process.env.MCCONTROL_LIVE === '0' ? 'MCCONTROL_LIVE=0' : (!globalThis.WebSocket && 'no WebSocket in this node'),
  timeout: 30000,
}, async () => {
  const handle = throwaway();
  const config = configFor(data('brokers'), 'JKG');
  assert.equal(brokerUrl(config), 'wss://mqtt-meshcore.louie.se/');
  const client = await openClient(config, handle, { timeoutMs: 15000 });
  try {
    const granted = await client.subscribe([
      { topic: registerAckTopic(handle.publicKeyHex), qos: 1 },
      { topic: resultTopic('JKG', handle.publicKeyHex), qos: 1 },
    ]);
    assert.equal(granted.length, 2);
    for (const g of granted) assert.notEqual(g, SUBACK_FAILURE);
  } finally {
    await client.close();
    handle.forget();
  }
});

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

async function waitForPort(port, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const up = await new Promise((resolve) => {
      const s = tcpConnect(port, '127.0.0.1', () => { s.end(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (up) return;
    if (Date.now() > end) throw new Error(`mosquitto did not listen on ${port}`);
    await new Promise((r) => { setTimeout(r, 50); });
  }
}

const mosquitto = spawnSync('mosquitto', ['-h']).error ? null : 'mosquitto';

test('local mosquitto over websockets: publish and subscribe round trips', {
  skip: mosquitto ? false : 'mosquitto is not installed: the local publish/subscribe round trip was not run',
  timeout: 30000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mccontrol-mqtt-'));
  const port = await freePort();
  const conf = join(dir, 'mosquitto.conf');
  writeFileSync(conf, `listener ${port} 127.0.0.1\nprotocol websockets\nallow_anonymous true\n`);
  const proc = spawn(mosquitto, ['-c', conf], { stdio: 'ignore' });
  try {
    await waitForPort(port);
    const handle = throwaway();
    const config = { broker: '127.0.0.1', port, path: '/', insecure: true, region: 'TEST' };
    const [username, password] = login(config, handle);
    const got = [];
    const client = createMqttClient({
      url: brokerUrl(config), username, password, onMessage: (t, p) => got.push([t, fromUtf8(p)]),
    });
    await client.connect();
    assert.deepEqual(await client.subscribe([{ topic: 'mcc/+/res', qos: 1 }, { topic: 'mcc/zero', qos: 0 }]), [1, 0]);
    await client.publish('mcc/a/res', 'one', { qos: 1 });
    await client.publish('mcc/zero', 'two');
    await client.publish('mcc/a/res', 'x'.repeat(70000), { qos: 1 });      // a packet split across frames
    const end = Date.now() + 5000;
    while (got.length < 3 && Date.now() < end) await new Promise((r) => { setTimeout(r, 20); });
    assert.deepEqual(got.slice(0, 2), [['mcc/a/res', 'one'], ['mcc/zero', 'two']]);
    assert.equal(got[2][1].length, 70000);
    await client.unsubscribe('mcc/zero');
    await client.close();
    const steps = await testConnection({ config, handle, timeoutSecs: 5 });
    assert.deepEqual(steps.map((s) => s.ok), [true, true, true, true]);
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
