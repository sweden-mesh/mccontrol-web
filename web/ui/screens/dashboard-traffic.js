// The overview's traffic block: one node's airtime over the last 24 hours, from Beacon, through
// the statistics' own chart (mountTrafficChart). One chart at a time, the node picked from a list,
// so opening the overview costs three Beacon reads, not three per node. index.js hands it to the
// dashboard with provideTrafficBlock(trafficBlock).
import { h } from '../dom.js';
import { mountTrafficChart } from './stats-chart.js';

const nameOf = (d) => d.name || d.node;

export function trafficBlock(ctx, { devices }) {
  if (!devices.length) return null;
  const list = [...devices].sort((a, b) => nameOf(a).localeCompare(nameOf(b), ctx.lang));
  const select = h('select', { id: 'dash-traffic-node' },
    list.map((d) => h('option', { value: d.node }, `${nameOf(d)} (${d.node})`)));
  const chart = h('div', { class: 'stats-slot' });
  const more = h('a', {});
  let run = null;
  const show = (node) => {
    run?.abort();
    run = new AbortController();
    more.href = `#/stats/${node}`;
    more.textContent = ctx.t('dash.trafficMore');
    mountTrafficChart(chart, node, { ...ctx, signal: AbortSignal.any([ctx.signal, run.signal]) }, { period: '24h' });
  };
  select.addEventListener('change', () => show(select.value), { signal: ctx.signal });
  show(list[0].node);
  return h('section', { 'aria-labelledby': 'dash-traffic' },
    h('h2', { id: 'dash-traffic' }, ctx.t('dash.traffic')),
    list.length > 1 ? h('div', { class: 'field dash-traffic-pick' }, h('label', { for: 'dash-traffic-node' }, ctx.t('dash.trafficNode')), select) : null,
    chart,
    h('p', {}, more));
}
