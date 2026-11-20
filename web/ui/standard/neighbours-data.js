// The Neighbours dialog's data (W-29f), no DOM. Two sources, joined on the key prefix:
//   the node's own `neighbors` reply: one line per neighbour it heard directly (zero hops),
//     "<8 hex of its key>:<seconds since>:<SNR x 4>" newest first, or "-none-"
//     (simple_repeater MyMesh::formatNeighborsReply); each stored reply adds to the average SNR
//   Beacon's /nodes/<id>/neighbors: name, key, position and when observers last saw the link
// RSSI is in neither: the dialog says so instead of inventing one.

import { parseNeighbors } from '../../lib/jobs/relay.js';

export { parseNeighbors };

// Great-circle distance in km, or null without both positions.
export function distanceKm(a, b) {
  const ok = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0);
  if (!ok(a) || !ok(b)) return null;
  const r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2
    + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(x)));
}

// events: the node's history (newest first); beaconRows: Beacon's neighbours; devices: the
// owner's; self: { lat, lng } of the node. -> [{ prefix, key, name, snrLast, snrAvg, samples,
// heardAt (ms), direct, beaconSeen (ms), km, own (device | null) }], heard most recently first.
export function neighbourRows({ events = [], beaconRows = [], devices = [], self = null }) {
  const replies = events.filter((e) => e.command === 'neighbors' && e.code === 0 && e.reply).slice(0, 20);
  const byPrefix = new Map();
  const row = (prefix) => {
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, { prefix, key: null, name: null, snrLast: null, snrs: [], heardAt: null, direct: false, beaconSeen: null, pos: null });
    return byPrefix.get(prefix);
  };
  replies.forEach((e, i) => {
    const at = Date.parse(e.at);
    for (const n of parseNeighbors(e.reply)) {
      const r = row(n.prefix);
      r.snrs.push(n.snr);
      if (i === 0) { r.snrLast = n.snr; r.direct = true; r.heardAt = Number.isFinite(at) ? at - n.secsAgo * 1000 : null; }
    }
  });
  for (const b of beaconRows) {
    const key = String(b.publicKey || '').toUpperCase();
    if (key.length < 8) continue;
    const r = row(key.slice(0, 8));
    r.key = key;
    r.name = b.name || null;
    r.beaconSeen = Number(b.lastSeen) || null;
    r.pos = { lat: b.lat, lng: b.lng };
  }
  return [...byPrefix.values()].map((r) => {
    const own = devices.find((d) => String(d.key || d.node).toUpperCase().startsWith(r.prefix)) || null;
    const avg = r.snrs.length ? r.snrs.reduce((s, x) => s + x, 0) / r.snrs.length : null;
    return {
      prefix: r.prefix, key: r.key, name: r.name || own?.name || null,
      snrLast: r.snrLast, snrAvg: avg, samples: r.snrs.length,
      heardAt: r.heardAt, direct: r.direct, beaconSeen: r.beaconSeen,
      km: distanceKm(self, r.pos), own,
    };
  }).sort((a, b) => Math.max(b.heardAt || 0, b.beaconSeen || 0) - Math.max(a.heardAt || 0, a.beaconSeen || 0));
}
