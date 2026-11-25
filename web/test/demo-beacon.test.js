// The demo's Beacon and release list (W-39c): every path the page asks has an answer in the shape
// its readers take, and nothing else gets through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoAnswer, demoBeacon, demoReleases, DEMO_IATA } from '../lib/demo/beacon-world.js';

const BEACON = 'https://beacon.meshcoresverige.se/api/v1';
import { demoWorld } from '../lib/demo/world.js';
import { beaconClient, nodeStats } from '../lib/stats/beacon-client.js';
import { newestRelease } from '../lib/jobs/releases.js';
import { demoFetch } from '../ui/demo/mode.js';

const world = demoWorld();
const NOW = Date.UTC(2026, 10, 23, 12);
const ORIGIN = 'https://mccontrol.example';
const fetchDemo = demoFetch(async (u) => new Response(`real:${u}`), (u, o) => demoAnswer(u, { ...o, now: NOW }), ORIGIN);
const client = beaconClient({ base: BEACON, fetch: fetchDemo });

test('the Beacon client reads every demo node that has been heard, by id and by whole key', async () => {
  for (const n of world.nodes.filter((x) => x.heard !== null)) {
    assert.equal((await client.findNode(n.node)).name, n.name);
    assert.equal((await client.findNode(n.key)).id, n.beaconId);
  }
  await assert.rejects(client.findNode(world.nodes.find((n) => n.heard === null).node), /does not know/);
  await assert.rejects(client.findNode('00000000'), /does not know/);
});

test('an observer and its telemetry, 24 h and a week, in the shape the statistics take', async () => {
  const n = world.nodes.find((x) => x.kind === 'wifi' && x.mv);
  const o = await client.observer(n.observerId);
  assert.equal(o.firmwareVersion, n.fw);
  assert.equal(o.lastStatusAt, NOW - n.heard * 3600000);
  assert.equal((await client.telemetry(n.observerId, '24h')).points.length, 24);
  assert.equal((await client.telemetry(n.observerId, '168h')).points.length, 168);
  const stats = await nodeStats(client, n.node, '24h', NOW);
  assert.ok(stats, 'nodeStats reads it');
});

test('the offline node\'s points stop when it did; a mesh-only node is no observer', () => {
  const off = world.nodes.find((x) => x.kind === 'offline');
  assert.equal(demoBeacon(world, `/observers/${off.observerId}/telemetry?range=24h`, NOW).points.length, 0);
  assert.ok(demoBeacon(world, `/observers/${off.observerId}/telemetry?range=168h`, NOW).points.length > 100);
  const mesh = world.nodes.find((x) => x.kind === 'mesh');
  assert.equal(mesh.observerId, null);
  assert.equal(demoBeacon(world, `/nodes?pubkeyPrefix=${mesh.node}`, NOW).items[0].isObserver, false);
});

test('the area list for the map and a node\'s neighbours', async () => {
  const area = demoBeacon(world, `/nodes?iatas=${DEMO_IATA}&neighbors=true&limit=1000`, NOW);
  assert.ok(area.items.length > world.nodes.length);
  assert.ok(area.items.every((i) => /^DEMO-/.test(i.name) && Number.isFinite(i.lat)));
  assert.equal(new Set(area.items.map((i) => i.publicKey)).size, area.items.length);
  const nb = demoBeacon(world, '/nodes/demo-0/neighbors', NOW);
  assert.ok(nb.length >= 2 && nb.every((m) => m.lastSeen <= NOW));
  assert.equal(demoBeacon(world, '/nodes/demo-99/neighbors', NOW), null);
  assert.equal(demoBeacon(world, '/no/such/path', NOW), null);
});

test('the release list is one the release reader takes', () => {
  assert.equal(newestRelease(demoReleases(NOW)).tag, 'v1.18.0-lou-20');
});

test('the page\'s fetch: own files and the basemap pass, Beacon and GitHub are answered here, the rest is refused', async () => {
  assert.equal(await (await fetchDemo(`${ORIGIN}/lib/data/commands.json`)).text(), `real:${ORIGIN}/lib/data/commands.json`);
  assert.equal(await (await fetchDemo('i18n/sv.json')).text(), 'real:i18n/sv.json');
  assert.match(await (await fetchDemo('https://tiles.openfreemap.org/styles/x')).text(), /^real:/);
  assert.equal((await (await fetchDemo('https://api.github.com/repos/sweden-mesh/MeshCore-lou/releases')).json())[0].tag_name, 'v1.18.0-lou-20');
  assert.equal((await fetchDemo(`${BEACON}/no/such`)).status, 404);
  assert.ok(Array.isArray((await (await fetchDemo('https://beacon.meshcore-jkp.se/api/v1/nodes?iatas=JKG')).json()).items));
  await assert.rejects(fetchDemo('https://example.org/x'), /no other host/);
  await assert.rejects(fetchDemo('http://example.org/api/v1/nodes'), /no other host/);
  // Whatever host a Beacon path names, the demo answers it itself: nothing is sent there.
  assert.ok(Array.isArray((await (await fetchDemo('https://elsewhere.example/api/v1/nodes?iatas=JKG')).json()).items));
});
