// Possible mesh-only nodes from Beacon (W-24). A mesh-only board never uses MQTT, so the
// IATA-based discovery broadcast cannot reach it, and Beacon's IATA for a node is only where an
// observer heard it. So the search is by POSITION: Beacon's repeaters that are not observers
// (an observer has an uplink, so it is not mesh-only), placed inside the chosen county's outline
// (ui/tiles/se-lan.json, passed in as `geo`), not in the list and not removed with undo. They are
// candidates, not confirmed: only an answer to a signed `ver` over the mesh confirms one
// (jobs.checkMeshNode). No DOM, no network: the rows and the outline are parameters.

const placed = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0)
  && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

function inRing(lng, lat, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[j];
    if ((y1 > lat) !== (y2 > lat) && lng < ((x2 - x1) * (lat - y1)) / (y2 - y1) + x1) hit = !hit;
  }
  return hit;
}

// Is (lat, lng) inside the county with SCB code `scb`? Holes (a polygon's later rings) are out.
export function insideCounty(geo, scb, lat, lng) {
  const feature = (geo?.features || []).find((f) => f.properties?.scb === scb);
  const g = feature?.geometry;
  if (!g || !Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.some(([outer, ...holes]) => outer && inRing(lng, lat, outer) && !holes.some((h) => inRing(lng, lat, h)));
}

// Beacon rows -> [{ node, key, name, source: 'beacon', lastSeen }], newest first.
export function beaconCandidates(rows, { geo, scb, known = new Set(), ignored = new Set() }) {
  const out = [];
  const seen = new Set();
  for (const r of rows || []) {
    const key = String(r?.publicKey || '').toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(key)) continue;
    const node = key.slice(0, 8);
    const repeater = r.nodeType === 2 || r.nodeTypeName === 'repeater';
    if (!repeater || r.isObserver || !placed(r) || known.has(node) || ignored.has(node) || seen.has(node)) continue;
    if (!insideCounty(geo, scb, r.lat, r.lng)) continue;
    seen.add(node);
    out.push({ node, key, name: String(r.name || ''), source: 'beacon', lastSeen: Number(r.lastSeen) || null });
  }
  return out.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}
