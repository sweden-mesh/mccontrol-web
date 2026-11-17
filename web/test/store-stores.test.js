// lib/store: devices, groups (RM-4), sets, history and meta, per key, over the in-memory db.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from '../lib/store/db.js';
import { deriveFacts, eventId, openStores, resultKind, validName } from '../lib/store/index.js';
import { rulesFrom } from '../lib/protocol/rules.js';
import { data } from './protocol-helpers.js';

const OWNER = 'A'.repeat(64);
const OTHER = 'B'.repeat(64);
const KEY = `4AC61A7F${'0'.repeat(56)}`;
const sets = data('brokers').default_sets;
const rules = rulesFrom({ denylist: data('denylist'), cautions: data('cautions'), commands: data('commands'), firmware: data('firmware'), facts: data('facts') });

function clockAt(start = Date.parse('2026-11-17T10:00:00Z')) {
  let t = start;
  return { now: () => t, tick: (ms = 1000) => { t += ms; } };
}

test('devices: add by key or prefix, unique node and name, update, remove leaves groups', async () => {
  const s = openStores(memoryDb(), OWNER.toLowerCase());
  assert.equal(s.owner, OWNER);
  const d = await s.devices.add({ node: KEY, region: 'jkg', name: 'Gisebo' });
  assert.equal(d.id, '4AC61A7F');
  assert.equal(d.key, KEY);
  assert.equal(d.region, 'JKG');
  assert.ok(d.created && d.updated);
  await assert.rejects(s.devices.add({ node: '4ac61a7f', region: 'JKG' }), /already/);
  await assert.rejects(s.devices.add({ node: 'F355EEDD', region: 'JKG', name: 'gisebo' }), /named/);
  await assert.rejects(s.devices.add({ node: 'F355', region: 'JKG' }), /8 hex/);
  await assert.rejects(s.devices.add({ node: 'F355EEDD', region: 'J' }), /region/);
  const g = await s.devices.add({ node: 'F355EEDD', region: 'JKG' });
  assert.equal(g.key, null);
  assert.equal((await s.devices.update('f355eedd', { name: 'Granarp' })).name, 'Granarp');
  await assert.rejects(s.devices.update('F355EEDD', { name: 'GISEBO' }), /named/);
  await s.groups.create('canary', ['4AC61A7F', 'F355EEDD']);
  await s.devices.remove('F355EEDD');
  assert.deepEqual((await s.groups.get('canary')).members, ['4AC61A7F']);
  assert.equal((await s.devices.list()).length, 1);
});

test('records of another key are invisible', async () => {
  const db = memoryDb();
  const a = openStores(db, OWNER);
  const b = openStores(db, OTHER);
  await a.devices.add({ node: KEY, region: 'JKG' });
  await a.history.append({ node: '4AC61A7F', command: 'ver', code: 0, reply: '> x' });
  assert.equal((await b.devices.list()).length, 0);
  assert.equal((await b.history.list()).length, 0);
  assert.throws(() => openStores(db, 'abc'), /64-hex/);
});

test('groups: one-word names, members change, a missing group says so', async () => {
  const s = openStores(memoryDb(), OWNER);
  await s.devices.add({ node: KEY, region: 'JKG' });
  await s.devices.add({ node: 'F355EEDD', region: 'JKG' });
  await assert.rejects(s.groups.create('two words'), /one word/);
  await s.groups.create('Canary', ['4ac61a7f']);
  await assert.rejects(s.groups.create('canary'), /exists/);
  const g = await s.groups.change('canary', { add: ['F355EEDD'], remove: ['4AC61A7F'] });
  assert.deepEqual(g.members, ['F355EEDD']);
  await s.groups.remove('canary');
  assert.equal(await s.groups.get('canary'), null);
  await assert.rejects(s.groups.remove('canary'), /No group/);
  assert.equal(validName('Site.North-1'), 'site.north-1');
});

test('sets: the shipped one until removed, at most six steps', async () => {
  const s = openStores(memoryDb(), OWNER, { defaultSets: sets });
  assert.deepEqual(Object.keys(await s.sets.list()), ['add-scope']);
  await s.sets.save('reads', ['ver', ' get name ', '']);
  assert.deepEqual((await s.sets.list()).reads, ['ver', 'get name']);
  await assert.rejects(s.sets.save('x', []), /at least one/);
  await assert.rejects(s.sets.save('x', ['a', 'b', 'c', 'd', 'e', 'f', 'g']), /at most 6/);
  await s.sets.remove('add-scope');
  assert.deepEqual(Object.keys(await s.sets.list()), ['reads']);
  await assert.rejects(s.sets.remove('add-scope'), /No set/);
});

test('history: append-only events with stable ids, filters, and an import that never overwrites', async () => {
  const clock = clockAt();
  const s = openStores(memoryDb(), OWNER, { now: clock.now });
  const e1 = await s.history.append({ node: '4ac61a7f', command: 'ver', code: 0, reply: '> v', verified: true });
  clock.tick();
  const e2 = await s.history.append({ node: '4AC61A7F', command: 'get name', code: 14, reply: '', verified: true });
  clock.tick();
  const e3 = await s.history.append({ node: 'F355EEDD', command: 'ver', code: null });
  clock.tick();
  const e4 = await s.history.append({ node: null, region: 'JKG', command: 'ver', note: '1 of 2 answered' });
  assert.equal(new Set([e1.id, e2.id, e3.id, e4.id]).size, 4);
  assert.equal(e1.created, e1.updated);
  assert.equal(e1.v, 1);
  assert.equal(e1.node, '4AC61A7F');
  assert.deepEqual((await s.history.list()).map((e) => e.id), [e4.id, e3.id, e2.id, e1.id]);
  assert.deepEqual((await s.history.list({ result: 'refused' })).map((e) => e.id), [e2.id]);
  assert.deepEqual((await s.history.list({ result: 'silent' })).map((e) => e.id), [e3.id]);
  assert.deepEqual((await s.history.list({ node: 'all' })).map((e) => e.id), [e4.id]);
  assert.equal(resultKind(e4), 'summary');
  assert.equal(resultKind({ code: 0, verified: false, node: 'X' }), 'forged');

  const exported = await s.history.list();
  const fresh = openStores(memoryDb(), OWNER);
  assert.deepEqual(await fresh.history.import(exported), { added: 4, skipped: 0, foreign: 0 });
  assert.deepEqual(await fresh.history.import([...exported, { ...exported[0], owner: OTHER, id: 'zz' }, { bad: 1 }]),
    { added: 0, skipped: 5, foreign: 1 });
  assert.deepEqual((await fresh.history.list()).map((e) => e.id), exported.map((e) => e.id));
  await assert.rejects(fresh.history.import({}), /list/);
  // W-12: a crafted file cannot smuggle odd types into the history.
  const good = { id: 'x1', at: '2026-11-17T10:00:00.000Z', node: '4AC61A7F', command: 'ver', code: 0, reply: 'v1', verified: true };
  const bad = [
    { ...good, id: 'b1', verified: 'yes' }, { ...good, id: 'b2', node: '<img>' }, { ...good, id: 'b3', code: '0' },
    { ...good, id: 'b4', reply: 'x'.repeat(5000) }, { ...good, id: 'b5', at: 'soon' }, { ...good, id: 'b 6' },
    { ...good, id: 'b7', reply: { toString: 1 } },
  ];
  assert.deepEqual(await fresh.history.import([good, ...bad]), { added: 1, skipped: bad.length, foreign: 0 });
});

test('event ids sort by time', () => {
  assert.ok(eventId(1000) < eventId(2000));
  assert.match(eventId(Date.now()), /^[0-9a-z]{9}-[0-9a-f]{16}$/);
});

test('facts: newest answer wins, a forged one counts for nothing, unknown reads stay raw', async () => {
  const device = { reads: { ver: { reply: '> v1.17.1-ar-10', at: '2026-11-01T00:00:00Z', verified: null },
    board: { reply: '> Heltec V3', at: '2026-11-01T00:00:00Z', verified: true } } };
  const events = [
    { at: '2026-11-02T00:00:00Z', command: 'ver', code: 0, reply: '> v1.18.0-lou-18', verified: true },
    { at: '2026-11-03T00:00:00Z', command: 'ver', code: 0, reply: '> forged', verified: false },
    { at: '2026-11-02T00:00:00Z', command: 'set txdelay 0.5', code: 0, reply: 'OK', verified: true },
  ];
  const { facts, raw } = deriveFacts(device, events, rules.parseFacts);
  assert.equal(facts.version.value, 'v1.18.0-lou-18');
  assert.equal(facts.txdelay.value, '0.5');
  assert.equal(raw.board.reply, '> Heltec V3');
});
