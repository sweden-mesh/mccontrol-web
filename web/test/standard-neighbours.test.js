// W-29f: the Neighbours dialog's data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceKm, neighbourRows, parseNeighbors } from '../ui/standard/neighbours-data.js';

test('the reply: hex, seconds since, SNR x 4', () => {
  assert.deepEqual(parseNeighbors('> AABBCCDD:30:-22\n11223344:600:10'),
    [{ prefix: 'AABBCCDD', secsAgo: 30, snr: -5.5 }, { prefix: '11223344', secsAgo: 600, snr: 2.5 }]);
  assert.deepEqual(parseNeighbors('-none-'), []);
});

test('distance', () => {
  assert.equal(distanceKm({ lat: 57, lng: 14 }, null), null);
  assert.ok(Math.abs(distanceKm({ lat: 57.78, lng: 14.16 }, { lat: 57.78, lng: 14.33 }) - 10.1) < 0.2);
});

test('joined: last and average SNR, direct, Beacon, own node', () => {
  const now = Date.parse('2026-11-18T10:00:00Z');
  const events = [
    { command: 'neighbors', code: 0, at: '2026-11-18T09:00:00Z', reply: 'AABBCCDD:60:-20' },
    { command: 'neighbors', code: 0, at: '2026-11-17T09:00:00Z', reply: 'AABBCCDD:60:-12\n99887766:5:4' },
    { command: 'ver', code: 0, at: '2026-11-18T09:00:00Z', reply: 'v1' },
  ];
  const beaconRows = [{ publicKey: 'aabbccdd' + '00'.repeat(28), name: 'SE-JKG-A', lat: 57.8, lng: 14.2, lastSeen: now - 1000 },
    { publicKey: '55555555' + '00'.repeat(28), name: 'SE-JKG-B', lat: 57.7, lng: 14.2, lastSeen: now - 5000 }];
  const rows = neighbourRows({ events, beaconRows, devices: [{ node: '55555555', name: 'Mine' }], self: { lat: 57.78, lng: 14.16 }, now });
  const a = rows.find((r) => r.prefix === 'AABBCCDD');
  assert.equal(a.snrLast, -5);
  assert.equal(a.snrAvg, -4);
  assert.equal(a.direct, true);
  assert.equal(a.name, 'SE-JKG-A');
  assert.ok(a.km > 1 && a.km < 4);
  const b = rows.find((r) => r.prefix === '55555555');
  assert.equal(b.direct, false);
  assert.equal(b.own.name, 'Mine');
  const old = rows.find((r) => r.prefix === '99887766');
  assert.equal(old.direct, false, 'only the newest reply says who is heard now');
  assert.equal(old.snrLast, null);
  assert.equal(old.snrAvg, 1);
});
