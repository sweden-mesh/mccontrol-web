// The MQTT 3.1.1 codec against byte sequences built by hand from the specification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReader, encodeConnect, encodeDisconnect, encodeLength, encodePingreq, encodePuback, encodePublish,
  encodeSubscribe, encodeUnsubscribe, parsePacket,
} from '../lib/protocol/mqtt-codec.js';

const bytes = (...xs) => Uint8Array.from(xs.flatMap((x) => (typeof x === 'number' ? [x] : [...x])));
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

test('remaining length, the spec table (2.2.3)', () => {
  const cases = [[0, [0x00]], [127, [0x7f]], [128, [0x80, 0x01]], [16383, [0xff, 0x7f]],
    [16384, [0x80, 0x80, 0x01]], [2097151, [0xff, 0xff, 0x7f]], [2097152, [0x80, 0x80, 0x80, 0x01]],
    [268435455, [0xff, 0xff, 0xff, 0x7f]]];
  for (const [n, want] of cases) assert.deepEqual(encodeLength(n), bytes(want), String(n));
  assert.throws(() => encodeLength(268435456), /at most/);
});

test('CONNECT with user name, password and keepalive', () => {
  const got = encodeConnect({ clientId: 'c1', username: 'u', password: 'pw', keepalive: 30 });
  const body = [0, 4, ...ascii('MQTT'), 4, 0xc2, 0, 30, 0, 2, ...ascii('c1'), 0, 1, ...ascii('u'), 0, 2, ...ascii('pw')];
  assert.deepEqual(got, bytes(0x10, body.length, body));
  const anon = encodeConnect({ clientId: 'x', keepalive: 60 });
  assert.deepEqual(anon, bytes(0x10, 13, [0, 4, ...ascii('MQTT'), 4, 0x02, 0, 60, 0, 1, ...ascii('x')]));
  assert.throws(() => encodeConnect({ clientId: 'x', password: 'p' }), /user name/);
});

test('SUBSCRIBE and UNSUBSCRIBE carry flags 0010 and the packet id', () => {
  assert.deepEqual(encodeSubscribe(10, [{ topic: 'a/+', qos: 1 }, { topic: 'b', qos: 0 }]),
    bytes(0x82, 12, [0, 10, 0, 3, ...ascii('a/+'), 1, 0, 1, ...ascii('b'), 0]));
  assert.deepEqual(encodeUnsubscribe(0x1234, ['a/#']), bytes(0xa2, 7, [0x12, 0x34, 0, 3, ...ascii('a/#')]));
  assert.throws(() => encodeSubscribe(0, [{ topic: 'a', qos: 1 }]), /packet id/);
  assert.throws(() => encodeSubscribe(1, []), /at least one/);
});

test('PUBLISH at QoS 0 and 1, retain and dup', () => {
  assert.deepEqual(encodePublish({ topic: 't', payload: 'hi' }), bytes(0x30, 5, [0, 1, ...ascii('t'), ...ascii('hi')]));
  assert.deepEqual(encodePublish({ topic: 't', payload: Uint8Array.of(0, 255), qos: 1, id: 0x0102, retain: true }),
    bytes(0x33, 7, [0, 1, ...ascii('t'), 1, 2, 0, 255]));
  assert.deepEqual(encodePublish({ topic: 't', qos: 1, id: 1, dup: true })[0], 0x3a);
  assert.throws(() => encodePublish({ topic: 'a/+', payload: 'x' }), /wildcards/);
  assert.throws(() => encodePublish({ topic: 't', qos: 2, id: 1 }), /QoS 0 or 1/);
  // a payload past 127 bytes takes two length bytes
  const big = encodePublish({ topic: 't', payload: 'x'.repeat(200) });
  assert.deepEqual([...big.subarray(0, 3)], [0x30, 0xcb, 0x01]);
});

test('PUBACK, PINGREQ, DISCONNECT', () => {
  assert.deepEqual(encodePuback(7), bytes(0x40, 2, 0, 7));
  assert.deepEqual(encodePingreq(), bytes(0xc0, 0));
  assert.deepEqual(encodeDisconnect(), bytes(0xe0, 0));
});

test('broker packets parse', () => {
  assert.deepEqual(parsePacket(0x20, bytes(0, 0)), { type: 'connack', sessionPresent: false, returnCode: 0 });
  assert.deepEqual(parsePacket(0x20, bytes(1, 5)), { type: 'connack', sessionPresent: true, returnCode: 5 });
  assert.deepEqual(parsePacket(0x90, bytes(0, 3, 1, 0x80)), { type: 'suback', id: 3, granted: [1, 0x80] });
  assert.deepEqual(parsePacket(0xb0, bytes(0, 4)), { type: 'unsuback', id: 4 });
  assert.deepEqual(parsePacket(0x40, bytes(1, 0)), { type: 'puback', id: 256 });
  assert.deepEqual(parsePacket(0xd0, bytes()), { type: 'pingresp' });
  const pub = parsePacket(0x3b, bytes(0, 3, ...ascii('a/b'), 0, 9, ...ascii('xy')));
  assert.equal(pub.topic, 'a/b');
  assert.equal(pub.qos, 1);
  assert.equal(pub.id, 9);
  assert.equal(pub.retain, true);
  assert.equal(pub.dup, true);
  assert.deepEqual(pub.payload, bytes(ascii('xy')));
  assert.throws(() => parsePacket(0x30, bytes(0, 9, 1)), /runs past/);
  assert.throws(() => parsePacket(0x10, bytes()), /does not send/);
});

test('the reader joins split packets and splits joined ones', () => {
  const a = bytes(0x20, 2, 0, 0);
  const b = bytes(0x30, 5, 0, 1, ...ascii('t'), ...ascii('hi'));
  const c = bytes(0xd0, 0);
  const stream = bytes(a, b, c);
  // every way of cutting the stream in two, and byte by byte
  for (let cut = 0; cut <= stream.length; cut++) {
    const r = createReader();
    const got = [...r.push(stream.subarray(0, cut)), ...r.push(stream.subarray(cut))];
    assert.deepEqual(got.map((p) => p.type), ['connack', 'publish', 'pingresp'], `cut ${cut}`);
    assert.equal(r.buffered, 0);
  }
  const r = createReader();
  const got = [];
  for (const x of stream) got.push(...r.push(Uint8Array.of(x)));
  assert.equal(got.length, 3);
});

test('the reader refuses an oversized or malformed packet', () => {
  const r = createReader({ maxPacketSize: 10 });
  assert.throws(() => r.push(bytes(0x30, 20)), /over the limit of 10/);
  // the size is known from the header alone: nothing of the body is waited for
  assert.throws(() => createReader({ maxPacketSize: 100 }).push(bytes(0x30, 0xc8, 0x01)), /over the limit/);
  assert.throws(() => createReader().push(bytes(0x30, 0xff, 0xff, 0xff, 0xff, 0x01)), /malformed/);
});
