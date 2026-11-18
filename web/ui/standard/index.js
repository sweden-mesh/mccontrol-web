// The standard layout, "list and detail" (W-29): the same app, data and jobs as the retro board,
// laid out for people the board is hard to navigate for. The default for a new user (W-29h,
// operator 2026-11-18); Settings and the button top right switch to the retro board.
//
//   header   app name (no area, W-33g), companion, Setup (gear), Help, Log out (W-29e), the layout switch
//   list     the owner's nodes with a live search (W-29g)            ui/standard/list.js
//   detail   the selected node: top panel, tabs, Overview's panels   ui/standard/detail.js
//   footer   the states that gate everything, glyph and word each; bottom right the front end's
//            version and a link to its source (W-35e)
//
// On a phone (under 45em) the list and the detail take the screen in turn: a row opens the
// detail, "All nodes" goes back. Modals (Setup, Help, a result, Neighbours) are the shell's, the
// same as on the retro board. No keyboard shortcut is needed for anything here.
import { h } from '../dom.js';
import { setPref } from '../prefs.js';
import { selected, setSelected } from '../board-state.js';
import { keyring, keyStatus } from '../screens/key-session.js';
import { services } from '../screens/node-services.js';
import { confirm } from '../screens/node-kit.js';
import { companionChooser } from '../screens/road-kit.js';
import { onCompanion, state as companionState } from '../companion-session.js';
import { GLYPH } from '../statusline.js';
import { brokerWord } from '../tiles/status.js';
import { shortAge } from '../tiles/kit.js';
import { onSources, source } from '../tiles/sources.js';
import { icon } from './icons.js';
import { nodeList } from './list.js';
import { nodeDetail, overviewAll } from './detail.js';
import { readVersion } from '../update.js';

export const NARROW = '(width < 45em)';
let drawn = null;

// Log out (W-29e): ask, then lock the key; the unlock gate (W-28b) takes over.
export async function logOut(ctx) {
  const ok = await confirm(ctx, {
    title: ctx.t('std.logoutTitle'),
    lines: [h('p', {}, ctx.t('std.logoutBody'))],
    confirmLabel: ctx.t('std.logout'),
  });
  if (ok) await keyring()?.lock();
  return ok;
}

// The switch between the layouts: a clear button top right in both (operator 2026-11-18).
export function layoutSwitch(ctx, to) {
  const label = ctx.t(to === 'retro' ? 'std.toRetro' : 'std.toStandard');
  const b = h('button', { type: 'button', class: `tool layout-switch layout-to-${to}`, title: label, 'aria-label': label },
    icon(to === 'retro' ? 'terminal' : 'layout'));
  b.addEventListener('click', () => setPref('layout', to));
  return b;
}

function header(ctx, signal) {
  const comp = h('button', { type: 'button', class: 'tool std-companion', 'aria-haspopup': 'dialog' });
  const drawComp = () => {
    const c = companionState();
    const word = c.status === 'connected' ? (c.name || ctx.t(`companion.kind.${c.kind}`))
      : c.status === 'connecting' ? ctx.t('companion.connecting') : c.status === 'error' ? ctx.t('tile.companionError') : ctx.t('tile.notConnected');
    comp.replaceChildren(h('span', { class: 'std-comp-name' }, ctx.t('std.companion')), h('span', { class: 'std-comp-word' }, word));
    comp.dataset.state = c.status;
  };
  comp.addEventListener('click', () => companionChooser(ctx));
  const gear = h('button', { type: 'button', class: 'tool std-icon', title: ctx.t('board.setup'), 'aria-label': ctx.t('board.setup') }, icon('gear'));
  gear.addEventListener('click', () => ctx.modal.open('setup'));
  const help = h('button', { type: 'button', class: 'tool' }, ctx.t('board.help'));
  help.addEventListener('click', () => ctx.modal.open('help'));
  const out = h('button', { type: 'button', class: 'tool' }, ctx.t('std.logout'));
  out.addEventListener('click', () => logOut(ctx));
  const tie = (u) => signal.addEventListener('abort', u, { once: true });
  tie(onCompanion(drawComp));
  drawComp();
  return h('header', { class: 'std-head' },
    h('span', { class: 'std-brand' }, 'mccontrol'),
    h('div', { class: 'std-head-tools' }, comp, gear, help, out, layoutSwitch(ctx, 'retro')));
}

function footer(ctx, signal) {
  const list = h('ul', { class: 'std-foot-items' });
  const item = (name, state, word, title = null) => h('li', { 'data-state': state, title },
    h('span', { class: 'glyph', 'aria-hidden': 'true' }, GLYPH[state === 'running' ? 'unknown' : state] || GLYPH.unknown), ' ',
    h('span', {}, ctx.t(`std.foot.${name}`), ' ', word));
  const draw = () => {
    const b = source('broker')?.state() || { state: 'running' };
    const k = keyStatus();
    const reg = source('registration')?.state() || { state: 'unknown' };
    const ref = source('refresh')?.state() || { state: 'unknown' };
    const regWord = reg.state === 'ok' ? ctx.t('tile.registered') : reg.state === 'running' ? ctx.t('tile.running')
      : reg.state === 'alert' ? ctx.t('tile.notRegistered') : reg.state === 'warn' ? ctx.t('tile.partly') : ctx.t('tile.notKnown');
    list.replaceChildren(
      item('broker', b.state, brokerWord(ctx, b), [b.hosts?.join(', '), b.detail].filter(Boolean).join(' · ') || null),
      item('key', 'ok', k.autoLockMinutes ? ctx.t('tile.locksAfter', { n: k.autoLockMinutes }) : ctx.t('tile.locksOnClose')),
      item('registration', reg.state, regWord, reg.detail),
      item('refresh', ref.state, !ref.last ? ctx.t('tile.notYet') : Date.now() - ref.last < 60000 ? ctx.t('node.justNow')
        : ctx.t('tile.ago', { age: shortAge(ctx, ref.last) }), ref.detail));
  };
  let unsub = [];
  const wire = () => {
    for (const u of unsub) u();
    unsub = ['broker', 'registration', 'refresh'].map((n) => source(n)?.on?.(draw)).filter(Boolean);
    draw();
  };
  signal.addEventListener('abort', onSources(wire), { once: true });
  signal.addEventListener('abort', () => { for (const u of unsub) u(); }, { once: true });
  const timer = setInterval(draw, 60000);
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  wire();
  // The link is index.html's #source-link (the board's footer, hidden here: the one URL in the page).
  // "web-v0.1.0-beta.9" or "v0.1.0-beta.9" from a deploy, "dev" from the repository.
  const ver = h('span', {}, ctx.t('std.foot.version', { version: '…' }));
  readVersion().then((v) => { ver.textContent = ctx.t('std.foot.version', { version: String(v.version).replace(/^(web-)?v(?=\d)/, '') }); });
  return h('footer', { class: 'std-foot', 'aria-label': ctx.t('board.statusLine') }, list,
    h('p', { class: 'std-foot-about muted' }, ver, ' · ', h('a', { href: document.getElementById('source-link')?.href }, ctx.t('app.source'))));
}

export function drawStandard(main, base) {
  drawn?.abort();
  drawn = new AbortController();
  const signal = drawn.signal;
  const ctx = Object.freeze({ ...base, signal });
  const aside = h('aside', { class: 'std-aside', 'aria-label': ctx.t('tile.nodes') });
  const detail = h('section', { class: 'std-main', 'aria-label': ctx.t('std.detail') });
  const body = h('div', { class: 'std-body', 'data-view': 'list' });
  body.append(aside, detail);
  main.replaceChildren(h('div', { class: 'std' }, header(ctx, signal), body, footer(ctx, signal)));

  const { publicKeyHex } = ctx.key.state();
  if (!publicKeyHex) return signal;
  let tab = 'overview';
  let detailLeave = null;
  services(publicKeyHex).then((svc) => {
    if (signal.aborted) return;
    const back = h('button', { type: 'button', class: 'tool std-back' }, ctx.t('std.back'));
    back.addEventListener('click', () => { body.dataset.view = 'list'; aside.querySelector('.std-row[aria-current="true"]')?.focus(); });
    const drawDetail = ({ focus = false } = {}) => {
      detailLeave?.abort();
      detailLeave = new AbortController();
      signal.addEventListener('abort', () => detailLeave.abort(), { once: true });
      const dctx = Object.freeze({ ...ctx, signal: detailLeave.signal });
      const id = selected();
      const view = id ? nodeDetail(dctx, svc, id, {
        tab,
        onTab: (next, o = {}) => { tab = next; drawDetail(o); },
        onPick: pick,
      }) : overviewAll(dctx, svc, { onPick: pick });
      detail.replaceChildren(back, view);
      if (focus) queueMicrotask(() => view.querySelector?.('.std-tab[aria-selected="true"]')?.focus());
    };
    function pick(id) {
      if (id !== selected()) tab = 'overview';
      setSelected(id);
      list.select(id);
      drawDetail();
      if (matchMedia(NARROW).matches) { body.dataset.view = 'detail'; detail.scrollIntoView({ block: 'start' }); detail.querySelector('h1')?.focus?.(); }
    }
    const list = nodeList(ctx, svc, { selected: selected(), onPick: pick });
    aside.replaceChildren(list.el);
    drawDetail();
  }).catch((e) => { detail.replaceChildren(h('p', { class: 'tile-err' }, e.message)); });
  return signal;
}
