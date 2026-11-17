// What the board's tiles compute, as pure functions: no DOM, no I/O, so node --test runs them
// (test/tiles-data.test.js). The tiles pass in what they read from the stores and Beacon.
//
//   nodeStatus(device, opts)      { state, reasons }: the NODES row's glyph and second line
//   byAttention(rows, lang)       sort: refused/forged, then needs attention, unknown, ok; then name
//   matches(device, query)        the NODES search
//   isSeen(event, seen), markSeen(seen, ids), markAllSeen(events)   RESULTS: kept until seen
//   sparkPoints(values, w, h)     a sparkline's SVG points ('' when fewer than 2 known values)
//   hourly(points, key, now)      24 hourly values of a telemetry field (null where unknown)
//   frame(points, pad), fit(frame, aspect), project(frame, w), outlinePaths(geo, frame, proj)   the MAP
import { needsAttention, lastHeard } from '../../lib/jobs/overview.js';

export const STATES = Object.freeze(['alert', 'warn', 'unknown', 'ok']);
const ALERT_KINDS = new Set(['refused', 'forged']);

// The row's state: 'alert' for a refused or forged last answer, 'warn' for anything else the
// overview counts as needing attention (not heard, low battery, outdated firmware), 'ok' when the
// node was heard and nothing is wrong, 'unknown' when nothing is known yet. Absence of evidence
// is not a finding: a node never heard is unknown, not silent.
export function nodeStatus(device, { now, hours, thresholdMv, release = null, rules }) {
  const reasons = needsAttention([device], { now, hours, thresholdMv, release, rules });
  if (reasons.some((r) => ALERT_KINDS.has(r.kind))) return { state: 'alert', reasons };
  if (reasons.length) return { state: 'warn', reasons };
  return { state: lastHeard(device) === null && !device.lastResult ? 'unknown' : 'ok', reasons };
}

// rows: [{ device, status }]. A new array.
export function byAttention(rows, lang = 'sv') {
  const name = (d) => d.name || d.node;
  return [...rows].sort((a, b) => STATES.indexOf(a.status.state) - STATES.indexOf(b.status.state)
    || name(a.device).localeCompare(name(b.device), lang));
}

// What the owner's node names share at the start, up to and including a '-', '_' or ' ' (e.g.
// 'SE-JKG-' for SE-JKG-Ekbacken and SE-JKG-Torpa), so a narrow column can show the part that
// tells them apart. '' for fewer than two names or nothing shared.
export function sharedPrefix(names) {
  const list = names.filter(Boolean);
  if (list.length < 2) return '';
  let p = list[0];
  for (const n of list) while (!n.startsWith(p)) p = p.slice(0, -1);
  const cut = Math.max(p.lastIndexOf('-'), p.lastIndexOf('_'), p.lastIndexOf(' '));
  const prefix = p.slice(0, cut + 1);
  return list.every((n) => n.length > prefix.length) ? prefix : '';
}

export function matches(device, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return [device.name, device.node, device.region, device.ver, device.notes]
    .some((v) => String(v || '').toLowerCase().includes(q));
}

// RESULTS keeps a result until it is seen: opened, or "mark all seen". `seen` is the stored
// { upTo: ISO | null, ids: [id] }: everything at or before upTo, and each id opened since.
export const SEEN_IDS = 200;
export function isSeen(event, seen) {
  if (!seen) return false;
  return Boolean((seen.upTo && event.at <= seen.upTo) || seen.ids?.includes(event.id));
}
export function markSeen(seen, ids) {
  const now = [...new Set([...(seen?.ids || []), ...ids])].slice(-SEEN_IDS);
  return { upTo: seen?.upTo || null, ids: now };
}
export function markAllSeen(events) {
  const upTo = events.reduce((m, e) => (e.at > m ? e.at : m), '');
  return { upTo: upTo || null, ids: [] };
}

// "x,y x,y ..." for a polyline in a w × h box, nulls skipped (the line breaks over a gap: one
// string per run). A flat series sits in the middle.
export function sparkRuns(values, w, h, pad = 2) {
  const known = values.filter((v) => Number.isFinite(v));
  if (known.length < 2) return [];
  const lo = Math.min(...known);
  const hi = Math.max(...known);
  const x = (i) => pad + (i * (w - 2 * pad)) / Math.max(1, values.length - 1);
  const y = (v) => (hi === lo ? h / 2 : pad + ((hi - v) * (h - 2 * pad)) / (hi - lo));
  const runs = [];
  let run = [];
  values.forEach((v, i) => {
    if (Number.isFinite(v)) run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    else if (run.length) { runs.push(run); run = []; }
  });
  if (run.length) runs.push(run);
  return runs.filter((r) => r.length > 1).map((r) => r.join(' '));
}

const HOUR = 3600000;
// The last 24 hours of a telemetry field, one value per hour, oldest first (null: no sample).
// For a running total (airtimeTxSecs) pass diff: the hour's increase, null over a reboot or gap.
export function hourly(points, key, now, { diff = false } = {}) {
  const end = Math.floor(now / HOUR) * HOUR + HOUR;
  const start = end - 24 * HOUR;
  const slots = Array(24).fill(null);
  const sorted = (points || []).filter((p) => Number.isFinite(p?.t)).sort((a, b) => a.t - b.t);
  sorted.forEach((p, i) => {
    const slot = Math.floor((p.t - start) / HOUR);
    if (slot < 0 || slot >= 24) return;
    if (!diff) { if (Number.isFinite(p[key])) slots[slot] = p[key]; return; }
    const next = sorted[i + 1];
    if (!next || next.t - p.t > 1.5 * HOUR) return;
    const d = next[key] - p[key];
    if (Number.isFinite(d) && d >= 0) slots[slot] = d;
  });
  return slots;
}

export const known = (values) => values.filter((v) => Number.isFinite(v));

// -- the map -------------------------------------------------------------------------------------

const placed = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0)
  && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
export { placed };

// The area to draw: the points' bounds, padded by `pad` of their size and to at least `minKm`
// across, so one node still shows its surroundings. null without a placed point.
export function frame(points, { pad = 0.15, minKm = 30 } = {}) {
  const pts = points.filter(placed);
  if (!pts.length) return null;
  let s = Math.min(...pts.map((p) => p.lat)); let n = Math.max(...pts.map((p) => p.lat));
  let w = Math.min(...pts.map((p) => p.lng)); let e = Math.max(...pts.map((p) => p.lng));
  const lat0 = (s + n) / 2;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const minLat = minKm / 111;
  const minLng = minKm / (111 * k);
  if (n - s < minLat) { const c = (n + s) / 2; s = c - minLat / 2; n = c + minLat / 2; }
  if (e - w < minLng) { const c = (e + w) / 2; w = c - minLng / 2; e = c + minLng / 2; }
  const dl = (n - s) * pad; const dg = (e - w) * pad;
  return { s: s - dl, n: n + dl, w: w - dg, e: e + dg, k };
}

// The frame widened (in latitude or longitude) to a box `aspect` (width / height) wide, so the map
// fills its tile without stretching.
export function fit(f, aspect) {
  if (!(aspect > 0)) return f;
  const w = (f.e - f.w) * f.k;
  const hgt = f.n - f.s;
  if (w / hgt < aspect) { const extra = (hgt * aspect - w) / f.k / 2; return { ...f, w: f.w - extra, e: f.e + extra }; }
  const extra = (w / aspect - hgt) / 2;
  return { ...f, s: f.s - extra, n: f.n + extra };
}

// An equirectangular projection scaled by cos(latitude), `width` units wide: { x, y, height }.
export function project(f, width = 400) {
  const scale = width / ((f.e - f.w) * f.k);
  return {
    width,
    height: Math.round((f.n - f.s) * scale),
    x: (lng) => (lng - f.w) * f.k * scale,
    y: (lat) => (f.n - lat) * scale,
  };
}

// SVG path data for every county outline that touches the frame (outer rings; the frame's
// viewBox clips the rest).
export function outlinePaths(geo, f, proj) {
  const out = [];
  for (const feature of geo?.features || []) {
    const g = feature.geometry;
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    const parts = [];
    for (const poly of polys) {
      const ring = poly[0] || [];
      const touches = ring.some(([lng, lat]) => lat >= f.s - 0.5 && lat <= f.n + 0.5 && lng >= f.w - 1 && lng <= f.e + 1);
      if (!touches || ring.length < 3) continue;
      parts.push(`M${ring.map(([lng, lat]) => `${proj.x(lng).toFixed(1)},${proj.y(lat).toFixed(1)}`).join('L')}Z`);
    }
    if (parts.length) out.push({ id: feature.properties?.scb || '', name: feature.properties?.name || '', d: parts.join('') });
  }
  return out;
}

// The lakes and the coast (se-water.json, W-23c) inside the frame `f` as two path strings:
// { lakes, coast }, '' where none is near. Lakes are closed rings, the coast open lines.
export function waterPaths(geo, f, proj) {
  const near = ([lng, lat]) => lat >= f.s - 0.5 && lat <= f.n + 0.5 && lng >= f.w - 1 && lng <= f.e + 1;
  const pt = ([lng, lat]) => `${proj.x(lng).toFixed(1)},${proj.y(lat).toFixed(1)}`;
  const out = { lakes: '', coast: '' };
  for (const feature of geo?.features || []) {
    const g = feature.geometry;
    const kind = feature.properties?.kind;
    if (kind === 'lake' && g?.type === 'MultiPolygon') {
      out.lakes += g.coordinates.map((poly) => poly[0] || []).filter((r) => r.length > 2 && r.some(near))
        .map((r) => `M${r.map(pt).join('L')}Z`).join('');
    } else if (kind === 'coast' && g?.type === 'MultiLineString') {
      out.coast += g.coordinates.filter((l) => l.length > 1 && l.some(near)).map((l) => `M${l.map(pt).join('L')}`).join('');
    }
  }
  return out;
}

// Beacon's /nodes rows against the owner's devices: { mine: [{ device, node }], others: [node],
// links: [[a, b]] } where a node is { id, name, lat, lng, neighborIds }. A device is matched by
// the start of its key; links are the owner's nodes' neighbours that have a position.
export function mapModel(devices, rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const mine = [];
  const mineIds = new Set();
  for (const d of devices) {
    const prefix = String(d.key || d.node).toLowerCase();
    const row = rows.find((r) => String(r.publicKey || '').toLowerCase().startsWith(prefix.slice(0, Math.max(8, prefix.length))));
    mine.push({ device: d, node: row && placed(row) ? row : null, neighbours: row?.neighborIds?.length ?? row?.knownNeighborCount ?? null });
    if (row) mineIds.add(row.id);
  }
  const others = rows.filter((r) => !mineIds.has(r.id) && placed(r) && r.nodeTypeName !== 'companion' && r.nodeType !== 1);
  const links = [];
  const seen = new Set();
  for (const m of mine) {
    if (!m.node) continue;
    for (const nid of m.node.neighborIds || []) {
      const other = byId.get(nid);
      const key = [m.node.id, nid].sort().join('|');
      if (!placed(other) || seen.has(key)) continue;
      seen.add(key);
      links.push([m.node, other]);
    }
  }
  return { mine, others, links };
}
