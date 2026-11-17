// NODES (W-20c): one row per node, what needs attention first. Each row: the status as a glyph and
// a word, the name, region, firmware, battery and when it was last heard; a node that needs
// attention has its reason on a second line. The title says "4 · 1 needs attention".
//
// Pointer: a click on a row selects it (the NODE tile follows; on a phone the node opens full
// screen); the box at the row's start tags it for a send to several. Keyboard: '/' searches,
// ↑ ↓ Home End move between rows (one tab stop for the list), Enter selects, Space tags, Esc in
// the search clears it.
import { h } from '../dom.js';
import { lowBatteryVolts, notHeardHours } from '../screens/settings-store.js';
import { lastHeard, shortVersion } from '../../lib/jobs/overview.js';
import { nameOf } from '../screens/node-kit.js';
import { age, everyMinute, forKey, stateMark, volts } from './kit.js';
import { byAttention, matches, nodeStatus } from './data.js';
import { onDataChanged } from './sources.js';

export const id = 'nodes';
export const title = 'tile.nodes';

export function render(ctx) {
  const body = h('div', { class: 'tile-fill nodes-tile' });
  forKey(ctx, body, (svc) => fill(ctx, svc, body));
  return body;
}

function fill(ctx, svc, body) {
  const search = h('input', { type: 'search', class: 'tile-search', autocomplete: 'off', spellcheck: 'false',
    enterkeyhint: 'search', 'aria-keyshortcuts': '/', placeholder: ctx.t('tile.searchHint') });
  const searchLabel = h('label', { class: 'tile-search-row' }, h('span', { class: 'visually-hidden' }, ctx.t('nodes.search')),
    h('span', { 'aria-hidden': 'true', class: 'muted' }, '/'), search);
  const list = h('ul', { class: 'rows node-rows', 'aria-label': ctx.t('tile.nodes') });
  const foot = h('p', { class: 'tile-foot muted' });
  const live = h('p', { class: 'visually-hidden', role: 'status' });
  body.replaceChildren(searchLabel, list, foot, live);
  let release = null;
  let focusId = null;

  async function draw() {
    const devices = await svc.stores.devices.list();
    if (ctx.signal.aborted) return;
    const now = Date.now();
    const opts = { now, hours: notHeardHours(), thresholdMv: lowBatteryVolts() * 1000, release, rules: svc.rules };
    const rows = byAttention(devices.map((d) => ({ device: d, status: nodeStatus(d, opts) })), ctx.lang);
    const attention = rows.filter((r) => r.status.state === 'alert' || r.status.state === 'warn').length;
    ctx.tile.setTitle(devices.length ? ctx.t('tile.nodesTitle', { n: devices.length, att: attention }) : '');
    if (!devices.length) {
      list.replaceChildren(h('li', { class: 'row muted' }, ctx.t('tile.noNodes'), ' ',
        h('a', { href: '#nodes' }, ctx.t('tile.findNodes'))));
      foot.textContent = '';
      searchLabel.hidden = true;
      return;
    }
    searchLabel.hidden = false;
    const shown = rows.filter((r) => matches(r.device, search.value));
    const selected = ctx.board.selected();
    const tags = new Set(ctx.board.tagged());
    if (!focusId || !shown.some((r) => r.device.node === focusId)) focusId = selected && shown.some((r) => r.device.node === selected) ? selected : shown[0]?.device.node;
    list.replaceChildren(...(shown.length ? shown.map((r) => row(ctx, svc, r, { now, selected, tags, focusId }))
      : [h('li', { class: 'row muted', role: 'status' }, ctx.t('nodes.noMatch'))]));
    foot.textContent = [
      shown.length === devices.length ? ctx.t('tile.nodesCount', { n: devices.length }) : ctx.t('nodes.count', { n: shown.length, of: devices.length }),
      tags.size ? ctx.t('tile.taggedCount', { n: tags.size }) : ctx.t('tile.nodesKeys'),
    ].join(' · ');
  }

  // A row: [tag box] [button: glyph word · name · region · firmware · battery · heard] [reason]
  function row(ctx, svc, { device: d, status }, { now, selected, tags, focusId: f }) {
    const name = nameOf(d);
    const tagged = tags.has(d.node);
    const box = h('input', { type: 'checkbox', class: 'tag-box', checked: tagged, tabindex: '-1',
      'aria-label': ctx.t('tile.tagNode', { name }) });
    box.addEventListener('change', () => ctx.board.toggleTag(d.node));
    const heard = lastHeard(d);
    const reason = status.reasons.find((r) => r.kind === 'refused' || r.kind === 'forged') || status.reasons[0];
    const reasonText = reason ? ctx.t(`dash.att.${reason.kind}`, reason.vars) : null;
    const button = h('button', { type: 'button', class: 'node-row', 'data-node': d.node, tabindex: d.node === f ? '0' : '-1',
      'aria-current': d.node === selected ? 'true' : null, 'aria-describedby': reasonText ? `why-${d.node}` : null },
    stateMark(ctx, status.state),
    h('span', { class: 'node-name' }, name),
    h('span', { class: 'node-reg' }, d.region),
    h('span', { class: 'node-ver' }, d.ver ? shortVersion(svc.rules, d.ver) : '–'),
    h('span', { class: 'node-batt' }, volts(d.fleet?.batteryMv)),
    h('span', { class: 'node-heard' }, heard ? age(ctx, heard, now) : '–'));
    button.addEventListener('click', () => { focusId = d.node; ctx.board.select(d.node); });
    return h('li', { class: `node-item${tagged ? ' is-tagged' : ''}`, 'data-state': status.state },
      h('label', { class: 'tag-hit' }, box),
      button,
      reasonText ? h('span', { class: `node-why${status.state === 'alert' ? ' alert' : ''}`, id: `why-${d.node}`,
        title: status.reasons.map((r) => ctx.t(`dash.att.${r.kind}`, r.vars)).join('; ') },
      reasonText, status.reasons.length > 1 ? ` ${ctx.t('tile.more', { n: status.reasons.length - 1 })}` : '') : null);
  }

  // One tab stop: arrows move the roving focus, Space tags, Enter is the button's own click.
  list.addEventListener('keydown', (e) => {
    const b = e.target.closest?.('.node-row');
    if (!b || e.altKey || e.ctrlKey || e.metaKey) return;
    const all = [...list.querySelectorAll('.node-row')];
    const i = all.indexOf(b);
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: all.length - 1 }[e.key];
    if (to !== undefined) {
      const next = all[to];
      if (!next) return;              // at an end: let the page scroll
      e.preventDefault();
      b.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
      focusId = next.dataset.node;
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      focusId = b.dataset.node;
      ctx.board.toggleTag(b.dataset.node);
      const tagged = ctx.board.tagged().includes(b.dataset.node);
      live.textContent = ctx.t(tagged ? 'tile.tagged' : 'tile.untagged', { name: b.querySelector('.node-name').textContent });
    }
  }, { signal: ctx.signal });

  const refocus = () => {
    if (!list.contains(document.activeElement)) return;
    list.querySelector(`.node-row[data-node="${focusId}"]`)?.focus();
  };
  const redraw = () => draw().then(refocus).catch((e) => console.error('nodes tile:', e));
  search.addEventListener('input', redraw, { signal: ctx.signal });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) { e.preventDefault(); search.value = ''; redraw(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); list.querySelector('.node-row[tabindex="0"]')?.focus(); }
  }, { signal: ctx.signal });
  ctx.keys.bind('/', { label: ctx.t('tile.searchKey'), run: () => { search.focus(); search.select(); }, bar: !ctx.narrow(), order: 20 });
  ctx.board.on(redraw);
  ctx.signal.addEventListener('abort', onDataChanged(redraw), { once: true });
  everyMinute(ctx.signal, redraw);
  redraw();
  svc.releases().then((r) => { release = r; if (r && !ctx.signal.aborted) redraw(); }).catch(() => {});
}
