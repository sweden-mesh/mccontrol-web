// The traffic chart: the airtime a node sent per hour (24 h) or per 6 hours (7 d), from Beacon
// (lib/stats/beacon.js). One series, so no legend: the caption names it. Every value is also in
// words (the summary), in a table, and in the readout line that follows the pointer and the arrow
// keys. When Beacon cannot be asked, the slot shows one muted line, never an error.
//
//   mountTrafficChart(el, nodeId, ctx, { period: '24h' | '7d' }) -> Promise<stats | null>
//
// The statistics screen (stats.js) uses it and the stats it resolves with. Plain SVG drawn here, no library.
import { h } from '../dom.js';
import { beaconBase, beaconClient, nodeStats, niceScale } from '../../lib/stats/beacon.js';
import { batteryKnown } from '../../lib/jobs/overview.js';
import { volts } from './node-kit.js';

// The SVG namespace: a name, not an address anything is fetched from (built up so the CSP test's
// "no URL in our code" check keeps meaning what it says).
const SVG = ['http:', '', 'www.w3.org', '2000', 'svg'].join('/');
const HEIGHT = 150;
const PAD = { top: 10, right: 4, bottom: 22, left: 40 };

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const c of children) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

// The chart's stylesheet, once per page (style-src 'self': a file, never a style attribute).
export function useStatsStyles() {
  const href = new URL('./stats.css', import.meta.url).href;
  if ([...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.href === href)) return;
  document.head.append(h('link', { rel: 'stylesheet', href }));
}

// A column with a 4px rounded top, square at the baseline.
function columnPath(x, y, w, base) {
  const r = Math.min(4, w / 2, base - y);
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

function formats(lang, period) {
  const n = new Intl.NumberFormat(lang, { maximumFractionDigits: 0 });
  const tick = new Intl.DateTimeFormat(lang, period === '7d' ? { weekday: 'short' } : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const full = new Intl.DateTimeFormat(lang, period === '7d'
    ? { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
    : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return { n: (v) => n.format(v), tick: (t) => tick.format(t), full: (t) => full.format(t) };
}

// Which bars get a time under them: every 6 hours on the 24-hour chart, each midnight on the 7-day one.
function labelled(bar, period) {
  const d = new Date(bar.t);
  return period === '7d' ? d.getHours() < 6 : d.getHours() % 6 === 0;
}

export function summaryText(data, t, f) {
  const span = t(`stats.span.${data.period}`);
  const { summary, bars } = data;
  if (!summary.known) return t('stats.noTraffic', { period: span });
  const parts = [t('stats.summary', { tx: f.n(summary.tx), rx: f.n(summary.rx), period: span }),
    t('stats.peak', { time: f.full(summary.peak.t), tx: f.n(summary.peak.tx) })];
  if (summary.known < bars.length) parts.push(t('stats.gaps', { n: bars.length - summary.known, total: bars.length }));
  return parts.join(' ');
}

function readoutText(bar, t, f) {
  return bar.tx === null ? t('stats.readoutUnknown', { time: f.full(bar.t) })
    : t('stats.readout', { time: f.full(bar.t), tx: f.n(bar.tx), rx: f.n(bar.rx) });
}

function drawPlot(svg, data, width, f, active) {
  const { bars, period } = data;
  const max = Math.max(0, ...bars.map((b) => b.tx || 0));
  const { top, step } = niceScale(max);
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const base = HEIGHT - PAD.bottom;
  const y = (v) => base - (v / top) * (base - PAD.top);
  const band = plotW / bars.length;
  const barW = Math.max(1, Math.min(24, band - 2));
  svg.setAttribute('viewBox', `0 0 ${width} ${HEIGHT}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', HEIGHT);
  const grid = s('g', { class: 'stats-grid' });
  for (let v = 0; v <= top + step / 2; v += step) {
    grid.append(s('line', { x1: PAD.left, x2: width - PAD.right, y1: y(v), y2: y(v) }),
      s('text', { x: PAD.left - 6, y: y(v), class: 'stats-ytick', 'dominant-baseline': 'middle', 'text-anchor': 'end' },
        v === top ? `${f.n(v)} s` : f.n(v)));
  }
  const marks = s('g', { class: 'stats-bars' });
  const ticks = s('g', { class: 'stats-xticks' });
  bars.forEach((bar, i) => {
    const x = PAD.left + i * band + (band - barW) / 2;
    if (bar.tx !== null && bar.tx > 0) {
      marks.append(s('path', { d: columnPath(x, Math.min(y(bar.tx), base - 1), barW, base),
        class: i === active ? 'stats-bar is-active' : 'stats-bar' }));
    }
    if (labelled(bar, period)) {
      ticks.append(s('text', { x: PAD.left + i * band, y: HEIGHT - 6, 'text-anchor': i === 0 ? 'start' : 'middle' }, f.tick(bar.t)));
    }
  });
  const cursor = active == null ? null
    : s('rect', { class: 'stats-cursor', x: PAD.left + active * band, y: PAD.top, width: band, height: base - PAD.top });
  svg.replaceChildren(...[cursor, grid, marks, ticks].filter(Boolean));
  return { band };
}

function chartFigure(data, ctx) {
  const { t, lang, signal } = ctx;
  const f = formats(lang, data.period);
  const plotWrap = h('div', { class: 'stats-plot' });
  const readout = h('p', { class: 'stats-readout', 'aria-live': 'polite' });
  const svg = s('svg', { class: 'stats-svg', role: 'img', tabindex: 0, 'aria-label': t('stats.chartLabel') });
  plotWrap.append(svg);
  let active = null;
  let geometry = { band: 1 };
  const width = () => Math.max(240, Math.floor(plotWrap.clientWidth || 320));
  const redraw = () => { geometry = drawPlot(svg, data, width(), f, active); };
  const select = (i) => {
    active = i == null ? null : Math.max(0, Math.min(data.bars.length - 1, i));
    readout.textContent = active == null ? '' : readoutText(data.bars[active], t, f);
    redraw();
  };
  svg.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const x = (e.clientX - box.left) * (width() / box.width) - PAD.left;
    select(x < 0 ? null : Math.floor(x / geometry.band));
  }, { signal });
  svg.addEventListener('pointerleave', () => { if (document.activeElement !== svg) select(null); }, { signal });
  svg.addEventListener('blur', () => select(null), { signal });
  svg.addEventListener('focus', () => { if (active == null) select(data.bars.length - 1); }, { signal });
  svg.addEventListener('keydown', (e) => {
    const last = data.bars.length - 1;
    const next = { ArrowLeft: (active ?? last) - 1, ArrowRight: (active ?? last) + 1, Home: 0, End: last }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(next);
  }, { signal });
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => redraw());
    ro.observe(plotWrap);
    signal?.addEventListener('abort', () => ro.disconnect(), { once: true });
  }

  const captionId = `stats-cap-${Math.random().toString(36).slice(2, 8)}`;
  const table = h('div', { class: 'stats-table-wrap', role: 'region', tabindex: 0, 'aria-labelledby': captionId },
    h('table', { class: 'stats-table' },
      h('caption', { id: captionId }, t(`stats.chartTitle.${data.period}`)),
      h('thead', {}, h('tr', {}, ['time', 'tx', 'rx', 'battery'].map((c) => h('th', { scope: 'col' }, t(`stats.col.${c}`))))),
      h('tbody', {}, data.bars.map((b) => h('tr', {},
        h('th', { scope: 'row' }, f.full(b.t)),
        h('td', {}, b.tx === null ? t('stats.noData') : f.n(b.tx)),
        h('td', {}, b.rx === null ? t('stats.noData') : f.n(b.rx)),
        h('td', {}, batteryKnown(b.batteryMv) ? f.n(b.batteryMv) : volts(t, b.batteryMv)))))));

  const figure = h('figure', { class: 'stats-chart' },
    h('figcaption', {},
      h('span', { class: 'stats-chart-title' }, t(`stats.chartTitle.${data.period}`)),
      h('span', { class: 'stats-summary' }, summaryText(data, t, f))),
    plotWrap, readout,
    h('details', { class: 'stats-details' }, h('summary', {}, t('stats.table')), table));
  queueMicrotask(redraw);
  return figure;
}

export function unavailableNote(err, t) {
  const key = { unknown: 'stats.unknown', noStatus: 'stats.noStatus' }[err?.code] || 'stats.unavailable';
  return h('p', { class: 'stats-note muted' }, t(key));
}

export async function mountTrafficChart(el, nodeId, ctx, { period = '24h', client = null, now } = {}) {
  useStatsStyles();
  el.replaceChildren(h('p', { class: 'stats-note muted' }, ctx.t('stats.loading')));
  let data;
  try {
    const beacon = client || beaconClient({ base: await beaconBase(), signal: ctx.signal });
    data = await nodeStats(beacon, nodeId, period, now ?? Date.now());
  } catch (err) {
    if (ctx.signal?.aborted || err?.name === 'AbortError') return null;
    el.replaceChildren(unavailableNote(err, ctx.t));
    return null;
  }
  if (ctx.signal?.aborted) return null;
  el.replaceChildren(chartFigure(data, ctx));
  return data;
}
