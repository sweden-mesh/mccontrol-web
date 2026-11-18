// MAP (W-20c, operator decision 4): the owner's nodes as marks on a plain outline of the counties
// around them, the selected node ringed, its neighbour links from Beacon as faint lines, other
// repeaters of the area as small dim dots. Drawn here as SVG: no map tiles, no map library, no new
// origin. The outlines are the regional template's se-lan.geojson (Natural Earth 10m admin-1,
// public domain, simplified to ~1 km), copied as se-lan.json; positions and neighbours are Beacon's
// /nodes?iatas=<region>&neighbors=true (the origin the CSP already names), read once per region and
// kept 15 minutes. The map frames the owner's own nodes, not the region (W-25c), at least 2 km
// across (W-26a); the region frames it only when none of them has a position.
//
// A mark's shape is its status, the same as the NODES glyph (● ok, ▲ needs attention, ✕ refused,
// ○ not known), so nothing rests on colour. A click or Enter on a mark selects the node; its name
// and state are the mark's tooltip and accessible name. "As a list" under the map is the text
// alternative: every node, its state, its neighbours, or that Beacon has no position for it.
// Under the outlines, faintly, the lakes and the coast (se-water.json: Natural Earth 1:10m lakes
// and coastline, public domain, clipped to Sweden and simplified; scripts/water-outline.py), so
// the land reads as land (W-23c). Same origin, so the CSP is unchanged.
import { h } from '../dom.js';
import { lowBatteryVolts, notHeardHours } from '../screens/settings-store.js';
import { beaconBase } from '../../lib/stats/beacon.js';
import { nameOf } from '../screens/node-kit.js';
import { forKey, s, stateMark } from './kit.js';
import { fit, mapFrame, mapModel, nodeStatus, outlinePaths, project, sharedPrefix, waterPaths } from './data.js';
import { onDataChanged } from './sources.js';

export const id = 'map';
export const title = 'tile.map';

const MAX_AGE = 15 * 60000;
let outline = null;
let water = null;
const areas = new Map();   // region -> { at, promise of rows }

const loadOutline = () => {
  if (!outline) outline = fetch(new URL('./se-lan.json', import.meta.url)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return outline;
};

const loadWater = () => {
  if (!water) water = fetch(new URL('./se-water.json', import.meta.url)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return water;
};

async function areaNodes(region, now = Date.now()) {
  const hit = areas.get(region);
  if (hit && now - hit.at < MAX_AGE) return hit.promise;
  const promise = (async () => {
    const base = await beaconBase();
    const res = await fetch(`${base}/nodes?iatas=${encodeURIComponent(region)}&neighbors=true&limit=1000`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Beacon answered ${res.status}`);
    const data = await res.json();
    return Array.isArray(data?.items) ? data.items : [];
  })();
  areas.set(region, { at: now, promise });
  promise.catch(() => areas.delete(region));
  return promise;
}

export function render(ctx) {
  const body = h('div', { class: 'tile-fill map-tile' });
  forKey(ctx, body, (svc) => fill(ctx, svc, body));
  return body;
}

// The mark for a state, centred on (x, y).
function mark(state, x, y) {
  const r = 5;
  if (state === 'warn') return s('path', { class: 'mark-shape', d: `M${x},${y - r - 1}L${x + r + 1},${y + r}L${x - r - 1},${y + r}Z` });
  if (state === 'alert') return s('path', { class: 'mark-shape mark-x', d: `M${x - r},${y - r}L${x + r},${y + r}M${x + r},${y - r}L${x - r},${y + r}` });
  return s('circle', { class: `mark-shape${state === 'unknown' ? ' mark-hollow' : ''}`, cx: x, cy: y, r });
}

function fill(ctx, svc, body) {
  const figure = h('div', { class: 'map-figure' });
  const caption = h('p', { class: 'row muted map-caption', id: 'map-caption' });
  const listBox = h('ul', { class: 'rows map-list' });
  const details = h('details', { class: 'map-alt' }, h('summary', {}, ctx.t('tile.mapList')), listBox);
  body.replaceChildren(figure, caption, details);

  // A later draw wins (W-26a): one started before discovery added the nodes may finish after the
  // one started after it (Beacon answers in any order), and must not paint over it.
  let turn = 0;
  async function draw() {
    const mine = turn += 1;
    const stale = () => ctx.signal.aborted || mine !== turn;
    const devices = await svc.stores.devices.list();
    if (stale()) return;
    if (!devices.length) {
      figure.replaceChildren();
      caption.textContent = ctx.t('tile.mapEmpty');
      details.hidden = true;
      ctx.tile.setTitle('');
      return;
    }
    details.hidden = false;
    const regions = [...new Set(devices.map((d) => d.region))].sort();
    ctx.tile.setTitle(regions.join(' '));
    const now = Date.now();
    const opts = { now, hours: notHeardHours(), thresholdMv: lowBatteryVolts() * 1000, rules: svc.rules };
    const status = new Map(devices.map((d) => [d.node, nodeStatus(d, opts).state]));
    let rows = [];
    let failed = false;
    for (const r of regions) {
      try { rows = rows.concat(await areaNodes(r)); } catch { failed = true; }
    }
    const [geo, wet] = await Promise.all([loadOutline(), loadWater()]);
    if (stale()) return;
    const model = mapModel(devices, rows);
    const selected = ctx.board.selected();
    const placedMine = model.mine.filter((m) => m.node);
    const f = mapFrame(model);
    listBox.replaceChildren(...model.mine.map((m) => h('li', { class: 'row' },
      stateMark(ctx, status.get(m.device.node)), ' ', h('span', { class: 'node-name' }, nameOf(m.device)), ' ',
      h('span', { class: 'muted' }, m.node
        ? [ctx.t('tile.at', { lat: m.node.lat.toFixed(3), lng: m.node.lng.toFixed(3) }),
          m.neighbours !== null ? ` · ${ctx.t('tile.neighbours', { n: m.neighbours })}` : ''].join('')
        : ctx.t('tile.noPosition')))));
    if (!f) {
      figure.replaceChildren();
      caption.textContent = failed ? ctx.t('tile.mapBeaconFailed') : ctx.t('tile.mapNoPositions');
      return;
    }
    // Drawn at the figure's own size in pixels, so labels and marks keep their size.
    const box = figure.getBoundingClientRect();
    const width = Math.max(200, Math.round(box.width));
    const height = Math.max(160, Math.round(figure.classList.contains('fills') && box.height > 80 ? box.height : width * 0.7));
    const proj = project(fit(f, width / height), width);
    const P = (n) => [Number(proj.x(n.lng).toFixed(1)), Number(proj.y(n.lat).toFixed(1))];
    const outlines = geo ? outlinePaths(geo, f, proj) : [];
    const sea = wet ? waterPaths(wet, f, proj) : { lakes: '', coast: '' };
    const own = new Set(model.links.map(([a]) => a.id));
    const sel = placedMine.find((m) => m.device.node === selected);
    const label = placedMine.length <= 8;
    // Labels: the part of the name that tells the nodes apart, and none that would sit on top of
    // one already drawn (the selected node's first); the list below has every name whole.
    const prefix = sharedPrefix(placedMine.map((m) => nameOf(m.device)));
    const short = (m) => { const n = nameOf(m.device); return n.startsWith(prefix) ? n.slice(prefix.length) : n; };
    const taken = [];
    const fits = (x, y, text) => {
      const box = [x + 9, y - 8, x + 9 + text.length * 7, y + 6];
      if (taken.some((b) => box[0] < b[2] && b[0] < box[2] && box[1] < b[3] && b[1] < box[3])) return false;
      taken.push(box);
      return true;
    };
    const order = [...placedMine].sort((a, b) => (b.device.node === selected) - (a.device.node === selected));
    const labelled = new Set(order.filter((m) => (label || m.device.node === selected) && fits(...P(m.node), short(m))).map((m) => m.device.node));
    const svg = s('svg', { class: 'map-svg', viewBox: `0 0 ${width} ${proj.height}`, width, height: proj.height, role: 'group', 'aria-labelledby': 'map-caption', preserveAspectRatio: 'xMidYMid meet' },
      s('g', { class: 'map-water', 'aria-hidden': 'true' },
        sea.coast ? s('path', { class: 'map-coast', d: sea.coast }) : null,
        sea.lakes ? s('path', { class: 'map-lakes', d: sea.lakes }) : null),
      s('g', { class: 'map-outline', 'aria-hidden': 'true' }, outlines.map((o) => s('path', { d: o.d }))),
      s('g', { class: 'map-links', 'aria-hidden': 'true' }, model.links.map(([a, b]) => {
        const [x1, y1] = P(a); const [x2, y2] = P(b);
        return s('line', { x1, y1, x2, y2, class: sel && sel.node.id === a.id ? 'link-own' : '' });
      })),
      s('g', { class: 'map-others', 'aria-hidden': 'true' }, model.others.filter((o) => !own.has(o.id)).map((o) => {
        const [x, y] = P(o);
        return s('circle', { cx: x, cy: y, r: 1.6 }, s('title', {}, o.name || ''));
      })),
      s('g', { class: 'map-mine' }, placedMine.map((m) => {
        const [x, y] = P(m.node);
        const st = status.get(m.device.node);
        const name = nameOf(m.device);
        const words = `${name}, ${ctx.t(`tile.state.${st}`)}`;
        const g = s('g', { class: `map-node${m.device.node === selected ? ' is-selected' : ''}`, tabindex: '0', role: 'button', 'aria-label': words, 'data-node': m.device.node },
          s('title', {}, words),
          s('circle', { class: 'hit', cx: x, cy: y, r: 12 }),
          m.device.node === selected ? s('circle', { class: 'ring', cx: x, cy: y, r: 9 }) : null,
          mark(st, x, y),
          labelled.has(m.device.node) ? s('text', { x: x + 9, y: y + 4, class: 'map-label' }, short(m)) : null);
        const pick = () => ctx.board.select(m.device.node);
        g.addEventListener('click', pick);
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
        return g;
      })));
    figure.replaceChildren(svg);
    caption.textContent = ctx.t('tile.mapCaption', { placed: placedMine.length, n: devices.length, others: model.others.length, links: model.links.length });
  }

  const redraw = () => draw().catch((e) => { caption.textContent = e.message; });
  // From 1100 px the figure takes the tile's height (tiles.css); redraw when its size changes.
  let size = '';
  const watch = new ResizeObserver(() => {
    figure.classList.toggle('fills', matchMedia('(width >= 68.75em)').matches);
    const r = figure.getBoundingClientRect();
    const next = `${Math.round(r.width / 8)}x${figure.classList.contains('fills') ? Math.round(r.height / 8) : 0}`;
    if (next !== size) { size = next; redraw(); }
  });
  watch.observe(figure);
  ctx.signal.addEventListener('abort', () => watch.disconnect(), { once: true });
  ctx.board.on((st) => { if (st.what === 'selected') redraw(); });
  ctx.signal.addEventListener('abort', onDataChanged((what) => { if (what !== 'history' && what !== 'seen') redraw(); }), { once: true });
}
