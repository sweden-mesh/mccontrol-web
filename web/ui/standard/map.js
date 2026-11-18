// The standard layout's map (W-29d): OpenStreetMap through the same basemap the regional sites use
// (meshcore-regional-template, hugo.toml [params.map]: MapLibre 6.16.0 on OpenFreeMap's "liberty"
// and "dark" styles; the template has no tile proxy of its own), so the CSP names one more origin,
// basemap.json's `origin`, in connect-src and nothing else. The URLs live in basemap.json, as
// Beacon's do in lib/stats/beacon.json. MapLibre is vendored (vendor/maplibre-gl/, the
// template's three files byte for byte) and loaded only when a map is first drawn.
//
// Trusted Types: MapLibre starts its worker with `new Worker(url)`, a script-URL sink. The policy
// "mccontrol-map" (named in the CSP's trusted-types) accepts the vendored worker's URL and nothing
// else, and is made here on the first map, never at module load (README "The Content Security
// Policy"). No MapLibre control is added (their icons are data: URLs, which img-src refuses); the
// attribution is the page's own line under the map, and the markers are our own elements.
//
//   mapView(ctx, { mine, others, links, selected, onPick, frame })   -> element; removed with ctx.signal
//       mine     [{ node, name, lat, lng, state }]   the owner's nodes (state: ok | warn | alert | unknown)
//       others   [{ lat, lng, name }]                the area's other repeaters, small and dim
//       links    [[{lat,lng}, {lat,lng}]]            neighbour links
//       frame    [{lat,lng}]                         what the view must show (default: mine)
import { h } from '../dom.js';
import { s } from '../tiles/kit.js';

let basemap = null;
export const loadBasemap = () => {
  basemap ||= fetch(new URL('./basemap.json', import.meta.url)).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`basemap.json: ${r.status}`))));
  basemap.catch(() => { basemap = null; });
  return basemap;
};
const BASE = new URL('../../vendor/maplibre-gl/', import.meta.url);

let loading = null;
let policy = null;

// The worker's URL as a TrustedScriptURL that MapLibre can still read as a string (it checks the
// ending and the origin before it makes the Worker, which then gets the trusted value itself).
function workerUrl() {
  const url = new URL('maplibre-gl-worker.mjs', BASE).href;
  if (!globalThis.trustedTypes?.createPolicy) return url;
  policy ||= trustedTypes.createPolicy('mccontrol-map', {
    createScriptURL: (u) => { if (u !== url) throw new TypeError(`mccontrol-map: not the map worker: ${u}`); return u; },
  });
  const trusted = policy.createScriptURL(url);
  for (const name of ['endsWith', 'startsWith', 'split', 'includes']) {
    Object.defineProperty(trusted, name, { value: (...args) => url[name](...args) });
  }
  return trusted;
}

export function loadMapLibre() {
  loading ||= (async () => {
    if (!document.querySelector('link[data-maplibre]')) {
      const link = h('link', { rel: 'stylesheet', href: new URL('maplibre-gl.css', BASE).href, 'data-maplibre': '' });
      const ready = new Promise((ok) => { link.addEventListener('load', ok, { once: true }); link.addEventListener('error', ok, { once: true }); });
      document.head.append(link);
      await ready;
    }
    const ml = await import(new URL('maplibre-gl.mjs', BASE).href);
    ml.setWorkerUrl(workerUrl());
    return ml;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

// The same shapes as the NODES glyphs and the retro map: ● ok, ▲ needs attention, ✕ refused,
// ○ not known; never colour alone.
function markerEl(ctx, m, selected, onPick) {
  const r = 6;
  const c = 9;
  const shape = m.state === 'warn' ? s('path', { d: `M${c},${c - r - 1}L${c + r + 1},${c + r}L${c - r - 1},${c + r}Z` })
    : m.state === 'alert' ? s('path', { class: 'x', d: `M${c - r},${c - r}L${c + r},${c + r}M${c + r},${c - r}L${c - r},${c + r}` })
      : s('circle', { cx: c, cy: c, r, class: m.state === 'unknown' ? 'hollow' : '' });
  const words = `${m.name}, ${ctx.t(`tile.state.${m.state}`)}`;
  const el = h('button', { type: 'button', class: `std-marker${selected ? ' is-selected' : ''}`, 'data-state': m.state, 'data-node': m.node, title: words, 'aria-label': words },
    s('svg', { viewBox: '0 0 18 18', width: 18, height: 18, 'aria-hidden': 'true', focusable: 'false' }, shape));
  if (onPick) el.addEventListener('click', (e) => { e.stopPropagation(); onPick(m.node); });
  return el;
}

const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';

export function mapView(ctx, { mine = [], others = [], links = [], selected = null, onPick = null, frame = null, label }) {
  const box = h('div', { class: 'std-map', role: 'region', 'aria-label': label });
  const credit = h('p', { class: 'std-map-credit' });
  const wrap = h('div', { class: 'std-map-wrap' }, box, credit);
  const points = (frame || mine).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!points.length) {
    box.replaceChildren(h('p', { class: 'muted std-map-empty' }, ctx.t('tile.mapNoPositions')));
    return wrap;
  }
  let map = null;
  ctx.signal.addEventListener('abort', () => { map?.remove(); map = null; }, { once: true });
  const dark = document.documentElement.dataset.scheme !== 'light';
  Promise.all([loadMapLibre(), loadBasemap()]).then(([ml, base]) => {
    if (ctx.signal.aborted) return;
    credit.replaceChildren(...base.credits.map((c) => h('a', { href: c.href, target: '_blank', rel: 'noopener noreferrer' }, c.text === 'osm' ? ctx.t('std.osm') : c.text)));
    const lngs = points.map((p) => p.lng); const lats = points.map((p) => p.lat);
    // At least about 2 km across, as the retro map (W-26a): one node still shows its streets.
    const pad = 0.01;
    const bounds = [[Math.min(...lngs) - pad, Math.min(...lats) - pad], [Math.max(...lngs) + pad, Math.max(...lats) + pad]];
    map = new ml.Map({
      container: box, style: base.styles[dark ? 'dark' : 'light'], bounds,
      fitBoundsOptions: { padding: 32, maxZoom: 15 }, attributionControl: false,
      dragRotate: false, pitchWithRotate: false, touchPitch: false,
    });
    map.touchZoomRotate.disableRotation();
    map.on('load', () => {
      const line = (a, b) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[a.lng, a.lat], [b.lng, b.lat]] } });
      map.addSource('links', { type: 'geojson', data: { type: 'FeatureCollection', features: links.map(([a, b]) => line(a, b)) } });
      map.addLayer({ id: 'links', type: 'line', source: 'links', paint: { 'line-color': token('--muted'), 'line-width': 1.5, 'line-opacity': 0.8 } });
      map.addSource('others', { type: 'geojson', data: { type: 'FeatureCollection',
        features: others.filter((o) => Number.isFinite(o.lat)).map((o) => ({ type: 'Feature', properties: { name: o.name || '' }, geometry: { type: 'Point', coordinates: [o.lng, o.lat] } })) } });
      map.addLayer({ id: 'others', type: 'circle', source: 'others', paint: { 'circle-radius': 3, 'circle-color': token('--muted'), 'circle-opacity': 0.7 } });
    });
    for (const m of mine) {
      if (!Number.isFinite(m.lat) || !Number.isFinite(m.lng)) continue;
      new ml.Marker({ element: markerEl(ctx, m, m.node === selected, onPick) }).setLngLat([m.lng, m.lat]).addTo(map);
    }
  }).catch((e) => {
    if (!ctx.signal.aborted) box.replaceChildren(h('p', { class: 'muted std-map-empty' }, ctx.t('std.mapFailed', { reason: e.message })));
  });
  return wrap;
}
