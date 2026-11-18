// W-24: possible mesh-only nodes found by position, and the one signed `ver` that confirms one.
// The real county outlines, a fake Beacon and a fake companion; nothing transmits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beaconCandidates, insideCounty } from '../lib/discovery/mesh-candidates.js';
import { beaconClient } from '../lib/stats/beacon.js';
import { memoryDb } from '../lib/store/db.js';
import { openStores } from '../lib/store/index.js';
import { rulesFrom } from '../lib/protocol/rules.js';
import { createJobs, JobError } from '../lib/jobs/jobs.js';
import { openCompanion } from '../lib/mesh/companion.js';
import { CMD } from '../lib/mesh/frames.js';
import { keyFromSeed } from '../lib/key/handle.js';
import { fromHex } from '../lib/bytes.js';
import { data, V } from './protocol-helpers.js';
import { fakeTransport } from './jobs-fakes.js';
import { fakeCompanion } from './mesh-fakes.js';

const geo = JSON.parse(readFileSync(new URL('../ui/tiles/se-lan.json', import.meta.url), 'utf8'));
const key = (c) => c.repeat(64);

test('inside a county: Jönköping in Jönköpings län, Göteborg and the sea not', () => {
  assert.equal(insideCounty(geo, '06', 57.78, 14.16), true);
  assert.equal(insideCounty(geo, '06', 57.70, 11.97), false);
  assert.equal(insideCounty(geo, '14', 57.70, 11.97), true);
  assert.equal(insideCounty(geo, '06', 56.5, 17.5), false);
  assert.equal(insideCounty(geo, '99', 57.78, 14.16), false);
  assert.equal(insideCounty(geo, '06', NaN, 14.16), false);
});

test('Beacon candidates: repeaters, not observers, placed inside the county, not known, newest first', () => {
  const rows = [
    { publicKey: key('a'), name: 'Mesh-only A', nodeType: 2, isObserver: false, lat: 57.78, lng: 14.16, lastSeen: 10 },
    { publicKey: key('b'), name: 'Observer', nodeType: 2, isObserver: true, lat: 57.78, lng: 14.16, lastSeen: 20 },
    { publicKey: key('c'), name: 'Companion', nodeType: 1, nodeTypeName: 'companion', lat: 57.78, lng: 14.16 },
    { publicKey: key('d'), name: 'Göteborg', nodeTypeName: 'repeater', lat: 57.70, lng: 11.97 },
    { publicKey: key('e'), name: 'No position', nodeType: 2, lat: 0, lng: 0 },
    { publicKey: key('f'), name: 'Known', nodeType: 2, lat: 57.9, lng: 14.3 },
    { publicKey: key('1'), name: 'Mesh-only B', nodeType: 2, lat: 57.65, lng: 14.7, lastSeen: 30 },
    { publicKey: 'short', nodeType: 2, lat: 57.78, lng: 14.16 },
  ];
  const out = beaconCandidates(rows, { geo, scb: '06', known: new Set(['FFFFFFFF']) });
  assert.deepEqual(out.map((c) => c.name), ['Mesh-only B', 'Mesh-only A']);
  assert.deepEqual(out[1], { node: 'AAAAAAAA', key: key('A'), name: 'Mesh-only A', source: 'beacon', lastSeen: 10 });
  assert.deepEqual(beaconCandidates(rows, { geo, scb: '06', ignored: new Set(['11111111', 'AAAAAAAA', 'FFFFFFFF']) }), []);
});

test("Beacon's node list is read page by page, by the integer cursor, and stops", async () => {
  const asked = [];
  const pages = { '': { items: [{ id: 1 }, { id: 2 }], hasMore: true, nextCursor: 1794777509527 },
    1794777509527: { items: [{ id: 3 }], hasMore: false, nextCursor: null } };
  const get = async (url) => {
    asked.push(url);
    const cursor = new URL(url).searchParams.get('cursor') || '';
    return { ok: true, json: async () => pages[cursor] };
  };
  const b = beaconClient({ base: 'https://beacon.example/api/v1', fetch: get });
  assert.deepEqual((await b.allNodes()).map((n) => n.id), [1, 2, 3]);
  assert.equal(asked.length, 2);
  assert.match(asked[1], /cursor=1794777509527/);
  const loop = beaconClient({ base: 'https://b.x', fetch: async () => ({ ok: true, json: async () => ({ items: [{}], hasMore: true, nextCursor: 5 }) }) });
  assert.equal((await loop.allNodes({ maxPages: 3 })).length, 3);
});

const all = Object.fromEntries(['brokers', 'cautions', 'commands', 'denylist', 'facts', 'firmware', 'results'].map((n) => [n, data(n)]));
const rules = rulesFrom(all);
const owner = keyFromSeed(fromHex(V.seed));
const K = V.node_key.toUpperCase();
const N = K.slice(0, 8);

async function setup({ answer, region = 'mesh', connected = true, locked = false } = {}) {
  const stores = openStores(memoryDb(), 'C'.repeat(64));
  const fake = fakeCompanion({ ownerKey: owner.publicKeyHex, region, ...(answer ? { answer } : {}) });
  const radio = connected ? await openCompanion(fake.link) : null;
  const jobs = createJobs({ ring: { handle: () => (locked ? null : owner), hold: () => () => {}, touch() {} },
    stores, rules, brokers: all.brokers, results: all.results, transport: fakeTransport({}), waitSecs: 1, companion: () => radio });
  return { stores, jobs, fake };
}

test('Check: one signed ver on meshcore/mesh/<key>/cmd; an answer adds the node as mesh-only', async () => {
  const { stores, jobs, fake } = await setup({ answer: (c) => (c === 'ver' ? { code: 0, reply: 'v1.18.0-lou-19-rc-1a2b3c4d' } : null) });
  const out = await jobs.checkMeshNode({ candidate: { node: N, key: K, name: 'Hidden', source: 'beacon' }, region: 'jkg' });
  assert.equal(out.answered, true);
  assert.equal(out.device.node, N);
  assert.equal(out.device.meshOnly, true);
  assert.equal(out.device.region, '', 'by its whole key: no region');
  assert.equal(out.device.ver, 'v1.18.0-lou-19-rc-1a2b3c4d');
  const events = await stores.history.list({ node: N });
  assert.equal(events.length, 1);
  assert.equal(events[0].topic, `meshcore/mesh/${K}/cmd`);
  assert.equal(events[0].road, 'mesh');
  assert.equal(fake.link.written.filter((f) => f[0] === CMD.SEND_ANON_REQ).length, 1, 'one request on the air');
});

test('Check: silence adds nothing; a node signed for its IATA does not answer the mesh topic', async () => {
  const quiet = await setup({ answer: () => null });
  const out = await quiet.jobs.checkMeshNode({ candidate: { node: N, key: K, name: 'Quiet' }, region: 'JKG' });
  assert.deepEqual([out.answered, out.device], [false, null]);
  assert.equal((await quiet.stores.devices.list()).length, 0);
  assert.equal((await quiet.stores.history.list({})).length, 0);
  const mqtt = await setup({ region: 'JKG' });
  assert.equal((await mqtt.jobs.checkMeshNode({ candidate: { node: N, key: K }, region: 'JKG' })).answered, false);
});

test('Check needs the whole key (no region), the key unlocked and the companion', async () => {
  const { jobs } = await setup();
  await assert.rejects(jobs.checkMeshNode({ candidate: { node: N, key: 'AB' }, region: 'JKG' }), (e) => e instanceof JobError && e.code === 'meshNoKey');
  await assert.rejects((await setup({ locked: true })).jobs.checkMeshNode({ candidate: { node: N, key: K }, region: 'JKG' }), (e) => e.code === 'locked');
  await assert.rejects((await setup({ connected: false })).jobs.checkMeshNode({ candidate: { node: N, key: K }, region: 'JKG' }), (e) => e.code === 'noCompanion');
});
