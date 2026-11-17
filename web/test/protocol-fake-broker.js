// A fake WebSocket and an in-memory MQTT 3.1.1 broker behind it, speaking real bytes, so the
// client and transport are tested end to end without a network. The broker side parses what
// the client writes with its own small reader (not the client's codec), so a codec bug cannot
// hide behind itself.
import { concat, fromUtf8, utf8 } from '../lib/bytes.js';

const u16 = (n) => Uint8Array.of((n >> 8) & 0xff, n & 0xff);
const lenBytes = (n) => {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
  return Uint8Array.from(out);
};
const pkt = (first, body) => concat(Uint8Array.of(first), lenBytes(body.length), body);
const mstr = (s) => { const b = utf8(s); return concat(u16(b.length), b); };

export const serverPublish = (topic, payload, qos = 0, id = 0) => {
  const body = typeof payload === 'string' ? utf8(payload) : payload;
  return pkt(0x30 | (qos << 1), qos ? concat(mstr(topic), u16(id), body) : concat(mstr(topic), body));
};

// Client packets as objects (the broker's view).
function readClientPacket(first, body) {
  const type = first >> 4;
  let at = 0;
  const s = () => { const n = (body[at] << 8) | body[at + 1]; const v = fromUtf8(body.subarray(at + 2, at + 2 + n)); at += 2 + n; return v; };
  const id = () => { const v = (body[at] << 8) | body[at + 1]; at += 2; return v; };
  switch (type) {
    case 1: {
      const proto = s(); const level = body[at]; const flags = body[at + 1]; at += 2;
      const keepalive = id(); const clientId = s();
      const username = flags & 0x80 ? s() : ''; const password = flags & 0x40 ? s() : '';
      return { type: 'connect', proto, level, flags, keepalive, clientId, username, password };
    }
    case 3: {
      const qos = (first >> 1) & 3; const topic = s(); const pid = qos ? id() : null;
      return { type: 'publish', topic, qos, id: pid, dup: (first & 8) === 8, payload: body.slice(at) };
    }
    case 4: return { type: 'puback', id: id() };
    case 8: {
      if ((first & 0x0f) !== 2) throw new Error('SUBSCRIBE flags must be 0010');
      const pid = id(); const topics = [];
      while (at < body.length) { const topic = s(); topics.push({ topic, qos: body[at++] }); }
      return { type: 'subscribe', id: pid, topics };
    }
    case 10: {
      const pid = id(); const topics = [];
      while (at < body.length) topics.push(s());
      return { type: 'unsubscribe', id: pid, topics };
    }
    case 12: return { type: 'pingreq' };
    case 14: return { type: 'disconnect' };
    default: throw new Error(`client sent type ${type}`);
  }
}

export const matches = (filter, topic) => {
  const f = filter.split('/'); const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length || (f[i] !== '+' && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
};

// options:
//   auth(connect) -> CONNACK return code (default 0)
//   grant(topic, qos) -> granted QoS or 0x80 (default qos)
//   onPublish(broker, packet) -> called for every client publish (a node may answer)
//   chunk: 'whole' | 'bytes' | 'merge' -- how outgoing bytes are framed
//   ackPublish, answerPing: default true
export function createFakeBroker(options = {}) {
  const broker = {
    sockets: [], received: [], connects: [], opts: { chunk: 'whole', ackPublish: true, answerPing: true, ...options },
    subs: new Map(),                    // socket -> Map(filter -> qos)
    queue: new Map(),                   // socket -> pending bytes when merging
  };

  broker.write = (sock, bytes) => {
    if (sock.readyState !== 1) return;
    const { chunk } = broker.opts;
    if (chunk === 'bytes') {
      for (const b of bytes) sock.deliver(Uint8Array.of(b));
    } else if (chunk === 'merge') {
      const q = broker.queue.get(sock) || new Uint8Array(0);
      broker.queue.set(sock, concat(q, bytes));
      queueMicrotask(() => {
        const all = broker.queue.get(sock);
        if (all && all.length) { broker.queue.set(sock, new Uint8Array(0)); sock.deliver(all); }
      });
    } else {
      sock.deliver(bytes);
    }
  };

  broker.publish = (topic, payload, { from = null } = {}) => {
    for (const [sock, filters] of broker.subs) {
      for (const [filter, qos] of filters) {
        if (matches(filter, topic)) {
          broker.write(sock, serverPublish(topic, payload, Math.min(qos, 1), qos ? 7 : 0));
          break;
        }
      }
    }
  };

  broker.handle = (sock, p) => {
    broker.received.push(p);
    switch (p.type) {
      case 'connect': {
        broker.connects.push(p);
        const code = broker.opts.auth ? broker.opts.auth(p) : 0;
        broker.write(sock, pkt(0x20, Uint8Array.of(0, code)));
        if (code) sock.serverClose(1000);
        return;
      }
      case 'subscribe': {
        const granted = p.topics.map(({ topic, qos }) => (broker.opts.grant ? broker.opts.grant(topic, qos) : qos));
        const mine = broker.subs.get(sock) || new Map();
        p.topics.forEach(({ topic }, i) => { if (granted[i] !== 0x80) mine.set(topic, granted[i]); });
        broker.subs.set(sock, mine);
        broker.write(sock, pkt(0x90, concat(u16(p.id), Uint8Array.from(granted))));
        return;
      }
      case 'unsubscribe': {
        const mine = broker.subs.get(sock);
        for (const t of p.topics) mine?.delete(t);
        broker.write(sock, pkt(0xb0, u16(p.id)));
        return;
      }
      case 'publish':
        if (p.qos === 1 && broker.opts.ackPublish) broker.write(sock, pkt(0x40, u16(p.id)));
        broker.publish(p.topic, p.payload, { from: sock });
        if (broker.opts.onPublish) broker.opts.onPublish(broker, p);
        return;
      case 'pingreq':
        if (broker.opts.answerPing) broker.write(sock, Uint8Array.of(0xd0, 0));
        return;
      case 'disconnect':
        sock.serverClose(1000);
        return;
      default:
    }
  };

  // The WebSocket class a client is given.
  broker.WebSocket = class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      this.binaryType = 'blob';
      this.sent = [];
      this.buf = new Uint8Array(0);
      broker.sockets.push(this);
      if (broker.opts.refuseSocket) {
        setTimeout(() => { this.readyState = 3; this.onclose?.({ code: 1006 }); }, 0);
        return;
      }
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.({});
      }, 0);
    }

    send(bytes) {
      if (this.readyState !== 1) throw new Error('socket not open');
      this.sent.push(Uint8Array.from(bytes));
      this.buf = concat(this.buf, bytes);
      for (;;) {
        if (this.buf.length < 2) return;
        let len = 0; let mult = 1; let i = 1;
        for (; ; i++) { len += (this.buf[i] & 0x7f) * mult; mult *= 128; if (!(this.buf[i] & 0x80)) break; }
        const total = i + 1 + len;
        if (this.buf.length < total) return;
        const p = readClientPacket(this.buf[0], this.buf.subarray(i + 1, total));
        this.buf = this.buf.slice(total);
        broker.handle(this, p);
      }
    }

    deliver(bytes) {
      if (this.readyState !== 1) return;
      const copy = Uint8Array.from(bytes);
      const data = this.binaryType === 'arraybuffer' ? copy.buffer : copy;
      setTimeout(() => this.onmessage?.({ data }), 0);
    }

    deliverText(text) { setTimeout(() => this.onmessage?.({ data: text }), 0); }

    serverClose(code = 1006) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      broker.subs.delete(this);
      setTimeout(() => this.onclose?.({ code }), 0);
    }

    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      broker.subs.delete(this);
      setTimeout(() => this.onclose?.({ code: 1000 }), 0);
    }
  };

  return broker;
}
