// lib/refresh (W-20e): Beacon on load and every 15 minutes, a signed `ver` once a day per node
// within its budget, never for a node not heard lately or a mesh-only one. Fake clock, fake
// Beacon, fake jobs: nothing reaches Beacon, a broker or a radio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRefresh, fleetFrom, META } from '../lib/refresh/index.js';
import { fakeBeacon, fakeClock, fakeJobs, HOUR, memStores, MIN } from './auto-fakes.js';

const GISEBO = '4AC61A7F';
const TORPA = '13B58595';

// A node Beacon knows, its status seen `ageMs` before `now`.
const known = (node, now, ageMs = 5 * MIN, firmware = 'v1.18.0.1-observer-a714b38') => {
  const at = () => (typeof now === 'function' ? now() : now) - ageMs;
  return {
  item: { id: `beacon-${node}`, publicKey: `${node.toLowerCase()}${'0'.repeat(56)}`, observerId: `obs-${node}`,
    knownNeighborCount: 2, neighborIds: ['n1', 'n2'], lat: 57.7, lng: 14.1, iatas: [{ iata: 'JKG', lastHeard: 1 }] },
  observer: { firmwareVersion: firmware, get lastStatusAt() { return at(); },
    statusMetadata: { stats: { battery_mv: 4174, tx_air_secs: 13706, rx_air_secs: 28259, noise_floor: -86, uptime_secs: 2487901 } } },
  };
};

const setup = async ({ beaconNodes = null, unlocked = true, devices = [GISEBO, TORPA], ...opts } = {}) => {
  const clock = fakeClock();
  const stores = memStores(clock);
  for (const n of devices) await stores.devices.add({ node: n, region: 'JKG', name: { [GISEBO]: 'Gisebo', [TORPA]: 'Torpa' }[n] || '' });
  const beacon = fakeBeacon(beaconNodes ?? { [GISEBO]: known(GISEBO, clock.now), [TORPA]: known(TORPA, clock.now) });
  const jobs = fakeJobs(stores);
  const lock = { open: unlocked };
  const r = createRefresh({ stores, beacon, jobs, clock, unlocked: () => lock.open, ...opts });
  return { clock, stores, beacon, jobs, r, lock };
};

const vers = (jobs) => jobs.calls.filter((c) => c[0] === 'send').map((c) => c[2]);

test('fleetFrom: battery, airtime, noise, neighbours, position and IATA codes, with the age', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const f = fleetFrom(known(GISEBO, now).item, known(GISEBO, now).observer, now);
  assert.equal(f.batteryMv, 4174);
  assert.equal(f.seen, new Date(now - 5 * MIN).toISOString());
  assert.equal(f.fetched, new Date(now).toISOString());
  assert.deepEqual([f.airTxSecs, f.airRxSecs, f.noiseFloor, f.uptimeSecs], [13706, 28259, -86, 2487901]);
  assert.deepEqual([f.neighbours, f.neighbourIds, f.beaconId, f.lat, f.lng, f.iatas], [2, ['n1', 'n2'], 'beacon-4AC61A7F', 57.7, 14.1, ['JKG']]);
  const bare = fleetFrom({ id: 'x', neighbors: '[]', iatas: '[{"iata": "GOT"}]' }, null, now);
  assert.deepEqual([bare.batteryMv, bare.seen, bare.neighbours, bare.iatas], [null, null, null, ['GOT']]);
});

test('on start Beacon runs at once, then every 15 minutes; the last pass survives a reload', async () => {
  const { r, clock, beacon, stores, jobs } = await setup();
  await r.start();
  await clock.advance(0);
  const finds = () => beacon.calls.filter((c) => c[0] === 'find').length;
  assert.equal(finds(), 2);
  assert.equal(r.state().beacon.updated, 2);
  assert.equal((await stores.devices.get(GISEBO)).fleet.batteryMv, 4174);
  assert.equal(r.state().beacon.nextRun, clock.now() + 15 * MIN);
  await clock.advance(14 * MIN);
  assert.equal(finds(), 2);
  await clock.advance(1 * MIN);
  assert.equal(finds(), 4);
  r.stop();
  const again = createRefresh({ stores, beacon, jobs, clock });
  await again.start();
  await clock.advance(1 * MIN);
  assert.equal(finds(), 4);
  assert.equal(again.state().beacon.nextRun, clock.now() + 14 * MIN);
});

test('an unknown node loses its stale fleet; an unreachable Beacon keeps the old values', async () => {
  const { r, stores, clock } = await setup();
  await r.runBeacon();
  const before = (await stores.devices.get(TORPA)).fleet;
  const down = createRefresh({ stores, beacon: fakeBeacon({}, { down: true }), jobs: fakeJobs(stores), clock });
  await down.runBeacon();
  assert.deepEqual((await stores.devices.get(TORPA)).fleet, before);
  assert.equal(down.state().beacon.failed, 2);
  assert.match(down.state().beacon.error, /unreachable/);
  const gone = createRefresh({ stores, beacon: fakeBeacon({ [GISEBO]: known(GISEBO, clock.now()) }), jobs: fakeJobs(stores), clock });
  await gone.runBeacon();
  assert.equal((await stores.devices.get(TORPA)).fleet, null);
  assert.equal(gone.state().beacon.unknown, 1);
});

test('one signed ver per node per day, to nodes heard lately; not again until the day is over', async () => {
  const { r, clock, jobs } = await setup();
  await r.runNow();
  assert.deepEqual(vers(jobs).sort(), [TORPA, GISEBO].sort());
  assert.equal(r.state().ver.sent.length, 2);
  assert.ok(r.state().ver.sent.every((s) => s.ok));
  assert.equal(r.state().ver.nextRun, clock.now() + 24 * HOUR);
  await clock.advance(23 * HOUR);
  await r.runNow();
  assert.equal(vers(jobs).length, 2);
  await clock.advance(HOUR);
  await r.runNow({ force: true });
  assert.equal(vers(jobs).length, 4);
});

test('a silent node is tried once a day too, not every 15 minutes', async () => {
  const { r, clock, jobs, stores } = await setup({ devices: [GISEBO] });
  jobs.send = async ({ nodes }) => { jobs.calls.push(['send', 'ver', ...nodes]); return { outcomes: [{ node: nodes[0], sent: true, result: null }] }; };
  await r.start();
  await clock.advance(0);
  assert.equal(vers(jobs).length, 1);
  assert.deepEqual(r.state().ver.sent, [{ node: GISEBO, name: 'Gisebo', ok: false, code: null }]);
  await clock.advance(2 * HOUR);
  assert.equal(vers(jobs).length, 1);
  assert.equal(typeof (await stores.meta.get(META.verTried))[GISEBO], 'number');
});

test('never for a node not heard lately, a mesh-only node, or a node near its hourly budget', async () => {
  const { r, clock, jobs, stores } = await setup({
    beaconNodes: { [GISEBO]: known(GISEBO, Date.parse('2026-11-17T12:00:00Z'), 3 * HOUR) },
    devices: [GISEBO, TORPA, 'F00DF00D'],
  });
  await stores.devices.update('F00DF00D', { meshOnly: true, lastHeardMqtt: new Date(clock.now()).toISOString() });
  await stores.devices.update(TORPA, { lastHeardMqtt: new Date(clock.now() - 10 * MIN).toISOString() });
  for (let i = 0; i < 5; i += 1) await stores.history.append({ node: TORPA, region: 'JKG', command: 'get txdelay', topic: 't', code: 0 });
  await r.runNow();
  assert.deepEqual(vers(jobs), []);
  const reasons = Object.fromEntries(r.state().ver.skipped.map((s) => [s.node, s.reason]));
  assert.deepEqual(reasons, { [GISEBO]: 'notHeard', [TORPA]: 'budget' });
  await clock.advance(HOUR);
  await r.runNow();
  assert.deepEqual(vers(jobs), [TORPA]);
});

test('nothing is signed while the key is locked; Beacon still runs', async () => {
  const { r, jobs, beacon, lock } = await setup({ unlocked: false });
  await r.runNow();
  assert.deepEqual(vers(jobs), []);
  assert.ok(beacon.calls.length > 0);
  assert.deepEqual(r.state().ver.skipped.map((s) => s.reason), ['locked', 'locked']);
  lock.open = true;
  await r.runVer();
  assert.equal(vers(jobs).length, 2);
});

test('a new firmware on Beacon makes ver due at once', async () => {
  const { r, clock, jobs, stores } = await setup({ devices: [GISEBO] });
  await r.runNow();
  assert.equal(vers(jobs).length, 1);
  await clock.advance(20 * MIN);
  const updated = createRefresh({ stores, beacon: fakeBeacon({ [GISEBO]: known(GISEBO, clock.now(), MIN, 'v1.19.0-observer-b') }), jobs, clock });
  await updated.runNow();
  assert.equal(vers(jobs).length, 2);
  assert.deepEqual(await stores.meta.get(META.verDue), []);
});

test('the manual ver counts: a node asked by hand is not asked again that day', async () => {
  const { r, jobs, stores, clock } = await setup({ devices: [GISEBO] });
  await stores.devices.rememberRead(GISEBO, 'ver', '> v1', true);
  await clock.advance(MIN);
  await r.runNow();
  assert.deepEqual(vers(jobs), []);
});
