// An MQTT 3.1.1 client over one WebSocket (subprotocol "mqtt", binary frames). Our own, not a
// library (vendor/VENDOR.md says why). No DOM: the WebSocket constructor and the timers are
// parameters, so a test can pass fakes.
//
//   const client = createMqttClient({ url, username, password, onMessage });
//   await client.connect();                       // resolves on CONNACK 0, rejects otherwise
//   const granted = await client.subscribe([{ topic, qos: 1 }]);   // [1] or [0x80] per topic
//   await client.publish(topic, payload, { qos: 1 });               // resolves on PUBACK
//   await client.close();                         // DISCONNECT, then the socket closes
//
// With `reconnect`, a connection lost after it was up is opened again after a growing delay
// (minMs, doubling, up to maxMs), its subscriptions renewed and unacknowledged QoS 1
// publishes sent again with DUP. Without it (the default, and what transport uses: one
// connection per command), a lost connection fails whatever was waiting.
import {
  CONNACK_REASONS, SUBACK_FAILURE, createReader, encodeConnect, encodeDisconnect, encodePingreq,
  encodePuback, encodePublish, encodeSubscribe, encodeUnsubscribe,
} from './mqtt-codec.js';
import { toHex } from '../bytes.js';

export const SUBPROTOCOL = 'mqtt';

const randomClientId = () => `mccontrol-${toHex(globalThis.crypto.getRandomValues(new Uint8Array(6)))}`;

function asBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export function createMqttClient({
  url,
  username = '',
  password = '',
  clientId = randomClientId(),
  keepalive = 30,
  connectTimeoutMs = 10000,
  maxPacketSize = 256 * 1024,
  reconnect = null,                    // { minMs = 1000, maxMs = 30000 } to reconnect
  WebSocket: Socket = globalThis.WebSocket,
  timers = globalThis,                 // { setTimeout, clearTimeout }
  onMessage = () => {},                // (topic, payloadBytes, packet)
  onStatus = () => {},                 // (state, detail): connecting, connected, reconnecting, closed
} = {}) {
  if (!Socket) throw new Error('this browser has no WebSocket');
  let ws = null;
  let reader = null;
  let state = 'idle';
  let wanted = false;                  // close() not called: a loss is unexpected
  let attempts = 0;
  let nextId = 1;
  let pingTimer = null;
  let pingOutstanding = false;
  let reconnectTimer = null;
  let connectWaiter = null;
  const pending = new Map();           // packet id -> { kind, resolve, reject, packet }
  const subscriptions = new Map();     // topic -> qos, renewed on reconnect

  const status = (s, detail) => { state = s; onStatus(s, detail); };

  function allocateId() {
    for (let n = 0; n < 0xffff; n++) {
      const id = nextId;
      nextId = nextId === 0xffff ? 1 : nextId + 1;
      if (!pending.has(id)) return id;
    }
    throw new Error('too many MQTT packets waiting for an answer');
  }

  function write(bytes) {
    if (bytes.length > maxPacketSize) throw new Error(`the packet is ${bytes.length} bytes, over the limit of ${maxPacketSize}`);
    if (!ws || ws.readyState !== 1) throw new Error('not connected to the broker');
    ws.send(bytes);
  }

  function schedulePing() {
    if (pingTimer) timers.clearTimeout(pingTimer);
    pingTimer = null;
    if (!keepalive) return;
    // Half the keepalive: the broker allows one and a half before it gives up on us.
    pingTimer = timers.setTimeout(() => {
      if (pingOutstanding) {
        drop(new Error('the broker stopped answering (no PINGRESP)'));
        return;
      }
      pingOutstanding = true;
      try { write(encodePingreq()); } catch { /* the close handler reports it */ }
      schedulePing();
    }, (keepalive * 1000) / 2);
  }

  function failPending(err, keepPublishes) {
    for (const [id, p] of pending) {
      if (keepPublishes && p.kind === 'publish') continue;
      pending.delete(id);
      p.reject(err);
    }
  }

  function stopTimers() {
    if (pingTimer) timers.clearTimeout(pingTimer);
    pingTimer = null;
  }

  // The connection is gone (or must be): tidy up, then reconnect or report.
  function drop(err) {
    stopTimers();
    const old = ws;
    ws = null;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try { old.close(); } catch { /* already closing */ }
    }
    if (connectWaiter) {
      const w = connectWaiter;
      connectWaiter = null;
      w.reject(err);
    }
    const again = wanted && reconnect && state === 'connected';
    failPending(err, again);
    if (again || (wanted && reconnect && state === 'reconnecting')) {
      const min = reconnect.minMs ?? 1000;
      const max = reconnect.maxMs ?? 30000;
      const delay = Math.min(max, min * 2 ** attempts);
      attempts += 1;
      status('reconnecting', `${err.message}; again in ${Math.round(delay / 1000)} s`);
      reconnectTimer = timers.setTimeout(() => {
        reconnectTimer = null;
        open().then(resume, () => {});
      }, delay);
      return;
    }
    if (state !== 'closed') status('closed', err.message);
  }

  function onPacket(p) {
    switch (p.type) {
      case 'connack': {
        if (!connectWaiter) return;
        const w = connectWaiter;
        connectWaiter = null;
        if (p.returnCode === 0) {
          attempts = 0;
          status('connected', '');
          schedulePing();
          w.resolve();
        } else {
          const why = CONNACK_REASONS[p.returnCode] ?? `return code ${p.returnCode}`;
          const err = new Error(`the broker refused the connection: ${why}`);
          wanted = false;               // a refusal is not something a retry fixes
          drop(err);
          w.reject(err);
        }
        return;
      }
      case 'publish':
        if (p.qos === 1) {
          try { write(encodePuback(p.id)); } catch { /* lost; the broker sends it again */ }
        }
        onMessage(p.topic, p.payload, p);
        return;
      case 'puback':
      case 'suback':
      case 'unsuback': {
        const waiting = pending.get(p.id);
        const kind = { puback: 'publish', suback: 'subscribe', unsuback: 'unsubscribe' }[p.type];
        if (!waiting || waiting.kind !== kind) return;
        pending.delete(p.id);
        waiting.resolve(p.type === 'suback' ? p.granted : undefined);
        return;
      }
      case 'pingresp':
        pingOutstanding = false;
        return;
      default:
        drop(new Error(`unexpected ${p.type} from the broker`));
    }
  }

  // Open the socket and sign in; resolves on CONNACK 0.
  function open() {
    return new Promise((resolve, reject) => {
      status(state === 'reconnecting' ? 'reconnecting' : 'connecting', url);
      reader = createReader({ maxPacketSize });
      pingOutstanding = false;
      let socket;
      try {
        socket = new Socket(url, [SUBPROTOCOL]);
      } catch (e) {
        reject(new Error(`cannot reach ${url}: ${e.message}`));
        return;
      }
      ws = socket;
      socket.binaryType = 'arraybuffer';
      const timer = timers.setTimeout(() => {
        drop(new Error(`${url} did not answer the connection in ${Math.round(connectTimeoutMs / 1000)} s`));
      }, connectTimeoutMs);
      connectWaiter = {
        resolve: () => { timers.clearTimeout(timer); resolve(); },
        reject: (e) => { timers.clearTimeout(timer); reject(e); },
      };
      socket.onopen = () => {
        try {
          write(encodeConnect({ clientId, username, password, keepalive }));
        } catch (e) {
          drop(e);
        }
      };
      socket.onmessage = (ev) => {
        const bytes = asBytes(ev.data);
        if (!bytes) {
          drop(new Error('the broker sent a text frame; MQTT is binary'));
          return;
        }
        let packets;
        try {
          packets = reader.push(bytes);
        } catch (e) {
          drop(e);
          return;
        }
        for (const p of packets) onPacket(p);
      };
      socket.onerror = () => { /* the close event follows with the code */ };
      socket.onclose = (ev) => {
        const why = connectWaiter ? `cannot reach ${url}` : 'the connection to the broker closed';
        drop(new Error(ev && ev.code && ev.code !== 1000 && ev.code !== 1005 ? `${why} (${ev.code})` : why));
      };
    });
  }

  // After a reconnect: the subscriptions again, then the publishes the broker never acknowledged.
  function resume() {
    if (subscriptions.size) {
      const topics = [...subscriptions].map(([topic, qos]) => ({ topic, qos }));
      const id = allocateId();
      pending.set(id, { kind: 'subscribe', resolve: () => {}, reject: () => {} });
      try { write(encodeSubscribe(id, topics)); } catch { /* the close handler reports it */ }
    }
    for (const [id, p] of pending) {
      if (p.kind !== 'publish') continue;
      try { write(encodePublish({ ...p.packet, id, dup: true })); } catch { /* reported on close */ }
    }
  }

  function request(kind, bytesFor, extra = {}) {
    return new Promise((resolve, reject) => {
      const id = allocateId();
      const bytes = bytesFor(id);
      pending.set(id, { kind, resolve, reject, ...extra });
      try {
        write(bytes);
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  }

  return Object.freeze({
    get state() { return state; },

    connect() {
      if (state === 'connected') return Promise.resolve();
      wanted = true;
      return open();
    },

    // topics: a topic string, or [{ topic, qos }]. Resolves to the granted QoS per topic as
    // the SUBACK gives it: 0, 1, 2, or 0x80 (SUBACK_FAILURE) for a refusal.
    async subscribe(topics, qos = 1) {
      const list = typeof topics === 'string' ? [{ topic: topics, qos }] : topics;
      const granted = await request('subscribe', (id) => encodeSubscribe(id, list));
      list.forEach(({ topic, qos: q = 0 }, i) => {
        if (granted[i] !== SUBACK_FAILURE) subscriptions.set(topic, q);
      });
      return granted;
    },

    async unsubscribe(topics) {
      const list = typeof topics === 'string' ? [topics] : topics;
      await request('unsubscribe', (id) => encodeUnsubscribe(id, list));
      for (const t of list) subscriptions.delete(t);
    },

    // QoS 0 resolves once written; QoS 1 on the broker's PUBACK.
    publish(topic, payload, { qos = 0, retain = false } = {}) {
      if (qos === 0) {
        try {
          write(encodePublish({ topic, payload, qos: 0, retain }));
          return Promise.resolve();
        } catch (e) {
          return Promise.reject(e);
        }
      }
      return request('publish', (id) => encodePublish({ topic, payload, qos, id, retain }),
        { packet: { topic, payload, qos, retain } });
    },

    // A clean disconnect: DISCONNECT, then the socket closes. Never reconnects afterwards.
    close() {
      wanted = false;
      if (reconnectTimer) timers.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      stopTimers();
      const socket = ws;
      if (socket && socket.readyState === 1) {
        try { socket.send(encodeDisconnect()); } catch { /* closing anyway */ }
      }
      status('closed', 'disconnected');
      drop(new Error('disconnected'));
      return Promise.resolve();
    },
  });
}
