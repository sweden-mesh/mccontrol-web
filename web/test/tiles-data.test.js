// The board tiles' arithmetic (ui/tiles/data.js) and their shared store (ui/tiles/sources.js):
// the NODES state and sort, RESULTS kept until seen, the sparkline and hourly series, the MAP's
// frame, projection, outlines and model. Fakes only; no DOM, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  byAttention, fit, frame, historyFor, OWN_MIN_KM, hourly, mapFrame, newCounts, isSeen, mapModel, markAllSeen, markSeen, matches, nodeStatus,
  outlinePaths, project, sharedPrefix, sparkRuns, waterPaths,
} from '../ui/tiles/data.js';
import {
  brokerReport, dataChanged, jobs, onDataChanged, onJobs, onSources, provideSource, reportBroker, source, startJob,
} from '../ui/tiles/sources.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const iso = (mins) => new Date(NOW - mins * 60000).toISOString();
// The few rules nodeStatus reaches through needsAttention.
const rules = { revision: () => null, admits: () => true };
const opts = { now: NOW, hours: 24, thresholdMv: 3500, rules };

test('a node is ok, needs attention, refused or not known', () => {
  assert.equal(nodeStatus({ node: 'A', lastHeard: iso(5) }, opts).state, 'ok');
  assert.equal(nodeStatus({ node: 'A' }, opts).state, 'unknown');
  const quiet = nodeStatus({ node: 'A', lastHeard: iso(60 * 30) }, opts);
  assert.equal(quiet.state, 'warn');
  assert.equal(quiet.reasons[0].kind, 'notHeard');
  assert.equal(nodeStatus({ node: 'A', lastHeard: iso(5), fleet: { batteryMv: 3300, seen: iso(5) } }, opts).state, 'warn');
  const refused = nodeStatus({ node: 'A', lastHeard: iso(60 * 30), lastResult: { at: iso(60), command: 'set x 1', code: 3, verified: true } }, opts);
  assert.equal(refused.state, 'alert');
  assert.deepEqual(refused.reasons.map((r) => r.kind).sort(), ['notHeard', 'refused']);
  assert.equal(nodeStatus({ node: 'A', lastResult: { at: iso(1), command: 'ver', code: 0, verified: false } }, opts).state, 'alert');
  // an answer alone is evidence the node is there
  assert.equal(nodeStatus({ node: 'A', lastResult: { at: iso(1), command: 'ver', code: 0, verified: true } }, opts).state, 'ok');
});

test('the list puts what needs attention first, then by name', () => {
  const row = (name, state) => ({ device: { node: name.toUpperCase(), name }, status: { state } });
  const sorted = byAttention([row('Ö', 'ok'), row('b', 'unknown'), row('a', 'ok'), row('c', 'alert'), row('d', 'warn')], 'sv');
  assert.deepEqual(sorted.map((r) => r.device.name), ['c', 'd', 'b', 'a', 'Ö']);
});

test('search matches name, id, region and firmware, ignoring case', () => {
  const d = { node: '4AC61A7F', name: 'Gisebo', region: 'JKG', ver: 'v1.11.0-lou-18' };
  for (const q of ['gis', '4ac6', 'jkg', 'LOU-18', '', '  ']) assert.ok(matches(d, q), q);
  assert.ok(!matches(d, 'torpa'));
});

test('a result is kept until it is opened or all are marked seen', () => {
  const events = [{ id: 'a', at: iso(30) }, { id: 'b', at: iso(20) }, { id: 'c', at: iso(10) }];
  assert.deepEqual(events.filter((e) => !isSeen(e, null)).map((e) => e.id), ['a', 'b', 'c']);
  const one = markSeen(null, ['b']);
  assert.deepEqual(events.filter((e) => !isSeen(e, one)).map((e) => e.id), ['a', 'c']);
  const all = markAllSeen(events.slice(0, 2));
  assert.equal(all.upTo, iso(20));
  assert.deepEqual(events.filter((e) => !isSeen(e, all)).map((e) => e.id), ['c']);
  // a later result is new again; ids opened keep their place, capped
  const many = markSeen({ upTo: null, ids: [] }, Array.from({ length: 250 }, (_, i) => `x${i}`));
  assert.equal(many.ids.length, 200);
  assert.equal(many.ids.at(-1), 'x249');
});

test('sparklines break over gaps and keep a flat series in the middle', () => {
  assert.deepEqual(sparkRuns([1], 10, 10), []);
  assert.deepEqual(sparkRuns([null, 2, null], 10, 10), []);
  const [flat] = sparkRuns([5, 5, 5], 20, 10, 0);
  assert.equal(flat, '0.0,5.0 10.0,5.0 20.0,5.0');
  const runs = sparkRuns([1, 2, null, 3, 4], 40, 10, 0);
  assert.equal(runs.length, 2);
  assert.equal(runs[0], '0.0,10.0 10.0,6.7');
  assert.equal(runs[1], '30.0,3.3 40.0,0.0');
});

test('hourly values and hourly increases of the last 24 hours', () => {
  const H = 3600000;
  const end = Math.floor(NOW / H) * H + H;
  const p = (h, v) => ({ t: end - (24 - h) * H, batteryMv: v, airtimeTxSecs: v });
  const pts = [p(0, 10), p(1, 15), p(2, 12), p(4, 20), p(23, 30), { t: end - 30 * H, batteryMv: 1 }];
  const level = hourly(pts, 'batteryMv', NOW);
  assert.equal(level.length, 24);
  assert.deepEqual(level.slice(0, 5), [10, 15, 12, null, 20]);
  assert.equal(level[23], 30);
  const diff = hourly(pts, 'airtimeTxSecs', NOW, { diff: true });
  // 0->1 +5; 1->2 is a drop (a reboot): unknown; 2->4 is a gap over 1.5 h: unknown
  assert.deepEqual(diff.slice(0, 3), [5, null, null]);
});

test('the map frame, its fit to the box, the projection and the outlines', () => {
  assert.equal(frame([]), null);
  assert.equal(frame([{ lat: 0, lng: 0 }]), null);
  const one = frame([{ lat: 57.7, lng: 14.1 }], { pad: 0, minKm: 30 });
  assert.ok(Math.abs((one.n - one.s) * 111 - 30) < 0.01);
  assert.ok(Math.abs((one.e - one.w) * 111 * one.k - 30) < 0.01);
  const f = frame([{ lat: 57.6, lng: 14.0 }, { lat: 57.8, lng: 14.4 }]);
  const wide = fit(f, 2);
  assert.ok(Math.abs(((wide.e - wide.w) * wide.k) / (wide.n - wide.s) - 2) < 1e-9);
  const tall = fit(f, 0.5);
  assert.ok(Math.abs(((tall.e - tall.w) * tall.k) / (tall.n - tall.s) - 0.5) < 1e-9);
  const proj = project(wide, 400);
  assert.equal(proj.height, 200);
  assert.ok(Math.abs(proj.x(wide.w)) < 1e-9 && Math.abs(proj.x(wide.e) - 400) < 1e-9);
  assert.ok(Math.abs(proj.y(wide.n)) < 1e-9 && Math.abs(proj.y(wide.s) - 200) < 1e-9);
  // the shipped outlines: Jönköping's county touches a frame around Jönköping, Norrbotten does not
  const geo = JSON.parse(readFileSync(new URL('../ui/tiles/se-lan.json', import.meta.url), 'utf8'));
  assert.equal(geo.features.length, 21);
  const ids = outlinePaths(geo, wide, proj).map((o) => o.id);
  assert.ok(ids.includes('06'), ids.join());
  assert.ok(!ids.includes('25'), ids.join());
  for (const o of outlinePaths(geo, wide, proj)) assert.match(o.d, /^M[\d.-]+,[\d.-]+(L[\d.-]+,[\d.-]+)+Z/);
});

// W-25c: the frame is the owner's nodes; the region's (others) only when none of them is placed.
test('the map frames the owner\'s nodes, the region only when none is placed', () => {
  const mineA = { lat: 57.70, lng: 14.10 };
  const mineB = { lat: 57.75, lng: 14.20 };
  const far = { lat: 58.6, lng: 16.2 };
  const f = mapFrame({ mine: [{ node: mineA }, { node: mineB }, { node: null }], others: [far] });
  assert.deepEqual(f, frame([mineA, mineB], { pad: 0.25, minKm: OWN_MIN_KM }));
  assert.ok(f.n < far.lat && f.e < far.lng, 'a far neighbour stays outside the frame');
  // W-26a: four nodes within 300 m (the operator's, in JKG) fill the map, not a 30 km square.
  const close = [[57.809705, 14.275188], [57.807383, 14.275305], [57.808244, 14.275993], [57.8081, 14.2741]].map(([lat, lng]) => ({ node: { lat, lng } }));
  const g = mapFrame({ mine: close, others: [far, mineA] });
  assert.ok((g.n - g.s) * 111 < 5 && (g.e - g.w) * 111 * g.k < 5, `framed ${((g.n - g.s) * 111).toFixed(1)} km tall`);
  for (const { node } of close) assert.ok(node.lat > g.s && node.lat < g.n && node.lng > g.w && node.lng < g.e);
  assert.deepEqual(mapFrame({ mine: [{ node: null }], others: [far, mineA] }), frame([far, mineA]));
  assert.equal(mapFrame({ mine: [], others: [] }), null);
});

// W-25d: HISTORY shows the selected node's results (every node's with none); NODES counts the new.
test('HISTORY for one node or all, and the new results per node', () => {
  const ev = [
    { id: '1', at: '2026-11-17T10:00:00Z', node: 'AA', command: 'ver' },
    { id: '2', at: '2026-11-17T11:00:00Z', node: 'BB', command: 'ver' },
    { id: '3', at: '2026-11-17T12:00:00Z', node: 'AA', command: 'get name' },
    { id: '4', at: '2026-11-17T12:30:00Z', region: 'JKG', command: 'ver' },
  ];
  assert.deepEqual(historyFor(ev, 'AA').map((e) => e.id), ['1', '3']);
  assert.deepEqual(historyFor(ev, null).map((e) => e.id), ['1', '2', '3', '4']);
  assert.deepEqual(newCounts(ev, null), { AA: 2, BB: 1 });
  // one node marked seen leaves the other's new
  const seen = markSeen(null, historyFor(ev, 'AA').map((e) => e.id));
  assert.deepEqual(newCounts(ev, seen), { BB: 1 });
  assert.deepEqual(newCounts(ev, markAllSeen(ev)), {});
});

test('the lakes and the coast: small, Sweden only, Vättern near Jönköping (W-23c, W-30)', () => {
  const url = new URL('../ui/tiles/se-water.json', import.meta.url);
  assert.ok(readFileSync(url).length < 150 * 1024, 'se-water.json stays under 150 KB (W-30)');
  const geo = JSON.parse(readFileSync(url, 'utf8'));
  assert.deepEqual(geo.features.map((f) => f.properties.kind), ['lake', 'coast']);
  const near = fit(frame([{ lat: 57.78, lng: 14.16 }, { lat: 58.0, lng: 14.5 }]), 1.4);
  const proj = project(near, 400);
  const w = waterPaths(geo, near, proj);
  assert.match(w.lakes, /^M[\d.-]+,[\d.-]+(L[\d.-]+,[\d.-]+)+Z/);    // Vättern
  assert.equal(w.coast, '');                                           // Jönköping is inland
  const north = fit(frame([{ lat: 65.6, lng: 22.1 }, { lat: 65.9, lng: 22.4 }]), 1.4);   // Luleå
  assert.match(waterPaths(geo, north, project(north, 400)).coast, /^M[\d.-]+,[\d.-]+L/);
  assert.deepEqual(waterPaths(null, near, proj), { lakes: '', coast: '' });
});

test('the map model: my nodes by key prefix, neighbour links once, companions left out', () => {
  const rows = [
    { id: 'a', publicKey: '4ac61a7f00', lat: 57.7, lng: 14.1, neighborIds: ['b', 'c', 'z'] },
    { id: 'b', publicKey: 'fd70036900', lat: 57.8, lng: 14.2, neighborIds: ['a'] },
    { id: 'c', publicKey: 'aa00000000', lat: 57.6, lng: 14.0, neighborIds: [] },
    { id: 'd', publicKey: 'bb00000000', lat: 0, lng: 0 },
    { id: 'e', publicKey: 'cc00000000', lat: 57.65, lng: 14.05, nodeTypeName: 'companion' },
  ];
  const m = mapModel([{ node: '4AC61A7F' }, { node: 'FD700369' }, { node: '65C1D12C' }], rows);
  assert.deepEqual(m.mine.map((x) => x.node?.id ?? null), ['a', 'b', null]);
  assert.equal(m.mine[0].neighbours, 3);
  assert.deepEqual(m.others.map((o) => o.id), ['c']);
  assert.deepEqual(m.links.map(([x, y]) => `${x.id}-${y.id}`), ['a-b', 'a-c']);
});

test('status lines are provided, replaced and withdrawn; the broker report is kept', () => {
  let told = 0;
  const off = onSources(() => { told += 1; });
  assert.equal(source('refresh'), null);
  assert.throws(() => provideSource('clock', { state: () => ({}) }), /no status line/);
  assert.throws(() => provideSource('refresh', {}), /state/);
  const src = { state: () => ({ state: 'ok', last: 1, next: 2 }) };
  const withdraw = provideSource('refresh', src);
  assert.equal(source('refresh'), src);
  withdraw();
  assert.equal(source('refresh'), null);
  reportBroker({ ok: false, detail: 'refused' }, 5);
  assert.deepEqual({ ...brokerReport() }, { ok: false, detail: 'refused', at: 5 });
  assert.equal(told, 3);
  off();
});

test('jobs run, report progress and end; data changes reach the listeners', () => {
  const seen = [];
  const offJobs = onJobs(() => seen.push(jobs().map((j) => `${j.label}:${j.fraction}`).join()));
  const job = startJob({ label: 'ver' });
  job.progress(0.5, 'half');
  job.progress(7);
  job.done();
  job.done();
  assert.deepEqual(seen, ['ver:null', 'ver:0.5', 'ver:1', '']);
  offJobs();
  const what = [];
  const off = onDataChanged((w) => what.push(w));
  dataChanged('history');
  dataChanged();
  off();
  dataChanged('devices');
  assert.deepEqual(what, ['history', 'any']);
});

test('the automation as STATUS lines: refresh and discovery', async () => {
  const { refreshLine, discoveryLine } = await import('../ui/tiles/automation-sources.js');
  assert.equal(refreshLine(null).state, 'unknown');
  const beacon = { lastRun: 10, nextRun: 20, error: null };
  assert.deepEqual(refreshLine({ owner: 'K', refresh: { running: null, beacon } }), { state: 'ok', last: 10, next: 20, detail: null });
  assert.equal(refreshLine({ owner: 'K', refresh: { running: 'beacon', beacon } }).state, 'running');
  assert.equal(refreshLine({ owner: 'K', refresh: { running: null, beacon: { ...beacon, error: 'down' } } }).detail, 'down');
  const d = { running: false, needsArea: false, lastRun: null, nextRun: null, canUndo: false };
  assert.equal(discoveryLine({ owner: 'K', discovery: d }).state, 'unknown');
  assert.equal(discoveryLine({ owner: 'K', discovery: { ...d, needsArea: true } }).state, 'warn');
  assert.equal(discoveryLine({ owner: 'K', discovery: { ...d, lastRun: 5, canUndo: true } }).canUndo, true);
  assert.equal(discoveryLine({ owner: 'K', discovery: { ...d, running: true } }).state, 'running');
  const bad = discoveryLine({ owner: 'K', discovery: { ...d, lastRun: 5, last: { failed: [{ region: 'JKG', detail: 'no broker' }] } } });
  assert.equal(bad.state, 'alert');
  assert.equal(bad.detail, 'JKG: no broker');
});

test('registration as a STATUS line', async () => {
  const { registrationLine } = await import('../ui/tiles/automation-sources.js');
  assert.equal(registrationLine(null).state, 'unknown');
  assert.equal(registrationLine({ state: 'ok', hosts: [{ host: 'a', state: 'ok', at: 7 }, { host: 'b', state: 'ok', at: 9 }] }).last, 9);
  const part = registrationLine({ state: 'partial', hosts: [{ host: 'a', state: 'ok', at: 7 }, { host: 'b', state: 'failed', detail: 'no ack' }] });
  assert.equal(part.state, 'warn');
  assert.equal(part.detail, 'b: no ack');
  assert.equal(registrationLine({ state: 'failed', hosts: [] }).state, 'alert');
});

test('RESULTS: the shared start of the names, cut at a separator, so a narrow column tells them apart', () => {
  assert.equal(sharedPrefix(['SE-JKG-Ekbacken', 'SE-JKG-Torpa', 'SE-JKG-Kvarnberget']), 'SE-JKG-');
  assert.equal(sharedPrefix(['SE-JKG-Habo-D21C', 'SE-JKG-Habo-E630']), 'SE-JKG-Habo-');
  assert.equal(sharedPrefix(['SE-JKG-Habo', 'SE-JKP-Lekeryd']), 'SE-');
  assert.equal(sharedPrefix(['Kvarnen', 'Kvarnberget']), '');        // no separator: nothing cut
  assert.equal(sharedPrefix(['SE-JKG-A', 'SE-JKG-']), '');            // a name would be left empty
  assert.equal(sharedPrefix(['SE-JKG-Ekbacken']), '');
  assert.equal(sharedPrefix([]), '');
});

test('the map asks Beacon for every IATA the nodes are in, not the chosen area (W-33g)', async () => {
  const { nodeRegions } = await import('../ui/tiles/data.js');
  assert.deepEqual(nodeRegions([{ region: 'JKG', fleet: { iatas: ['jkg', 'GOT'] } }, { region: 'ARN' }, { region: null }]), ['ARN', 'GOT', 'JKG']);
  assert.deepEqual(nodeRegions([]), []);
});
