// What the tiles share in the page: SVG building, the services for the current key (redrawn when
// the key changes), short ages ("30 min"), the status glyph and word, and a few line helpers.
import { h } from '../dom.js';
import { GLYPH } from '../statusline.js';
import { services } from '../screens/node-services.js';
import { unlockHash } from '../screens/key-session.js';
import { useStyles } from '../screens/node-kit.js';

const SVG = ['http:', '', 'www.w3.org', '2000', 'svg'].join('/');     // a namespace name, not fetched

// h() for SVG: the same rules (text as text, no on* attributes).
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (name.startsWith('on')) throw new Error('attach listeners with addEventListener');
    el.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// Fill `slot` for the current key, again whenever the key changes (made, unlocked, locked,
// replaced). fill(svc, { owner, locked }) draws into slot; without a key slot says so, with a
// link to make or unlock one. Errors are said in the slot. Returns nothing; tied to ctx.signal.
export function forKey(ctx, slot, fill) {
  useStyles();
  let shown = null;
  let turn = 0;
  const run = () => {
    const { status, publicKeyHex } = ctx.key.state();
    const id = `${status}:${publicKeyHex}`;
    if (id === shown) return;
    shown = id;
    const mine = turn += 1;
    if (status === 'none' || !publicKeyHex) {
      slot.replaceChildren(h('p', { class: 'row muted' }, ctx.t('tile.noKey'), ' ',
        h('a', { href: unlockHash('') }, ctx.t('tile.makeKey'))));
      return;
    }
    services(publicKeyHex)
      .then((svc) => { if (!ctx.signal.aborted && mine === turn) return fill(svc, { owner: publicKeyHex, locked: status === 'locked' }); return null; })
      .catch((e) => { if (!ctx.signal.aborted && mine === turn) slot.replaceChildren(h('p', { class: 'row tile-err' }, e.message)); });
  };
  const off = ctx.key.on(run);
  ctx.signal.addEventListener('abort', () => off?.(), { once: true });
  run();
}

// "30 min", "5 h", "3 d"; '' without a time. The exact time goes in a title.
export function shortAge(ctx, at, now = Date.now()) {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return '';
  const secs = Math.max(0, Math.round((now - ms) / 1000));
  if (secs < 60) return ctx.t('tile.ageNow');
  if (secs < 3600) return ctx.t('tile.ageMin', { n: Math.floor(secs / 60) });
  if (secs < 172800) return ctx.t('tile.ageH', { n: Math.floor(secs / 3600) });
  return ctx.t('tile.ageD', { n: Math.floor(secs / 86400) });
}

// "in 3 min", "now" for a time ahead.
export function shortUntil(ctx, at, now = Date.now()) {
  if (!Number.isFinite(at)) return '';
  const secs = Math.round((at - now) / 1000);
  if (secs <= 30) return ctx.t('tile.dueNow');
  return ctx.t('tile.inMin', { n: Math.max(1, Math.round(secs / 60)) });
}

export function age(ctx, at, now = Date.now()) {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return h('span', { class: 'muted' }, '–');
  const d = new Date(ms);
  return h('time', { datetime: d.toISOString(), title: d.toLocaleString(ctx.lang) }, shortAge(ctx, ms, now));
}

// The glyph (hidden from a screen reader) and the word: status is never colour alone.
export function stateMark(ctx, state, word = ctx.t(`tile.state.${state}`)) {
  return h('span', { class: 'mark', 'data-state': state },
    h('span', { class: 'glyph', 'aria-hidden': 'true' }, GLYPH[state] || GLYPH.unknown), ' ',
    h('span', { class: 'mark-word' }, word));
}

// "14:02" today, "yesterday", else the date: the RESULTS time column.
export function clockTime(ctx, at, now = Date.now()) {
  const d = new Date(at);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString(ctx.lang, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }
  const y = new Date(now - 86400000);
  if (d.toDateString() === y.toDateString()) return ctx.t('tile.yesterday');
  return d.toLocaleDateString(ctx.lang, { day: 'numeric', month: 'short' });
}

// Redraw `fn` every minute (ages move) until the signal aborts.
export function everyMinute(signal, fn) {
  let timer = null;
  const tick = () => { fn(); timer = setTimeout(tick, 60000 - (Date.now() % 60000) + 50); };
  timer = setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
}

export const volts = (mv) => (Number.isFinite(mv) ? `${(mv / 1000).toFixed(2)} V` : '–');
