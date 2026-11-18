// lib/mesh/tcp.js (W-31c): the companion through mccontrol-bridge over one WebSocket. A fake
// socket stands in for the bridge: one binary message is one frame each way, the token goes
// first as text, and each way the bridge (or the browser) can refuse is said by its cause.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetworkError, bridgeUrl, connectNetwork, privateLiteral } from '../lib/mesh/tcp.js';
import { openCompanion } from '../lib/mesh/companion.js';
import { concat, utf8 } from '../lib/bytes.js';
import { CMD, RESP } from '../lib/mesh/frames.js';

// opts: { refuse: closeCode before open, throwName, closeAfterOpen: code }
function fakeSocket(opts = {}) {
  const made = [];
  class FakeSocket {
    constructor(url) {
      if (opts.throwName) { const e = new Error('blocked'); e.name = opts.throwName; throw e; }
      this.url = url; this.sent = []; this.readyState = 0; made.push(this);
      setTimeout(() => {
        if (opts.refuse !== undefined) { this.readyState = 3; this.onclose?.({ code: opts.refuse }); return; }
        if (opts.silent) return;
        this.readyState = 1; this.onopen?.({});
      }, 0);
    }
    send(data) {
      this.sent.push(data);
      if (data instanceof Uint8Array && data[0] === CMD.APP_START) {
        const self = concat(Uint8Array.of(RESP.SELF_INFO, 1, 22, 22), new Uint8Array(32).fill(0xab), new Uint8Array(22), utf8('LouHome'));
        setTimeout(() => this.onmessage?.({ data: self.buffer.slice(0) }), 0);
      }
    }
    close(code = 1000) { this.readyState = 3; setTimeout(() => this.onclose?.({ code }), 0); }
    serverClose(code) { this.readyState = 3; this.onclose?.({ code }); }
  }
  return { FakeSocket, made };
}

test('the address: ws:// only to a private IP literal from an https page; wss:// to a name; nothing after the port', () => {
  assert.equal(bridgeUrl('ws://192.168.1.20:8765', { pageSecure: true }), 'ws://192.168.1.20:8765');
  assert.equal(bridgeUrl(' ws://10.0.0.5:8765/ ', { pageSecure: true }), 'ws://10.0.0.5:8765');
  assert.equal(bridgeUrl('wss://bridge.example.org:8765', { pageSecure: true }), 'wss://bridge.example.org:8765');
  assert.throws(() => bridgeUrl('ws://bridge.lan:8765', { pageSecure: true }), (e) => e.code === 'mixedContent');
  assert.throws(() => bridgeUrl('ws://8.8.8.8:8765', { pageSecure: true }), (e) => e.code === 'mixedContent');
  assert.equal(bridgeUrl('ws://bridge.lan:8765', { pageSecure: false }), 'ws://bridge.lan:8765', 'a local http copy may');
  for (const bad of ['', 'http://10.0.0.5:8765', 'ws://10.0.0.5', 'ws://10.0.0.5:8765/x', 'ws://u:p@10.0.0.5:8765', 'nonsense']) {
    assert.throws(() => bridgeUrl(bad, { pageSecure: true }), (e) => e instanceof NetworkError && e.code === 'badUrl', bad);
  }
  for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.1', '127.0.0.1', '[::1]', '[fd00::1]', '100.64.0.1']) assert.ok(privateLiteral(ip), ip);
  for (const ip of ['172.32.0.1', '8.8.8.8', 'bridge.local', '[2001:db8::1]']) assert.ok(!privateLiteral(ip), ip);
});

test('one binary message is one frame both ways; the token goes first, as text; the companion opens over it', async () => {
  const { FakeSocket, made } = fakeSocket();
  const link = await connectNetwork('wss://bridge.example.org:8765', { token: 's3cret', WebSocket: FakeSocket, pageSecure: true });
  assert.equal(link.kind, 'network');
  assert.equal(link.label, 'bridge.example.org:8765');
  const ws = made[0];
  assert.equal(ws.binaryType, 'arraybuffer');
  assert.equal(ws.sent[0], 's3cret');
  const companion = await openCompanion(link);
  assert.equal(companion.self.name, 'LouHome');
  assert.ok(ws.sent[1] instanceof Uint8Array);
  assert.equal(ws.sent[1][0], CMD.APP_START, 'no < header: the frame alone');
  let closedWith = 'not yet';
  link.onClose((why) => { closedWith = why; });
  ws.serverClose(1011);
  assert.equal(closedWith.code, 'companion');
  await assert.rejects(link.write(Uint8Array.of(1)), (e) => e.code === 'companion');
});

test('no token: nothing but frames is sent', async () => {
  const { FakeSocket, made } = fakeSocket();
  const link = await connectNetwork('ws://192.168.1.20:8765', { WebSocket: FakeSocket, pageSecure: true });
  await link.write(Uint8Array.of(4));
  assert.equal(made[0].sent.length, 1);
  assert.ok(made[0].sent[0] instanceof Uint8Array);
});

test('each refusal is said by its cause', async () => {
  const cases = [[1008, 'token'], [1013, 'busy'], [1011, 'companion'], [1009, 'tooBig'], [1006, 'unreachable']];
  for (const [code, want] of cases) {
    const { FakeSocket } = fakeSocket({ refuse: code });
    await assert.rejects(connectNetwork('ws://10.0.0.5:8765', { WebSocket: FakeSocket, pageSecure: true }), (e) => e.code === want, String(code));
  }
  const unreachable = fakeSocket({ refuse: 1006 });
  await assert.rejects(connectNetwork('ws://10.0.0.5:8765', { WebSocket: unreachable.FakeSocket, pageSecure: true }),
    /local-network permission was refused, the bridge is not running there, or it refused this page/);
  const blocked = fakeSocket({ throwName: 'SecurityError' });
  await assert.rejects(connectNetwork('ws://10.0.0.5:8765', { WebSocket: blocked.FakeSocket, pageSecure: true }), (e) => e.code === 'mixedContent');
  const silent = fakeSocket({ silent: true });
  await assert.rejects(connectNetwork('ws://10.0.0.5:8765', { WebSocket: silent.FakeSocket, pageSecure: true, timeoutMs: 50 }), (e) => e.code === 'unreachable');
  await assert.rejects(connectNetwork('ws://bridge.lan:8765', { WebSocket: silent.FakeSocket, pageSecure: true }), (e) => e.code === 'mixedContent');
});
