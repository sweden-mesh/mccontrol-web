// lib/discovery (W-20a, IATA2-MC4): the county table, automatic discovery on unlock (the alive scan
// every run, wherever the nodes are; the old discovery only in the IATA codes of the list's own
// lou-19-or-older nodes, at most hourly per region), adoption with undo, the broker's caps, and
// mesh-only candidates from a companion. There is no area to choose. With a fake clock, fake jobs
// and an in-memory store: nothing reaches a broker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaByScb, areaByScope, areaLabel, areaList, iatasOf } from '../lib/discovery/areas.js';
import { ALIVE_COOLDOWN_MS, createDiscovery, META } from '../lib/discovery/index.js';
import { areasTable, fakeClock, fakeJobs, HOUR, memStores, MIN, settle } from './auto-fakes.js';

// `region`: an old (lou-19) node of the owner's already in the list there, so the old discovery looks there.
const setup = async (answers = {}, { region = 'JKG', unlocked = true, ...opts } = {}) => {
  const clock = fakeClock();
  const stores = memStores(clock);
  const jobs = fakeJobs(stores, answers);
  const lock = { open: unlocked };
  const d = createDiscovery({ stores, jobs, clock, unlocked: () => lock.open, ...opts });
  if (region) await stores.devices.add({ node: 'AAAA0000', region, name: 'seed' });
  return { clock, stores, jobs, d, lock };
};

const discovers = (jobs) => jobs.calls.filter((c) => c[0] === 'discover').map((c) => c[1]);

test('areas: every county once, shown with its scope, sorted in Swedish', () => {
  const list = areaList(areasTable, 'sv');
  assert.equal(list.length, 21);
  assert.equal(new Set(list.map((a) => a.scb)).size, 21);
  assert.equal(list[0].county, 'Blekinge län');
  assert.deepEqual(list.slice(-3).map((a) => a.county), ['Västra Götalands län', 'Örebro län', 'Östergötlands län']);
  assert.equal(areaLabel(areaByScb(areasTable, '06')), 'Jönköpings län · se-jkp');
  assert.deepEqual(iatasOf(areasTable, '06'), ['JKG']);
  assert.deepEqual(iatasOf(areasTable, '03'), ['STO']);   // Uppsala shares Stockholm's code
  assert.deepEqual(iatasOf(areasTable, null), []);
  assert.equal(areaByScope(areasTable, 'SE-JKP').county, 'Jönköpings län');
  assert.equal(areaByScope(areasTable, 'nowhere'), null);
});

test('the alive scan runs every time, adds your nodes wherever they are with no region, offline ones are not added', async () => {
  const K1 = `4FD099CC${'1'.repeat(56)}`;
  const K2 = `5FD099CC${'2'.repeat(56)}`;
  const { d, jobs, stores, clock } = await setup({ '*alive': [{ key: K1, name: 'Loutest', region: 'se-jkp' }, { key: K2, state: 'offline' }] }, { region: null });
  await d.start();
  await clock.advance(0);
  assert.deepEqual(jobs.calls.map((c) => c[0]).filter((c) => c !== 'adopt'), ['alive'], 'no region: no broadcast at all');
  const [x] = await stores.devices.list();
  assert.deepEqual([x.node, x.key, x.name, x.region, x.alive.region], ['4FD099CC', K1, 'Loutest', '', 'se-jkp']);
  assert.deepEqual(d.state().last.alive, { ours: 1, offline: 1, notYours: 0 });
  assert.equal(d.state().nextRun, d.state().lastRun + ALIVE_COOLDOWN_MS);
  const again = await d.run({ force: true });
  assert.equal(again.known, 1);
  assert.equal(again.added.length, 0);
});

test("the first start runs at once in an old node's region, adds every answering node with its own name", async () => {
  const { d, jobs, stores, clock } = await setup({ JKG: [{ node: '4AC61A7F', name: 'Gisebo' }, { node: '13B58595', name: 'Torpa' }] });
  await d.start();
  await clock.advance(0);
  assert.deepEqual(discovers(jobs), ['JKG']);
  const names = (await stores.devices.list()).filter((x) => x.name !== 'seed').map((x) => [x.node, x.name, x.region]);
  assert.deepEqual(names.sort(), [['13B58595', 'Torpa', 'JKG'], ['4AC61A7F', 'Gisebo', 'JKG']]);
  const s = d.state();
  assert.equal(s.running, false);
  assert.deepEqual(s.last.added.map((a) => a.name).sort(), ['Gisebo', 'Torpa']);
  assert.equal(s.canUndo, true);
  assert.equal(s.lastRun, s.last.at);
  assert.equal(s.nextRun, s.lastRun + ALIVE_COOLDOWN_MS);
});

test('at most once an hour per region, and the cooldown survives a reload', async () => {
  const { d, jobs, clock, stores } = await setup({ JKG: [] });
  await d.start();
  await clock.advance(59 * MIN);
  assert.deepEqual(discovers(jobs), ['JKG']);
  // a new page: a new discovery over the same stores starts nothing before the hour
  const again = createDiscovery({ stores, jobs, table: areasTable, clock, unlocked: () => true });
  await again.start();
  await settle();
  assert.deepEqual(discovers(jobs), ['JKG']);
  d.stop();
  await clock.advance(1 * MIN);
  assert.deepEqual(discovers(jobs), ['JKG', 'JKG']);
});

test('nothing runs while the key is locked; a locked failure stops the run', async () => {
  const { d, jobs, clock, lock } = await setup({}, { unlocked: false });
  await d.start();
  await clock.advance(2 * HOUR);
  assert.deepEqual(discovers(jobs), []);
  assert.equal(d.state().nextRun, null);
  lock.open = true;
  const locked = Object.assign(new Error('The key is locked.'), { code: 'locked' });
  const s2 = await setup({ JKG: locked });
  const out = await s2.d.run();
  assert.deepEqual(out.failed, [{ region: 'JKG', code: 'locked', detail: 'The key is locked.' }]);
});

test("only the IATA codes of the list's own lou-19-or-older nodes are searched the old way", async () => {
  const { rulesFrom } = await import('../lib/protocol/rules.js');
  const { data } = await import('./protocol-helpers.js');
  const rules = rulesFrom(Object.fromEntries(['cautions', 'commands', 'denylist', 'facts', 'firmware'].map((n) => [n, data(n)])));
  const { d, jobs, stores } = await setup({ GOT: [] }, { rules });
  await stores.devices.add({ node: 'AB6B9285', region: 'GOT', name: 'Far' });
  await stores.devices.add({ node: 'CD6B9285', key: `CD6B9285${'1'.repeat(56)}`, region: 'STO', name: 'New' });
  // a lou-20 node whose alive has been seen speaks mcc3 (one without an alive is taken to be on the old login)
  await stores.devices.update('CD6B9285', { ver: 'v1.18.0-lou-20-arrc-observer-1', alive: { state: 'online', at: new Date().toISOString() } });
  await stores.devices.add({ node: 'EF6B9285', key: `EF6B9285${'1'.repeat(56)}`, region: '', name: 'Fleet' });
  await stores.devices.update('EF6B9285', { fleet: { iatas: ['VXO'] } });
  await d.run();
  assert.deepEqual(discovers(jobs), ['JKG', 'GOT', 'VXO'], 'not STO: its only node speaks mcc3');
  const empty = await setup({}, { region: null });
  await empty.d.start();
  assert.deepEqual(empty.d.state().regions, []);
  assert.equal('needsArea' in empty.d.state(), false);
  assert.equal(typeof empty.d.setArea, 'undefined');
});

test('forged answers and changed keys are reported, never added; known nodes are counted', async () => {
  const { d, stores } = await setup({ JKG: [
    { node: '4AC61A7F', name: 'Gisebo' },
    { node: 'DEADBEEF', name: 'Evil', verified: false },
    { node: '13B58595', name: 'Torpa', key: `13B58595${'9'.repeat(56)}` },
  ] });
  await stores.devices.add({ node: '13B58595', key: `13B58595${'0'.repeat(56)}`, region: 'JKG', name: 'Torpa' });
  const out = await d.run();
  assert.deepEqual(out.added.map((a) => a.node), ['4AC61A7F']);
  assert.equal(out.known, 1);
  assert.deepEqual(out.rejected, [{ node: 'DEADBEEF', region: 'JKG', reason: 'forged' }, { node: '13B58595', region: 'JKG', reason: 'keyChanged' }]);
  assert.equal(await stores.devices.get('DEADBEEF'), undefined);
});

test('undo removes what was added and keeps it out of later runs until allowed', async () => {
  const { d, stores, clock } = await setup({ JKG: [{ node: '4AC61A7F', name: 'Gisebo' }] });
  await d.run();
  assert.ok(await stores.devices.get('4AC61A7F'));
  const removed = await d.undo();
  assert.deepEqual(removed.map((r) => r.node), ['4AC61A7F']);
  assert.equal(await stores.devices.get('4AC61A7F'), undefined);
  assert.equal(d.state().canUndo, false);
  assert.equal(d.state().last.undone, true);
  await clock.advance(HOUR);
  const out = await d.run();
  assert.equal(out.added.length, 0);
  assert.equal(out.ignored, 1);
  await d.allow('4ac61a7f');
  await clock.advance(HOUR);
  assert.equal((await d.run()).added.length, 1);
});

test('"Look now" ignores the cooldown but not the broker cap: two runs an hour per region', async () => {
  const { d, jobs, clock } = await setup({ JKG: [] });
  await d.run();
  assert.equal((await d.run()).regions.length, 0);              // due: nothing, cooldown
  await d.run({ force: true });
  const third = await d.run({ force: true });
  assert.deepEqual(third.skipped, [{ region: 'JKG', reason: 'recent' }]);
  assert.deepEqual(discovers(jobs), ['JKG', 'JKG']);
  await clock.advance(HOUR);
  await d.run({ force: true });
  assert.deepEqual(discovers(jobs), ['JKG', 'JKG', 'JKG']);
});

test('at most eight regions an hour per key; the rest wait for the hour to pass', async () => {
  const { d, jobs, stores, clock } = await setup({}, { region: null });
  const regions = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH', 'III', 'JJJ'];
  for (const [i, r] of regions.entries()) await stores.devices.add({ node: `0000000${i}`, region: r });
  await d.start();
  await clock.advance(0);
  assert.equal(discovers(jobs).length, 8);
  assert.deepEqual(d.state().last.skipped.map((s) => s.reason), ['cap', 'cap']);
  assert.equal(d.state().nextRun, d.state().lastRun + HOUR);
  await clock.advance(HOUR);
  assert.deepEqual(discovers(jobs).slice(8, 10), ['III', 'JJJ']);
});

test('a broker failure in one region is reported and the others still run', async () => {
  const { d, stores } = await setup({ JKG: new Error('cannot reach wss://broker/ (1006)'), GOT: [{ node: 'AB6B9285', name: 'Far' }] });
  await stores.devices.add({ node: '00000001', region: 'GOT' });
  const out = await d.run();
  assert.deepEqual(out.failed, [{ region: 'JKG', code: 'broker', detail: 'cannot reach wss://broker/ (1006)' }]);
  assert.deepEqual(out.added.map((a) => a.node), ['AB6B9285']);
});

test('a second run while one is in progress gets the same promise; listeners hear running', async () => {
  const { d } = await setup({ JKG: [] });
  const seen = [];
  d.on((s) => seen.push(s.running));
  const a = d.run();
  const b = d.run();
  assert.equal(a, b);
  await a;
  assert.equal(seen[0], true);
  assert.equal(seen.at(-1), false);
});

test("mesh-only candidates: the companion's repeaters not in the list, added as mesh-only by key, no region", async () => {
  const { d, stores } = await setup();
  await stores.devices.add({ node: '4AC61A7F', region: 'JKG', name: 'Gisebo' });
  const companion = { closed: false, contacts: async () => [
    { publicKey: `4AC61A7F${'1'.repeat(56)}`, type: 2, name: 'Gisebo', hops: 1 },
    { publicKey: `F00DF00D${'2'.repeat(56)}`, type: 2, name: 'Hill', hops: 2 },
    { publicKey: `C0FFEE00${'3'.repeat(56)}`, type: 1, name: 'A phone', hops: 0 },
  ] };
  const list = await d.meshCandidates(companion);
  assert.deepEqual(list.map((c) => c.node), ['F00DF00D']);
  const added = await d.addMeshNode(list[0]);
  assert.equal(added.meshOnly, true);
  assert.equal(added.region, '');
  assert.equal(added.key, `F00DF00D${'2'.repeat(56)}`);
  assert.deepEqual(await d.meshCandidates(null), []);
});
