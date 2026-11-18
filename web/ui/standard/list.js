// The standard layout's node list (W-29a, W-29g): a search over name and public key, the count,
// "All" or "Needs attention", and one row per node: the status mark, the name, and under it the
// firmware and when it was last heard (no region: that is the node's details', W-33g). A click selects the node (board-state.js, shared
// with the retro board); on a phone the detail then takes the screen. The row's tint and mark
// carry the state (a glyph that differs in shape, read aloud as a word), never colour alone; the
// full status (every reason, or "All OK") is the row's tooltip on hover or keyboard focus (W-35b).
import { h } from '../dom.js';
import { lowBatteryVolts, notHeardHours } from '../screens/settings-store.js';
import { lastHeard, shortVersion } from '../../lib/jobs/overview.js';
import { nameOf } from '../screens/node-kit.js';
import { age, everyMinute, stateMark } from '../tiles/kit.js';
import { onDataChanged } from '../tiles/sources.js';
import { byAttention, nodeStatus } from '../tiles/data.js';
import { nodeMatches } from './search.js';
import { hintGone, statusHint } from '../status-hint.js';

let lists = 0;

export function nodeList(ctx, svc, { selected, onPick }) {
  const id = `std-list-${lists += 1}`;
  const search = h('input', { type: 'search', id: `${id}-q`, class: 'std-search', autocomplete: 'off', spellcheck: 'false',
    enterkeyhint: 'search', placeholder: ctx.t('std.searchHint'), 'aria-controls': `${id}-rows`, 'aria-describedby': `${id}-count` });
  const count = h('p', { class: 'std-count muted', id: `${id}-count`, role: 'status' });
  const radios = ['all', 'attention'].map((v) => h('input', { type: 'radio', name: `${id}-f`, value: v, class: 'seg-input', checked: v === 'all' }));
  const words = radios.map(() => h('span', {}));
  const filter = h('fieldset', { class: 'seg std-filter' }, h('legend', { class: 'visually-hidden' }, ctx.t('std.filter')),
    radios.map((r, i) => h('label', { class: 'seg-option' }, r, words[i])));
  const rows = h('ul', { class: 'std-rows', id: `${id}-rows`, 'aria-label': ctx.t('tile.nodes') });
  const more = h('button', { type: 'button', class: 'tool std-more' }, ctx.t('std.findMore'));
  more.addEventListener('click', () => ctx.navigate('#nodes'), { signal: ctx.signal });
  const el = h('div', { class: 'std-list' },
    h('div', { class: 'std-list-tools' },
      h('label', { class: 'visually-hidden', for: search.id }, ctx.t('std.search')), search, filter, count),
    rows, h('div', { class: 'std-list-foot' }, more));
  let current = selected;
  let release = null;

  async function draw() {
    const devices = await svc.stores.devices.list();
    if (ctx.signal.aborted) return;
    const now = Date.now();
    const opts = { now, hours: notHeardHours(), thresholdMv: lowBatteryVolts() * 1000, release, rules: svc.rules };
    const all = byAttention(devices.map((d) => ({ device: d, status: nodeStatus(d, opts) })), ctx.lang);
    const attention = all.filter((r) => r.status.state === 'alert' || r.status.state === 'warn');
    words[0].textContent = ctx.t('std.all', { n: all.length });
    words[1].textContent = ctx.t('std.attention', { n: attention.length });
    const pool = radios[1].checked ? attention : all;
    const shown = pool.filter((r) => nodeMatches(r.device, search.value));
    count.textContent = search.value.trim() || radios[1].checked
      ? ctx.t('nodes.count', { n: shown.length, of: all.length })
      : ctx.t(all.length === 1 ? 'tile.nodesCountOne' : 'tile.nodesCount', { n: all.length });
    if (!all.length) {
      rows.replaceChildren(h('li', { class: 'std-empty muted' }, ctx.t('std.noNodes')));
      return;
    }
    rows.replaceChildren(...(shown.length ? shown.map(({ device: d, status }) => {
      const heard = lastHeard(d);
      const b = h('button', { type: 'button', class: 'std-row', 'data-node': d.node, 'aria-current': d.node === current ? 'true' : null },
        stateMark(ctx, status.state),
        h('span', { class: 'std-row-name' }, nameOf(d)),
        h('span', { class: 'std-row-sub muted' },
          d.ver ? shortVersion(svc.rules, d.ver) : ctx.t('nodes.verUnknown'),
          ' · ', heard ? age(ctx, heard, now) : ctx.t('nodes.heardUnknown')));
      b.addEventListener('click', () => onPick(d.node));
      return h('li', { 'data-state': status.state }, b, statusHint(ctx, b, status));
    }) : [h('li', { class: 'std-empty muted' }, ctx.t('nodes.noMatch'))]));
    hintGone();
  }

  const redraw = () => draw().catch((e) => rows.replaceChildren(h('li', { class: 'std-empty tile-err' }, e.message)));
  search.addEventListener('input', redraw, { signal: ctx.signal });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) { e.preventDefault(); search.value = ''; redraw(); }
  }, { signal: ctx.signal });
  for (const r of radios) r.addEventListener('change', redraw, { signal: ctx.signal });
  ctx.signal.addEventListener('abort', onDataChanged((what) => { if (what !== 'seen') redraw(); }), { once: true });
  everyMinute(ctx.signal, redraw);
  svc.releases().then((r) => { release = r; if (r && !ctx.signal.aborted) redraw(); }).catch(() => {});
  redraw();
  return {
    el,
    redraw,
    select(node) {
      current = node;
      for (const b of rows.querySelectorAll('.std-row')) b.setAttribute('aria-current', b.dataset.node === node ? 'true' : 'false');
    },
  };
}
