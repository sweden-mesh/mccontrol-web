// NODES (W-20c): one row per node, what needs attention first. Each row, on ONE line: the status
// glyph, the name, firmware and when it was last heard (no region, W-33g) (no battery: NODE shows it, W-26f);
// the row is tinted by severity. No status text on the row (W-28c, which replaced W-23d's reason
// column): the reason is NODE's and the row's tooltip's on hover or keyboard focus (W-35b); on a phone the node opens full screen. The title says "4 · 1 needs attention". The "2 new"
// results count is NODE's (W-26g; W-25d had put it here).
//
// Pointer: a click on a row selects it (the NODE tile follows; on a phone the node opens full
// screen); the box at the row's start tags it for a send to several. Keyboard: '/' searches,
// ↑ ↓ Home End move between rows (one tab stop for the list), Enter selects, Space tags, Esc in
// the search clears it.
import { h } from '../dom.js';
import { lowBatteryVolts, notHeardHours } from '../screens/settings-store.js';
import { lastHeard, shortVersion } from '../../lib/jobs/overview.js';
import { nameOf } from '../screens/node-kit.js';
import { age, everyMinute, forKey, stateMark } from './kit.js';
import { byAttention, matches, nodeStatus, sharedPrefix } from './data.js';
import { onDataChanged } from './sources.js';
import { hintGone, statusHint } from '../status-hint.js';

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
    const prefix = sharedPrefix(devices.map(nameOf));
    list.replaceChildren(...(shown.length ? shown.map((r) => row(ctx, svc, r, { now, selected, tags, focusId, prefix }))
      : [h('li', { class: 'row muted', role: 'status' }, ctx.t('nodes.noMatch'))]));
    hintGone();
    foot.textContent = [
      shown.length === devices.length ? ctx.t(devices.length === 1 ? 'tile.nodesCountOne' : 'tile.nodesCount', { n: devices.length }) : ctx.t('nodes.count', { n: shown.length, of: devices.length }),
      tags.size ? ctx.t('tile.taggedCount', { n: tags.size }) : ctx.t('tile.nodesKeys'),
    ].join(' · ');
  }

  // A row: [tag box] [button: glyph word · name · reason · region · firmware · heard]
  function row(ctx, svc, { device: d, status }, { now, selected, tags, focusId: f, prefix = '' }) {
    const name = nameOf(d);
    // The part that tells it apart: what every name shares at the start says nothing (data.js).
    const short = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
    const tagged = tags.has(d.node);
    const box = h('input', { type: 'checkbox', class: 'tag-box', checked: tagged, tabindex: '-1',
      'aria-label': ctx.t('tile.tagNode', { name }) });
    box.addEventListener('change', () => ctx.board.toggleTag(d.node));
    const heard = lastHeard(d);
    // The reason lives in NODE (W-28c): the row is the name, region, firmware, heard and the
    // severity mark; the glyph's word is read aloud, never shown (no "ok" on a row).
    const button = h('button', { type: 'button', class: 'node-row', 'data-node': d.node, tabindex: d.node === f ? '0' : '-1',
      'aria-current': d.node === selected ? 'true' : null },
    stateMark(ctx, status.state),
    h('span', { class: 'node-name', title: name }, short),
    // The column is narrow: the revision and what the image carries ("lou-20-arrc"); the whole short
    // version, with "-observer", is the cell's tooltip and the NODE tile's first line.
    h('span', { class: 'node-ver', title: d.ver ? shortVersion(svc.rules, d.ver) : null }, d.ver ? shortVersion(svc.rules, d.ver).replace(/-observer$/, '') : '–'),
    h('span', { class: 'node-heard' }, heard ? age(ctx, heard, now) : '–'));
    button.addEventListener('click', () => { focusId = d.node; ctx.board.select(ctx.board.selected() === d.node ? null : d.node); });
    return h('li', { class: `node-item${tagged ? ' is-tagged' : ''}`, 'data-state': status.state },
      h('label', { class: 'tag-hit' }, box),
      button, statusHint(ctx, button, status));
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
