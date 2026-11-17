// MQTT 3.1.1 packets, as bytes: what the client writes and a streaming reader for what the
// broker sends. Only what the app needs: CONNECT/CONNACK, SUBSCRIBE/SUBACK,
// UNSUBSCRIBE/UNSUBACK, PUBLISH at QoS 0 and 1 with PUBACK, PINGREQ/PINGRESP, DISCONNECT.
// Spec: MQTT Version 3.1.1, OASIS Standard, 29 October 2014.
import { concat, utf8 } from '../bytes.js';

export const TYPE = Object.freeze({
  CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4, PUBREC: 5, PUBREL: 6, PUBCOMP: 7, SUBSCRIBE: 8,
  SUBACK: 9, UNSUBSCRIBE: 10, UNSUBACK: 11, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14,
});

export const MAX_REMAINING = 268435455;            // four length bytes, the protocol's limit
export const SUBACK_FAILURE = 0x80;

// What a CONNACK's return code means (3.2.2.3).
export const CONNACK_REASONS = Object.freeze({
  0: 'accepted',
  1: 'unacceptable protocol version',
  2: 'client identifier rejected',
  3: 'server unavailable',
  4: 'bad user name or password',
  5: 'not authorized',
});

export function encodeLength(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_REMAINING) throw new Error(`an MQTT packet holds at most ${MAX_REMAINING} bytes`);
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Uint8Array.from(out);
}

const u16 = (n) => Uint8Array.of((n >> 8) & 0xff, n & 0xff);

function str(text) {
  const bytes = typeof text === 'string' ? utf8(text) : text;
  if (bytes.length > 0xffff) throw new Error('an MQTT string is at most 65535 bytes');
  return concat(u16(bytes.length), bytes);
}

const packet = (first, ...body) => {
  const rest = concat(...body);
  return concat(Uint8Array.of(first), encodeLength(rest.length), rest);
};

function checkId(id) {
  if (!Number.isInteger(id) || id < 1 || id > 0xffff) throw new Error('a packet id is 1..65535');
}

function checkTopic(topic, wildcards) {
  if (typeof topic !== 'string' || !topic) throw new Error('a topic is a non-empty string');
  if (topic.includes('\0')) throw new Error('a topic may not hold a NUL');
  if (!wildcards && /[+#]/.test(topic)) throw new Error('a topic to publish to has no wildcards');
}

export function encodeConnect({ clientId, username = '', password = '', keepalive = 30, clean = true }) {
  let flags = clean ? 0x02 : 0;
  const fields = [str(clientId)];
  if (username) { flags |= 0x80; fields.push(str(username)); }
  if (password) {
    if (!username) throw new Error('MQTT 3.1.1 sends a password only with a user name');
    flags |= 0x40;
    fields.push(str(password));
  }
  if (!Number.isInteger(keepalive) || keepalive < 0 || keepalive > 0xffff) throw new Error('keepalive is 0..65535 s');
  return packet(TYPE.CONNECT << 4, str('MQTT'), Uint8Array.of(4, flags), u16(keepalive), ...fields);
}

// topics: [{ topic, qos }]
export function encodeSubscribe(id, topics) {
  checkId(id);
  if (!topics.length) throw new Error('a subscription names at least one topic');
  const body = topics.flatMap(({ topic, qos = 0 }) => {
    checkTopic(topic, true);
    if (![0, 1, 2].includes(qos)) throw new Error('QoS is 0, 1 or 2');
    return [str(topic), Uint8Array.of(qos)];
  });
  return packet((TYPE.SUBSCRIBE << 4) | 0x02, u16(id), ...body);
}

export function encodeUnsubscribe(id, topics) {
  checkId(id);
  if (!topics.length) throw new Error('an unsubscription names at least one topic');
  return packet((TYPE.UNSUBSCRIBE << 4) | 0x02, u16(id), ...topics.map((t) => { checkTopic(t, true); return str(t); }));
}

// payload: a string (sent as UTF-8) or bytes. id only for QoS 1.
export function encodePublish({ topic, payload = new Uint8Array(0), qos = 0, id, retain = false, dup = false }) {
  checkTopic(topic, false);
  if (qos !== 0 && qos !== 1) throw new Error('this client publishes at QoS 0 or 1');
  const body = typeof payload === 'string' ? utf8(payload) : payload;
  const first = (TYPE.PUBLISH << 4) | (dup ? 0x08 : 0) | (qos << 1) | (retain ? 1 : 0);
  if (qos === 0) return packet(first, str(topic), body);
  checkId(id);
  return packet(first, str(topic), u16(id), body);
}

export const encodePuback = (id) => { checkId(id); return packet(TYPE.PUBACK << 4, u16(id)); };
export const encodePingreq = () => Uint8Array.of(TYPE.PINGREQ << 4, 0);
export const encodeDisconnect = () => Uint8Array.of(TYPE.DISCONNECT << 4, 0);

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

// One whole packet's fixed-header byte and body as an object.
export function parsePacket(first, body) {
  const type = first >> 4;
  const flags = first & 0x0f;
  const id = () => {
    if (body.length < 2) throw new Error('a packet id is missing');
    return (body[0] << 8) | body[1];
  };
  switch (type) {
    case TYPE.CONNACK:
      if (body.length !== 2) throw new Error('a CONNACK is 2 bytes');
      return { type: 'connack', sessionPresent: (body[0] & 1) === 1, returnCode: body[1] };
    case TYPE.PUBLISH: {
      const qos = (flags >> 1) & 3;
      if (qos === 3) throw new Error('PUBLISH with QoS 3');
      if (body.length < 2) throw new Error('a PUBLISH without a topic');
      const len = (body[0] << 8) | body[1];
      let at = 2 + len;
      if (body.length < at) throw new Error('a PUBLISH topic runs past the packet');
      const topic = utf8Strict.decode(body.subarray(2, at));
      let packetId = null;
      if (qos > 0) {
        if (body.length < at + 2) throw new Error('a PUBLISH without its packet id');
        packetId = (body[at] << 8) | body[at + 1];
        at += 2;
      }
      return {
        type: 'publish', topic, payload: body.slice(at), qos, id: packetId,
        retain: (flags & 1) === 1, dup: (flags & 8) === 8,
      };
    }
    case TYPE.PUBACK: return { type: 'puback', id: id() };
    case TYPE.PUBREC: return { type: 'pubrec', id: id() };
    case TYPE.PUBREL: return { type: 'pubrel', id: id() };
    case TYPE.PUBCOMP: return { type: 'pubcomp', id: id() };
    case TYPE.SUBACK: return { type: 'suback', id: id(), granted: [...body.subarray(2)] };
    case TYPE.UNSUBACK: return { type: 'unsuback', id: id() };
    case TYPE.PINGRESP: return { type: 'pingresp' };
    default: throw new Error(`a broker does not send MQTT packet type ${type}`);
  }
}

// A reader fed WebSocket messages as they come: a packet may be split across messages, or
// several may share one. push(bytes) returns the whole packets completed so far. A packet
// over `maxPacketSize` bytes (header included) throws before it is buffered.
export function createReader({ maxPacketSize = 256 * 1024 } = {}) {
  let buf = new Uint8Array(0);
  return {
    push(bytes) {
      buf = buf.length ? concat(buf, bytes) : Uint8Array.from(bytes);
      const out = [];
      for (;;) {
        if (buf.length < 2) break;
        let len = 0;
        let mult = 1;
        let i = 1;
        let complete = false;
        for (; i < buf.length && i <= 4; i++) {
          len += (buf[i] & 0x7f) * mult;
          mult *= 128;
          if ((buf[i] & 0x80) === 0) { complete = true; break; }
        }
        if (!complete) {
          if (i > 4) throw new Error('a malformed MQTT length');
          break;
        }
        const total = i + 1 + len;
        if (total > maxPacketSize) throw new Error(`the broker sent a packet of ${total} bytes, over the limit of ${maxPacketSize}`);
        if (buf.length < total) break;
        out.push(parsePacket(buf[0], buf.subarray(i + 1, total)));
        buf = buf.subarray(total);
      }
      return out;
    },
    get buffered() { return buf.length; },
  };
}
