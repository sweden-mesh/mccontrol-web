// lib/jobs: send, groups (RM-4), region broadcasts, sets, discover/adopt, refresh and the
// firmware update, against a fake keyring and a fake transport. Plus the checks, releases,
// Beacon fleet reads, the dashboard's sums, and the history CSV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from '../lib/store/db.js';
import { openStores } from '../lib/store/index.js';
import { rulesFrom } from '../lib/protocol/rules.js';
import { createJobs, JobError } from '../lib/jobs/jobs.js';
import { blocker, fillSteps, preflight } from '../lib/jobs/checks.js';
import { latestRelease, newestRelease, updateAvailable } from '../lib/jobs/releases.js';
import { refreshFleet } from '../lib/jobs/fleet.js';
import { beaconClient } from '../lib/stats/beacon-client.js';

const BASE = 'https://beacon.example/api/v1';
import { fleetCounts, needsAttention, recentSince, shortVersion } from '../lib/jobs/overview.js';
import { csvCell, toCsv } from '../ui/screens/history.js';
import { data } from './protocol-helpers.js';
import { fakeRing, fakeTransport, FIXTURE_NODES, fixtureBehaviour, seedFixture } from './jobs-fakes.js';

const all = Object.fromEntries(['brokers', 'cautions', 'commands', 'denylist', 'facts', 'firmware', 'results'].map((n) => [n, data(n)]));
const rules = rulesFrom(all);
const OWNER = 'C'.repeat(64);
const LOU18 = 'v1.18.0-lou-18-arrc-observer-1a2b3c4d';
const LOU19 = 'v1.18.0-lou-19-arrc-observer-1a2b3c4d';
const AR10 = 'v1.17.1-ar-10-observer-42f48ce9';
const A = `AAAA0001${'1'.repeat(56)}`;
const B = `BBBB0002${'2'.repeat(56)}`;
const C = `CCCC0003${'3'.repeat(56)}`;

async function setup({ behaviour = null, ring = fakeRing(), jobsRules = rules } = {}) {
  const stores = openStores(memoryDb(), OWNER, { defaultSets: all.brokers.default_sets });
  await stores.devices.add({ node: A, key: A, region: 'JKG', name: 'alpha' });
  await stores.devices.add({ node: B, key: B, region: 'JKG', name: 'bravo' });
  await stores.devices.add({ node: C.slice(0, 8), region: 'GOT', name: 'charlie' });
  await stores.devices.update('AAAA0001', { ver: LOU18 });
  await stores.devices.update('BBBB0002', { ver: AR10 });
  const transport = fakeTransport(behaviour || {
    AAAA0001: { ver: LOU18, name: 'alpha' }, BBBB0002: { ver: AR10 }, CCCC0003: { ver: LOU18, name: 'charlie' },
  });
  const jobs = createJobs({ ring, stores, rules: jobsRules, brokers: all.brokers, results: all.results, transport,
    sleep: async () => {} });
  return { stores, transport, jobs, ring };
}

test('checks: deny list, broadcast rules, ASCII before lou-17, and what the firmware admits', () => {
  assert.equal(blocker(rules, { command: 'set prv.key 00' , device: { region: 'JKG' } }).code, 'denied');
  assert.equal(blocker(rules, { command: '  ', device: null }).code, 'empty');
  // an area act is one command per node: a transmit and the mesh road are refused, nothing else
  assert.equal(blocker(rules, { command: 'trigger test', area: 'se-jkp' }).code, 'broadcastTransmit');
  assert.equal(blocker(rules, { command: 'ver', area: 'se-jkp', road: 'mesh' }).code, 'meshBroadcast');
  assert.equal(blocker(rules, { command: 'set name Väster', area: 'se-jkp' }), null);
  assert.equal(blocker(rules, { command: 'reboot', area: 'se-jkp' }), null);
  assert.equal(blocker(rules, { command: 'reboot', device: { region: 'JKG', ver: LOU18 } }), null);
  assert.equal(blocker(rules, { command: 'ota update', device: { region: 'JKG', ver: LOU19 } }), null);
  assert.ok(preflight(rules, { command: 'ota update', device: { region: 'JKG', ver: LOU19 } }).caution);
  assert.equal(preflight(rules, { command: 'ota update', device: { region: 'JKG', ver: LOU19 } }).admits, true);
  assert.equal(preflight(rules, { command: 'ota update', device: { region: 'JKG', ver: LOU18 } }).admits, false);
  assert.equal(preflight(rules, { command: 'ota update', device: { region: 'JKG', ver: LOU18 } }).needs, 'lou-19');
  assert.equal(blocker(rules, { command: 'set name Väster', device: { region: 'JKG', ver: AR10 } }).code, 'oldAscii');
  assert.equal(blocker(rules, { command: 'set name Väster', device: { region: 'JKG', ver: 'v1.18.0-lou-17-arrc-observer-1' } }), null);
  assert.equal(blocker(rules, { command: 'ver', device: { region: 'JKG' } }), null);
  const p = preflight(rules, { command: 'region', device: { region: 'JKG', ver: AR10, key: A } });
  assert.equal(p.admits, false);
  assert.equal(p.needs, 'ar-11');
  assert.equal(p.v2, false);
  assert.equal(preflight(rules, { command: 'reboot', device: { region: 'JKG', ver: LOU18, key: A } }).v2, true);
  assert.ok(preflight(rules, { command: 'reboot', device: { region: 'JKG' } }).caution);
  assert.deepEqual(fillSteps(['region put {arg} *', 'region save'], ' se-jkp '), ['region put se-jkp *', 'region save']);
  assert.throws(() => fillSteps(['region put {arg} *'], ''), (e) => e.code === 'needsArg');
});

test('send to one node: v2 with the whole keys, holds the key, lands in history and on the device', async () => {
  const { stores, transport, jobs, ring } = await setup();
  const out = await jobs.send({ command: 'ver', nodes: ['AAAA0001'] });
  assert.equal(out.answered, 1);
  const call = transport.calls[0];
  assert.equal(call.topic, `meshcore/JKG/${A}/cmd`);
  assert.equal(call.v2Key, A);
  assert.deepEqual(call.keys, { AAAA0001: A, BBBB0002: B });
  assert.deepEqual(call.nodesToHear, ['AAAA0001']);
  assert.equal(ring.holds, 1);
  assert.equal(ring.released, 1);
  assert.equal(ring.touched, 1);
  const [event] = await stores.history.list();
  assert.equal(event.command, 'ver');
  assert.equal(event.codeName, 'ok');
  assert.equal(event.verified, true);
  const d = await stores.devices.get('AAAA0001');
  assert.equal(d.ver, LOU18);
  assert.equal(d.lastResult.code, 0);
  assert.ok(d.lastHeard);
  assert.equal(d.reads.ver.reply, `> ${LOU18}`);
  // ar-10 speaks v1 only
  await jobs.send({ command: 'get radio', nodes: ['BBBB0002'] });
  assert.equal(transport.calls[1].v2Key, null);
});

test('a locked key signs nothing; a denied command is refused before signing', async () => {
  const { jobs, transport } = await setup({ ring: fakeRing({ unlocked: false }) });
  await assert.rejects(jobs.send({ command: 'ver', nodes: ['AAAA0001'] }), (e) => e instanceof JobError && e.code === 'locked');
  const open = await setup();
  await assert.rejects(open.jobs.send({ command: 'set prv.key 00', nodes: ['AAAA0001'] }), (e) => e.code === 'denied');
  await open.stores.devices.update('AAAA0001', { alive: { state: 'online', region: 'se-jkp' } });
  await assert.rejects(open.jobs.send({ command: 'trigger test', area: 'se-jkp' }), (e) => e.code === 'broadcastTransmit');
  assert.equal(transport.calls.length + open.transport.calls.length, 0);
});

test('a group: one signed per-node command each; a member that cannot take it is reported, the rest go', async () => {
  const { stores, transport, jobs } = await setup();
  await stores.groups.create('mixed', ['AAAA0001', 'BBBB0002']);
  const out = await jobs.send({ command: 'set name Väster', group: 'mixed' });
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].topic, `meshcore/JKG/${A}/cmd`);
  const b = out.outcomes.find((o) => o.node === 'BBBB0002');
  assert.equal(b.sent, false);
  assert.equal(b.reason.code, 'oldAscii');
  assert.equal(out.asked, 1);
  assert.equal(out.answered, 1);
});

test('silence and refusal are recorded as such; a forged answer is not heard', async () => {
  const { stores, jobs } = await setup({ behaviour: {
    AAAA0001: { ver: LOU18, answer: () => ({ code: 14, reply: '' }) }, BBBB0002: { silent: true }, CCCC0003: { forged: true, ver: LOU18 },
  } });
  const out = await jobs.send({ command: 'neighbors', nodes: ['AAAA0001', 'BBBB0002', 'CCCC0003'] });
  const by = Object.fromEntries(out.outcomes.map((o) => [o.node, o]));
  assert.equal(by.AAAA0001.result.code, 14);
  assert.equal(by.BBBB0002.result, null);
  assert.equal(by.CCCC0003.result.verified, false);
  assert.equal((await stores.devices.get('CCCC0003')).lastHeard, null);
  assert.equal((await stores.devices.get('BBBB0002')).lastResult.code, null);
  assert.deepEqual((await stores.history.list({ result: 'forged' })).map((e) => e.node), ['CCCC0003']);
  assert.equal((await stores.devices.get('AAAA0001')).reads.neighbors, undefined);
});

test('no region-wide broadcast: a region is no target any more', async () => {
  const { transport, jobs } = await setup();
  await assert.rejects(jobs.send({ command: 'get radio', region: 'jkg' }), (e) => e.code === 'oneTarget');
  assert.equal(transport.calls.length, 0);
});

test('a set stops at the first refusal; the steps after are not sent', async () => {
  const { transport, jobs } = await setup({ behaviour: {
    AAAA0001: { ver: LOU18, answer: (c) => (c === 'region save' ? { code: 14, reply: '' } : undefined) },
  } });
  const out = await jobs.runSet({ steps: all.brokers.default_sets['add-scope'], arg: 'se-jkp', nodes: ['AAAA0001'] });
  assert.equal(out.runs[0].stoppedAt, 2);
  assert.deepEqual(transport.calls.map((c) => c.command), ['region put se-jkp *', 'region allowf se-jkp', 'region save']);
  await assert.rejects(jobs.runSet({ steps: ['region put {arg} *'], nodes: ['AAAA0001'] }), (e) => e.code === 'needsArg');
});

test('discover marks known nodes, learns whole keys, reads names; adopt avoids a taken name', async () => {
  const { stores, jobs } = await setup({ behaviour: {
    CCCC0003: { region: 'GOT', key: C, ver: LOU18, name: 'charlie' }, DDDD0004: { region: 'GOT', name: 'bravo', ver: LOU18 },
  } });
  const found = await jobs.discover({ region: 'got' });
  assert.deepEqual(found.map((f) => [f.node, f.knownAs, f.name]), [['CCCC0003', 'charlie', 'charlie'], ['DDDD0004', null, 'bravo']]);
  assert.equal((await stores.devices.get('CCCC0003')).key, C);
  const added = await jobs.adopt(found[1]);
  assert.equal(added.name, 'bravo-2');
  assert.equal(added.region, 'GOT');
  await assert.rejects(jobs.discover({ region: 'x' }), (e) => e.code === 'badRegion');
});

test('refresh reads name and version: an unnamed node takes its own name', async () => {
  const { stores, jobs } = await setup();
  await stores.devices.update('CCCC0003', { name: '' });
  const r = await jobs.refresh({ nodes: ['CCCC0003', 'BBBB0002'] });
  assert.equal(r.versioned, 2);
  assert.equal(r.named, 1);
  assert.equal((await stores.devices.get('CCCC0003')).name, 'charlie');
  assert.equal((await stores.devices.get('CCCC0003')).ver, LOU18);
});

test('firmware update: refused before lou-19, which does not admit ota update; from it, polls ver until the new version', async () => {
  const { jobs } = await setup();
  await assert.rejects(jobs.update({ node: 'AAAA0001', target: 'v1.18.0-lou-20' }), (e) => e.code === 'otaRefused');
  let polls = 0;
  const fresh = await setup({ behaviour: {
    AAAA0001: { answer: (c) => {
      if (c === 'ota update') return { code: 0, reply: 'OK - updating' };
      polls += 1;
      return { code: 0, reply: polls < 2 ? `> ${LOU19}` : '> v1.18.0-lou-20-arrc-observer-0' };
    } },
  } });
  await fresh.stores.devices.update('AAAA0001', { ver: LOU19 });
  const stages = [];
  const res = await fresh.jobs.update({ node: 'AAAA0001', target: 'v1.18.0-lou-20', pollSecs: 0, onStage: (s) => stages.push(s.stage) });
  assert.equal(res.ok, true);
  assert.equal(res.version, 'v1.18.0-lou-20-arrc-observer-0');
  assert.deepEqual(stages, ['asking', 'restarting', 'checking', 'checking', 'done']);
  assert.equal((await fresh.stores.devices.get('AAAA0001')).ver, 'v1.18.0-lou-20-arrc-observer-0');
});

test('firmware update with check: ota check first, and ota update only when the node says an update fits', async () => {
  const sent = [];
  const make = (checkReply) => setup({ behaviour: {
    AAAA0001: { answer: (c) => {
      sent.push(c);
      if (c === 'ota check') return { code: 0, reply: checkReply };
      if (c === 'ota update') return { code: 0, reply: 'OK - updating' };
      return { code: 0, reply: '> v1.18.0-lou-20-arrc-observer-0' };
    } },
  } });
  const no = await make('> up to date: lou-19');
  await no.stores.devices.update('AAAA0001', { ver: LOU19 });
  const none = await no.jobs.update({ node: 'AAAA0001', target: 'v1.18.0-lou-20', pollSecs: 0, check: true });
  assert.equal(none.ok, false);
  assert.equal(none.reason.code, 'noUpdate');
  assert.deepEqual(sent, ['ota check']);                         // nothing was flashed

  sent.length = 0;
  const yes = await make('update available: lou-19 -> lou-20 (rev 19 -> 20)');
  await yes.stores.devices.update('AAAA0001', { ver: LOU19 });
  const stages = [];
  const res = await yes.jobs.update({ node: 'AAAA0001', target: 'v1.18.0-lou-20', pollSecs: 0, check: true, onStage: (st) => stages.push(st.stage) });
  assert.equal(res.ok, true);
  assert.deepEqual(sent.slice(0, 2), ['ota check', 'ota update']);
  assert.equal(stages[0], 'otaCheck');
});

test('a version shortens the same way from ver and from an alive message, and keeps what the image carries', () => {
  assert.equal(shortVersion(rules, 'esp32s3-v1.18.0-lou-20-arrc-observer-9c6c0a0 (Build: 24 Nov 2026)'), 'lou-20-arrc-observer');
  assert.equal(shortVersion(rules, 'lou-20-arrc-observer-9c6c0a0'), 'lou-20-arrc-observer');   // an alive message's
  assert.equal(shortVersion(rules, 'nrf52840-v1.18.0-lou-20-arrc-6491056 (Build: 24-Nov-2026)'), 'lou-20-arrc');
  assert.equal(shortVersion(rules, 'esp32s3-v1.18.0-lou-20-ar-6491056'), 'lou-20-ar');
  assert.equal(shortVersion(rules, 'v1.18.0-lou-20-rc-observer-abc1234'), 'lou-20-rc-observer');
  assert.equal(shortVersion(rules, 'lou-20rc-arrc-observer-60407864'), 'lou-20rc-arrc-observer');  // a release candidate keeps its mark
  assert.equal(shortVersion(rules, 'v1.18.0-lou-18'), 'lou-18');
  assert.equal(shortVersion(rules, 'v1.18.0-lou-20-ar5f1a6'), 'lou-20');                     // a hash that starts like a flavour is no flavour
});

test('releases: the newest real release, cached for an hour; the mark compares revisions', async () => {
  const list = [{ tag_name: 'v1.18.0-lou-19', draft: true }, { tag_name: 'v1.18.0-lou-19-rc', prerelease: true },
    { tag_name: 'v1.18.0-lou-18', name: 'v1.18.0-lou-18', html_url: 'x' }];
  assert.equal(newestRelease(list).tag, 'v1.18.0-lou-18');
  const stores = openStores(memoryDb(), OWNER);
  let reads = 0; let t = 0;
  const read = async () => { reads += 1; return list; };
  const source = { api: 'fake', cache_secs: 3600 };
  await latestRelease({ meta: stores.meta, read, now: () => t, source });
  t = 3599000;
  await latestRelease({ meta: stores.meta, read, now: () => t, source });
  assert.equal(reads, 1);
  t = 3601000;
  const failing = async () => { throw new Error('offline'); };
  assert.equal((await latestRelease({ meta: stores.meta, read: failing, now: () => t, source })).tag, 'v1.18.0-lou-18');
  assert.equal(await latestRelease({ read: failing, source }), null);
  const rel = newestRelease(list);
  assert.equal(updateAvailable(rules, AR10, rel), true);
  assert.equal(updateAvailable(rules, LOU18, rel), false);
  assert.equal(updateAvailable(rules, null, rel), null);
});

test('fleet: battery and last status from Beacon; a node Beacon does not know keeps nothing stale', async () => {
  const { stores } = await setup();
  await stores.devices.update('BBBB0002', { fleet: { batteryMv: 1, seen: 'old' } });
  // The statistics' Beacon client (lib/stats/beacon-client.js) over a fake fetch: one client for both.
  const asked = [];
  const fetch = async (url) => {
    asked.push(url.replace(BASE, ''));
    const path = url.replace(BASE, '');
    let body = null;
    if (path.startsWith('/nodes?pubkeyPrefix=aaaa0001')) body = { items: [{ publicKey: A, observerId: 'obs-a' }] };
    else if (path.startsWith('/nodes?')) body = { items: [] };
    else if (path === '/observers/obs-a') body = { lastStatusAt: 1763370000000, firmwareVersion: LOU18, statusMetadata: { stats: { battery_mv: 3999 } } };
    return { ok: body !== null, status: body ? 200 : 404, json: async () => body };
  };
  const r = await refreshFleet({ stores, client: beaconClient({ base: BASE, fetch }) });
  assert.ok(asked.every((p) => p.startsWith('/nodes?pubkeyPrefix=') || p.startsWith('/observers/')), asked.join());
  assert.deepEqual(r, { updated: 1, failed: 2 });
  assert.equal((await stores.devices.get('AAAA0001')).fleet.batteryMv, 3999);
  assert.equal((await stores.devices.get('BBBB0002')).fleet, null);
});

test('overview: attention in order, counts, recent since the last visit', async () => {
  const stores = openStores(memoryDb(), OWNER);
  const now = Date.parse('2026-11-17T12:00:00Z');
  await seedFixture(stores, now);
  const devices = await stores.devices.list();
  assert.equal(devices.length, 12);
  const items = needsAttention(devices, { now, hours: 24, thresholdMv: 3500, release: { tag: 'v1.18.0-lou-18' }, rules });
  const kinds = items.map((i) => i.kind);
  // not heard, battery, then the last results (no answer, refused), then outdated firmware
  assert.deepEqual([...new Set(kinds)].sort(), ['battery', 'noAnswer', 'notHeard', 'outdated', 'refused']);
  assert.ok(kinds.indexOf('battery') < kinds.indexOf('noAnswer') && kinds.lastIndexOf('refused') < kinds.indexOf('outdated'));
  assert.equal(items.find((i) => i.kind === 'notHeard').name, 'SE-JKG-Lekeryd');
  assert.deepEqual(items.filter((i) => i.kind === 'battery').map((i) => i.name).sort(), ['SE-JKG-Jöransberg', 'SE-JKG-Norrängen']);
  const c = fleetCounts(devices, { now, hours: 24, rules });
  assert.equal(c.total, 12);
  assert.equal(c.quiet, 1);
  assert.equal(c.unknown, 1);
  assert.deepEqual(c.regions, [['JKG', 10], ['GOT', 2]]);
  const events = await stores.history.list();
  assert.equal(recentSince(events, new Date(now - 2 * 3600000).toISOString()).length, 3);
  assert.equal(FIXTURE_NODES.length, 12);
  assert.ok(Object.keys(fixtureBehaviour()).length === 12);
});

test('history CSV: quoted, and formulas made inert', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell(null), '""');
  const csv = toCsv([{ id: '1', at: 't', node: 'AAAA0001', command: 'ver', code: 0, reply: '> v', verified: true, note: '' }], { AAAA0001: 'alpha' });
  assert.match(csv, /^id,at,node,name,region,command,result,code,codeName,verified,reply,note,batch,road,relay,route,relayStatus,snr\r\n"1","t","AAAA0001","alpha","","ver","ok","0","","true","> v","","","mqtt","","","",""\r\n$/);
  const relayed = toCsv([{ id: '2', at: 't', node: 'AAAA0001', command: 'ver', code: null, road: 'relay',
    relay: { node: 'BBBB0002', route: 'flood', status: 'no-answer', sent: 2, snr: null } }]);
  assert.match(relayed, /"relay","BBBB0002","flood","no-answer",""\r\n$/);
});

test('discover never replaces a stored key and learns none from a forged answer (W-12)', async () => {
  const OTHER = `AAAA0001${'9'.repeat(56)}`;
  const { stores, jobs } = await setup({ behaviour: {
    AAAA0001: { region: 'JKG', key: OTHER, ver: LOU18, name: 'alpha' },
    CCCC0003: { region: 'GOT', key: C, ver: LOU18, forged: true },
    EEEE0005: { region: 'GOT', key: `EEEE0005${'5'.repeat(56)}`, forged: true },
  } });
  const jkg = await jobs.discover({ region: 'JKG' });
  assert.equal(jkg[0].keyChanged, true);
  assert.equal((await stores.devices.get('AAAA0001')).key, A);
  const got = await jobs.discover({ region: 'GOT' });
  assert.equal((await stores.devices.get('CCCC0003')).key, null);
  const added = await jobs.adopt(got.find((f) => f.node === 'EEEE0005'));
  assert.equal(added.key, null);
});

test('preflight: a command that stops before its value is incomplete (W-23h)', () => {
  const dev = { region: 'JKG', ver: LOU19 };
  assert.equal(preflight(rules, { command: 'set autoreply', device: dev }).incomplete.text, 'set autoreply');
  assert.deepEqual(preflight(rules, { command: 'set loop.detect', device: dev }).incomplete.choices, ['off', 'minimal', 'moderate', 'strict']);
  assert.ok(preflight(rules, { command: 'get', device: dev }).incomplete);
  for (const c of ['set autoreply on', 'ver', 'region', 'trigger test', 'set autoreply.hops 3', 'set autorep', '']) {
    assert.equal(preflight(rules, { command: c, device: dev }).incomplete, null, c);
  }
});

test('a read that answers with a bare code gets its meaning in words', async () => {
  const { valueWords } = await import('../ui/screens/node-kit.js');
  const t = (key) => key;
  assert.equal(valueWords(t, 'get path.hash.mode', '> 0'), 'value.path.hash.mode.0');
  assert.equal(valueWords(t, 'get path.hash.mode', '>2'), 'value.path.hash.mode.2');
  assert.equal(valueWords(t, 'get loop.detect', '> strict'), 'value.loop.detect.strict');
  assert.equal(valueWords(t, 'get path.hash.mode', '> 7'), '');          // a value not in the list: no words
  assert.equal(valueWords(t, 'get name', '> 0'), '');                    // a setting not in the list
  assert.equal(valueWords(t, 'set path.hash.mode 1', 'OK'), '');
});
