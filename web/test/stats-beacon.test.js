// lib/stats/beacon.js against a capture of beacon.meshcore-jkp.se (test/smoke/beacon-fixture.json):
// hourly running totals become airtime per bar, gaps and reboots become "not known", and every
// failure is a StatsError with a code the chart turns into its one-line note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HOUR, airtimeBars, beaconClient, nodeStats, niceScale, summarize, ageParts, StatsError }
  from '../lib/stats/beacon.js';

const FIX = JSON.parse(readFileSync(new URL('./smoke/beacon-fixture.json', import.meta.url), 'utf8'));
const NODE = FIX.paths[Object.keys(FIX.paths).find((p) => p.startsWith('/nodes?'))].items[0];

function fakeFetch(paths = FIX.paths, log = []) {
  return async (url) => {
    const path = url.replace('https://beacon.test/api/v1', '');
    log.push(path);
    if (!(path in paths)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => structuredClone(paths[path]) };
  };
}
const client = (paths, log) => beaconClient({ base: 'https://beacon.test/api/v1', fetch: fakeFetch(paths, log) });

test('running totals become airtime per hour; a gap or a reboot is not known', () => {
  const p = (h, tx, rx, up) => ({ t: h * HOUR, airtimeTxSecs: tx, airtimeRxSecs: rx, uptimeSeconds: up, batteryMv: 4100 });
  const points = [p(0, 100, 200, 1000), p(1, 110, 230, 4600), p(2, 130, 260, 8200),
    /* hour 3 missing */ p(4, 150, 300, 15400), p(5, 5, 10, 300), p(6, 9, 20, 3900)];
  const bars = airtimeBars(points, { bucket: HOUR, start: 0, end: 7 * HOUR });
  assert.deepEqual(bars.map((b) => b.tx), [10, 20, null, null, null, 4, null]);
  assert.deepEqual(bars.map((b) => b.rx), [30, 30, null, null, null, 10, null]);
  const six = airtimeBars(points, { bucket: 6 * HOUR, start: 0, end: 12 * HOUR });
  // In a 6-hour bar a 2-hour gap still lies inside the bar, so it counts; the reboot does not.
  assert.deepEqual(six.map((b) => b.tx), [54, null]);
  // A counter that falls without an uptime to show the reboot is still not a negative airtime.
  const noUptime = [{ t: 0, airtimeTxSecs: 50, airtimeRxSecs: 50 }, { t: HOUR, airtimeTxSecs: 3, airtimeRxSecs: 80 }];
  assert.deepEqual(airtimeBars(noUptime, { bucket: HOUR, start: 0, end: HOUR }).map((b) => b.tx), [null]);
  const sum = summarize(bars);
  assert.equal(sum.known, 3);
  assert.equal(sum.tx, 34);
  assert.equal(sum.peak.t, HOUR);
  assert.deepEqual(summarize([{ t: 0, tx: null, rx: null }]), { known: 0, tx: 0, rx: 0, peak: null });
});

test('the captured node: 24 hourly bars and 28 six-hour bars, airtime summed', async () => {
  const now = FIX.capturedAt;
  const day = await nodeStats(client(), NODE.publicKey.slice(0, 8).toUpperCase(), '24h', now);
  assert.equal(day.bars.length, 24);
  assert.equal(day.name, NODE.name);
  assert.ok(day.summary.known >= 20, `known ${day.summary.known}`);
  assert.ok(day.summary.tx > 0 && day.summary.rx > day.summary.tx);
  assert.equal(typeof day.stats.battery_mv, 'number');
  assert.ok(day.ageSecs >= 0 && day.ageSecs < 3600);
  const week = await nodeStats(client(), NODE.publicKey.slice(0, 8), '7d', now);
  assert.equal(week.bars.length, 28);
  assert.equal(week.bars[1].t - week.bars[0].t, 6 * HOUR);
  // The 7-day total is at least the 24-hour one: the same differences, more of them.
  assert.ok(week.summary.tx >= day.summary.tx);
});

test('a node Beacon does not know, one with no status, and a Beacon that is down', async () => {
  await assert.rejects(nodeStats(client(), 'DEADBEEF'), (e) => e instanceof StatsError && e.code === 'unreachable');
  const empty = { ...FIX.paths, '/nodes?pubkeyPrefix=deadbeef&limit=2': { items: [] } };
  await assert.rejects(nodeStats(client(empty), 'DEADBEEF'), (e) => e.code === 'unknown');
  const silent = { '/nodes?pubkeyPrefix=deadbeef&limit=2': { items: [{ publicKey: 'deadbeef00', name: 'x' }] } };
  await assert.rejects(nodeStats(client(silent), 'DEADBEEF'), (e) => e.code === 'noStatus');
  const down = beaconClient({ base: 'https://beacon.test', fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(nodeStats(down, 'DEADBEEF'), (e) => e.code === 'unreachable');
  await assert.rejects(nodeStats(client(), 'not-hex'), (e) => e.code === 'unknown');
});

test('one request per thing, and only the 1h interval', async () => {
  const log = [];
  await nodeStats(client(FIX.paths, log), NODE.publicKey.slice(0, 8), '7d', FIX.capturedAt);
  assert.equal(log.length, 3);
  assert.ok(log.every((p) => !p.includes('interval=') || p.endsWith('interval=1h')));
});

test('axis steps and sample ages', () => {
  assert.deepEqual(niceScale(0), { top: 1, step: 1 });
  assert.deepEqual(niceScale(37), { top: 40, step: 10 });
  assert.deepEqual(niceScale(7), { top: 8, step: 2 });
  assert.deepEqual(niceScale(180), { top: 200, step: 50 });
  assert.deepEqual(ageParts(30), ['stats.age.s', 30]);
  assert.deepEqual(ageParts(600), ['stats.age.min', 10]);
  assert.deepEqual(ageParts(7200), ['stats.age.h', 2]);
  assert.deepEqual(ageParts(259200), ['stats.age.d', 3]);
});
