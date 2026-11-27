// The demo's Beacon and release list (W-39c): what the page would read from Beacon and GitHub,
// answered from the demo's world, so a demo page asks no other host for anything about nodes.
//
//   demoBeacon(world, path, now)   Beacon's JSON for a path after the API base, or null (not found)
//   demoReleases(world)            the GitHub release list
//   demoAnswer(url, { origin, now })   for the page's fetch: { json } to answer, 'pass' to let the
//                                  request through (the page's own files, the basemap), null to refuse.
//                                  Whatever the host, a Beacon or release-list path is answered here.
//
// No DOM. Times follow `now`, so the charts always end at the present.
import { demoWorld, neighboursOf } from './world.js';

// Hosts are named without a scheme: this code reaches none of them (test/csp.test.js), it answers
// in their place. Beacon is known by its API paths, the release list by its path.
export const BASEMAP_HOST = 'tiles.openfreemap.org';
const BEACON_PATH = /^\/api\/v1(\/(nodes|observers)\b.*)$/;
const RELEASES_PATH = /\/releases\/?$/;
export const DEMO_IATA = 'JKG';

const wave = (i, h, base, amp) => Math.round(base + amp * Math.sin((h + i * 3) / 3.8));
const heardNodes = (world) => world.nodes.filter((n) => n.heard !== null);

function item(world, n) {
  return { id: n.beaconId, publicKey: n.key.toLowerCase(), nodeType: 2, nodeTypeName: 'repeater', name: n.name, isObserver: Boolean(n.observerId),
    observerId: n.observerId, lat: n.lat, lng: n.lng, knownNeighborCount: neighboursOf(world, n).length,
    neighborIds: neighboursOf(world, n).map((m) => m.beaconId), iatas: [DEMO_IATA] };
}

// A few repeaters that are not the visitor's, so the map is not theirs alone. Invented like the rest.
function others(world) {
  return Array.from({ length: 12 }, (_, i) => ({ id: `demo-other-${i}`, publicKey: `${(i + 1).toString(16).padStart(2, '0')}`.repeat(32), nodeType: 2,
    nodeTypeName: 'repeater', name: `DEMO-Annan-${i + 1}`, lat: 57.86 + ((i * 37) % 22) / 100, lng: 14.7 + ((i * 53) % 42) / 100,
    neighborIds: [], iatas: [DEMO_IATA] }));
}

export function demoBeacon(world, path, now = Date.now()) {
  const url = new URL(path, 'demo://beacon');
  const at = (hoursAgo) => now - hoursAgo * 3600000;
  const prefix = url.searchParams.get('pubkeyPrefix');
  if (url.pathname === '/nodes' && prefix) {
    const n = heardNodes(world).find((x) => x.key.toLowerCase().startsWith(prefix.toLowerCase()));
    if (n) return { items: [item(world, n)] };
    // someone else's Observer (lou-21): Beacon knows it by its adverts, as it knows any node
    const s = (world.strangers || []).find((x) => x.key.toLowerCase().startsWith(prefix.toLowerCase()));
    return { items: s ? [{ id: s.beaconId, publicKey: s.key.toLowerCase(), nodeType: 2, nodeTypeName: 'repeater', name: s.name, isObserver: true,
      observerId: null, lat: s.lat, lng: s.lng, knownNeighborCount: 0, neighborIds: [], iatas: [DEMO_IATA] }] : [] };
  }
  if (url.pathname === '/nodes') return { items: [...heardNodes(world).map((n) => item(world, n)), ...others(world)], hasMore: false };
  const nb = url.pathname.match(/^\/nodes\/demo-(\d+)\/neighbors$/);
  if (nb && world.nodes[Number(nb[1])]) {
    return neighboursOf(world, world.nodes[Number(nb[1])]).map((m) => ({ id: m.beaconId, name: m.name, publicKey: m.key.toLowerCase(), nodeType: 2,
      lat: m.lat, lng: m.lng, iata: DEMO_IATA, observationCount: 40 + m.i * 9, lastSeen: at(m.heard) }));
  }
  const obs = url.pathname.match(/^\/observers\/demo-obs-(\d+)(\/telemetry)?$/);
  const n = obs ? world.nodes[Number(obs[1])] : null;
  if (n?.observerId) {
    const mv = n.mv ?? 5010;   // mains: the USB rail
    if (obs[2]) {
      const hours = url.searchParams.get('range') === '168h' ? 168 : 24;
      const from = Math.floor(n.heard);   // an offline node's points stop when it did
      return { range: `${hours}h`, interval: '1h', points: Array.from({ length: Math.max(0, hours - from) }, (_, k) => {
        const h = hours - k;
        return { t: at(h), batteryMv: n.mv === null ? mv : mv - 40 + wave(n.i, h, 0, 60), airtimeTxSecs: 10000 + (hours - h) * (30 + n.i * 4),
          airtimeRxSecs: 20000 + (hours - h) * 70, noiseFloorDb: wave(n.i, h, -92, 4), uptimeSeconds: 2000000 + (hours - h) * 3600 };
      }) };
    }
    return { id: n.observerId, displayName: n.name, publicKey: n.key.toLowerCase(), firmwareVersion: n.fw, lastStatusAt: at(n.heard),
      statusMetadata: { stats: { battery_mv: mv, noise_floor: -91 + n.i, rx_air_secs: 28000, tx_air_secs: 13000 + n.i * 400,
        uptime_secs: 2400000 - n.i * 86400, mqtt_slots_up: 2, mqtt_slots_total: 2 } } };
  }
  return null;
}

// One release, the one the fleet's newest nodes run: nothing in the demo says "update available"
// except the node on older firmware.
export function demoReleases(now = Date.now()) {
  return [{ tag_name: 'v1.18.0-lou-20', name: 'v1.18.0-lou-20 (demo)', html_url: null, draft: false, prerelease: false,
    published_at: new Date(now - 9 * 86400000).toISOString() }];
}

let cached = null;
export function demoAnswer(url, { origin, now = Date.now(), world = (cached ||= demoWorld()) } = {}) {
  const u = String(url);
  if (/^(data|blob):/.test(u)) return 'pass';
  let abs;
  try { abs = new URL(u, origin); } catch { return null; }
  if (abs.origin === origin) return 'pass';
  if (abs.protocol !== 'https:') return null;
  if (abs.hostname === BASEMAP_HOST) return 'pass';
  const beacon = abs.pathname.match(BEACON_PATH);
  if (beacon) {
    const body = demoBeacon(world, beacon[1] + abs.search, now);
    return body === null ? { status: 404, json: { error: 'not found' } } : { status: 200, json: body };
  }
  if (abs.pathname.startsWith('/api/v1/')) return { status: 404, json: { error: 'not found' } };
  if (RELEASES_PATH.test(abs.pathname)) return { status: 200, json: demoReleases(now) };
  return null;
}
