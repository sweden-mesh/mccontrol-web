// Statistics for one node: #/stats/<node id> (the 8-hex control id or the whole public key).
// What the terminal's "mccontrol stats" shows: the latest status block with its age, and the
// airtime the node sent per hour over 24 hours or per 6 hours over 7 days. All of it from Beacon
// (lib/stats/beacon.js); nothing here sends to the mesh. Without an id it asks for one.
import { h } from '../dom.js';
import { ageParts } from '../../lib/stats/beacon.js';
import { batteryKnown } from '../../lib/jobs/overview.js';
import { volts } from './node-kit.js';
import { mountTrafficChart, useStatsStyles } from './stats-chart.js';

export const route = 'stats';
export const title = 'stats.title';

const ID = /^[0-9a-f]{8,64}$/i;

function askForNode({ t, navigate, signal }) {
  const input = h('input', { id: 'stats-node', name: 'node', autocomplete: 'off', spellcheck: 'false',
    autocapitalize: 'characters', required: true, pattern: '[0-9A-Fa-f]{8,64}', 'aria-describedby': 'stats-node-hint' });
  const form = h('form', { class: 'stats-ask', novalidate: true },
    h('label', { for: 'stats-node' }, t('stats.nodeLabel')),
    h('p', { class: 'hint', id: 'stats-node-hint' }, t('stats.nodeHint')),
    h('div', { class: 'stats-ask-row' }, input, h('button', { type: 'submit', class: 'button' }, t('stats.show'))),
    h('p', { class: 'stats-error', id: 'stats-node-error', hidden: true }, t('stats.badId')));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = input.value.trim();
    const bad = !ID.test(id);
    form.querySelector('#stats-node-error').hidden = !bad;
    input.setAttribute('aria-invalid', bad ? 'true' : 'false');
    if (bad) { input.setAttribute('aria-describedby', 'stats-node-hint stats-node-error'); input.focus(); return; }
    navigate(`#/stats/${id.toUpperCase()}`);
  }, { signal });
  return form;
}

function uptime(secs, t) {
  return t('stats.uptime', { d: Math.floor(secs / 86400), h: Math.floor((secs % 86400) / 3600) });
}

function statList(data, { t, lang }) {
  const n = new Intl.NumberFormat(lang);
  const v = new Intl.NumberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const block = data.stats;
  if (!block) return h('p', { class: 'stats-note muted' }, t('stats.noStatus'));
  const show = {
    battery_mv: (x) => (batteryKnown(x) ? `${v.format(x / 1000)} V` : volts(t, x)),
    uptime_secs: (x) => uptime(x, t),
    noise_floor: (x) => `${n.format(x)} dBm`,
  };
  const rows = Object.entries(show).concat(['packets_sent', 'packets_received', 'recv_errors'].map((k) => [k, (x) => n.format(x)]))
    .filter(([k]) => typeof block[k] === 'number')
    .map(([k, fmt]) => [t(`stats.field.${k}`), fmt(block[k])]);
  if (data.model) rows.push([t('stats.field.model'), data.model]);
  if (data.firmware) rows.push([t('stats.field.firmware'), data.firmware]);
  const [ageKey, ageN] = ageParts(data.ageSecs);
  return h('div', {},
    h('p', { class: 'stats-age' }, t('stats.sampled', { age: t(ageKey, { n: ageN }) })),
    h('dl', { class: 'stats-list' }, rows.map(([dt, dd]) => h('div', {}, h('dt', {}, dt), h('dd', {}, dd)))));
}

export function render(ctx) {
  const { t, args, signal } = ctx;
  useStatsStyles();
  const nodeId = (args[0] || '').trim();
  const section = h('section', { 'aria-labelledby': 'stats-title', class: 'stats-screen' },
    h('h1', { id: 'stats-title' }, t('stats.title')),
    h('p', { class: 'muted' }, t('stats.intro')));
  if (!ID.test(nodeId)) {
    section.append(askForNode(ctx));
    return section;
  }
  const name = h('p', { class: 'stats-node' }, h('code', {}, nodeId.toUpperCase()));
  const status = h('div', { class: 'stats-status' });
  const chart = h('div', { class: 'stats-slot' });
  const period = h('fieldset', { class: 'stats-period' }, h('legend', {}, t('stats.period')),
    ['24h', '7d'].map((p) => h('label', {},
      h('input', { type: 'radio', name: 'stats-period', value: p, checked: p === '24h' }), ' ', t(`stats.period.${p}`))));
  section.append(name, h('h2', {}, t('stats.statusTitle')), status, h('h2', {}, t('stats.trafficTitle')), period, chart,
    h('p', { class: 'hint stats-source' }, t('stats.source')));

  let run = null;
  const load = async (p) => {
    run?.abort();
    run = new AbortController();
    const both = AbortSignal.any([signal, run.signal]);
    const data = await mountTrafficChart(chart, nodeId, { ...ctx, signal: both }, { period: p });
    if (both.aborted) return;
    if (data) {
      name.replaceChildren(data.name, ' ', h('code', {}, nodeId.toUpperCase()));
      status.replaceChildren(statList(data, ctx));
    } else {
      status.replaceChildren();
    }
  };
  period.addEventListener('change', (e) => load(e.target.value), { signal });
  load('24h');
  return section;
}
