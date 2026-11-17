// The board (W-20c): the header's status line, the tile grid and the key bar. The tiles are
// NODES | NODE | STATUS + MAP + RESULTS (operator decision 1); the grid's shape per width is in
// styles/app.css. Each tile is a named mount point that its own module fills (ui/tiles/); the
// board knows nothing of what a tile shows. README "The board's tiles" is the tile API.
//
//   registerTile({ id, title, render })   id: one of TILES; title: an i18n key; render(ctx) -> element
//   drawBoard(main, baseCtx)              (re)draws every tile, e.g. after a language change
//   drawStatusLine(list, t), drawKeyBar(box, t)
//   NARROW                                the phone layout's media query
import { h } from './dom.js';
import { GLYPH, statusItems } from './statusline.js';
import { barKeys, bindKey } from './keys.js';
import {
  selected, setSelected, tagged, setTagged, toggleTag, clearTags, onBoardChange,
} from './board-state.js';
import { openModal, closeModal, currentModal, onModalChange } from './modal.js';

export const TILES = Object.freeze(['nodes', 'node', 'status', 'map', 'results']);
export const NARROW = '(width < 45em)';

const tiles = new Map();
let drawn = null;   // AbortController of the tiles drawn last

export function registerTile(def) {
  if (!TILES.includes(def?.id)) throw new Error(`no tile ${def?.id}: the board has ${TILES.join(', ')}`);
  if (typeof def.render !== 'function') throw new Error(`tile ${def.id}: render must be a function`);
  if (tiles.has(def.id)) throw new Error(`tile ${def.id} is registered twice`);
  tiles.set(def.id, Object.freeze({ id: def.id, title: def.title, render: def.render }));
}

export const tileDef = (id) => tiles.get(id) || null;

// Ties a subscription to a signal: unsubscribed when it aborts.
const tied = (signal, unsubscribe) => {
  signal.addEventListener('abort', unsubscribe, { once: true });
  return unsubscribe;
};

function tileCtx(base, id, signal, heading) {
  const name = base.t(tiles.get(id)?.title || `tile.${id}`);
  return Object.freeze({
    ...base,
    signal,
    tile: Object.freeze({
      id,
      // "NODES 4 · 1 needs attention": the tile's name stays, the rest is the tile's to say.
      setTitle: (extra) => { heading.replaceChildren(h('span', { class: 'tile-name' }, name), extra ? ` ${extra}` : ''); },
    }),
    board: Object.freeze({
      selected, tagged, setTagged, toggleTag, clearTags,
      // On a phone the NODE tile is not on the board: selecting a node opens it full screen.
      select: (nodeId) => {
        setSelected(nodeId);
        if (nodeId && matchMedia(NARROW).matches) openModal('node', String(nodeId).toUpperCase());
      },
      on: (fn) => tied(signal, onBoardChange(fn)),
    }),
    keys: Object.freeze({ bind: (spec, opts) => tied(signal, bindKey(spec, opts)) }),
    modal: Object.freeze({
      open: openModal, close: closeModal, current: currentModal,
      on: (fn) => tied(signal, onModalChange(fn)),
    }),
    narrow: () => matchMedia(NARROW).matches,
  });
}

export function drawBoard(main, base) {
  drawn?.abort();
  drawn = new AbortController();
  const grid = h('div', { class: 'board' });
  for (const id of TILES) {
    const heading = h('h2', { class: 'tile-title', id: `tile-${id}-title` });
    const body = h('div', { class: 'tile-body' });
    const section = h('section', { class: 'tile', id: `tile-${id}`, 'data-tile': id, 'aria-labelledby': heading.id }, heading, body);
    grid.append(section);
    const def = tiles.get(id);
    const leave = new AbortController();
    drawn.signal.addEventListener('abort', () => leave.abort(), { once: true });
    const ctx = tileCtx(base, id, leave.signal, heading);
    ctx.tile.setTitle('');
    if (!def) continue;
    try {
      body.replaceChildren(def.render(ctx));
    } catch (err) {
      // One tile failing leaves the others standing.
      console.error(`tile ${id}:`, err);
      body.replaceChildren(h('p', { class: 'alert' }, base.t('board.tileFailed', { reason: err.message })));
    }
  }
  main.replaceChildren(h('h1', { class: 'visually-hidden', id: 'board-title' }, base.t('board.title')), grid);
  return drawn.signal;
}

export function drawStatusLine(list, t) {
  list.replaceChildren(...statusItems().map((item) => {
    const glyph = item.state ? h('span', { class: 'glyph', 'aria-hidden': 'true' }, GLYPH[item.state]) : null;
    const inner = [h('span', { class: 'status-name' }, t(`status.${item.name}`)), ' ', glyph, glyph ? ' ' : null,
      h('span', { class: 'status-word' }, item.word)];
    const attrs = { 'aria-label': item.label || null };
    return h('li', { class: 'status-item', 'data-item': item.name, 'data-state': item.state || null },
      item.href ? h('a', { href: item.href, ...attrs }, inner) : h('span', attrs, inner));
  }));
}

export function drawKeyBar(box, t) {
  box.replaceChildren(...barKeys().map((b) => {
    const button = h('button', { type: 'button', class: 'key-button', 'aria-keyshortcuts': b.spec.replace('ctrl+', 'Control+') },
      h('kbd', { 'aria-hidden': 'true' }, b.spec), ' ', b.label);
    button.addEventListener('click', (e) => b.run(e));
    return button;
  }));
  box.setAttribute('aria-label', t('board.keys'));
}
