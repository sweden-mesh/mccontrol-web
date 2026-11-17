// The app shell: language, the header (name, key state, display settings), the menu, the footer,
// messages, offline updates, and drawing the screen the address names into <main>. Hash routes
// (#/nodes, #/node/4AC61A7F) keep every screen working from a static host and a local server alike.
//
// What a screen gets (ctx), see README "Adding a screen":
//   t(key, vars)    the strings of the current language;  lang  'sv' | 'en'
//   route, args     the route and the path segments after it (#/node/AB -> 'node', ['AB'])
//   signal          an AbortSignal that fires when the screen is replaced: stop timers, listeners
//   navigate(hash)  go to another screen ('#/nodes')
//   notify(text, { kind: 'info'|'warning'|'error', actions: [{label, run}] }), announce(text)
//   key             { state(), on(fn) }: { status: 'none'|'locked'|'unlocked', publicKeyHex }
//   prefs           { current(), set(name, value), on(fn) }: the device's display settings
//   displaySettings()  the display settings form, for the settings screen
import { pickLanguage, translator, loadStrings } from '../i18n/i18n.js';
import { SCREENS, NAV, NOT_FOUND } from './screens/index.js';
import { h } from './dom.js';
import { currentPrefs, setPref, onPrefsChange } from './prefs.js';
import { keyState, onKeyState, shortKey } from './key-state.js';
import { notify, announce, useStrings } from './notify.js';
import { displaySettings } from './appearance.js';
import { readVersion, startUpdates } from './update.js';

export function routeOf(hash) {
  const path = String(hash || '').replace(/^#\/?/, '');
  const [name, ...args] = path.split('/');
  return { name: name || '', args: args.map(decodeURIComponent) };
}

export function screenFor(name) {
  return SCREENS.find((s) => s.route === name) || NOT_FOUND;
}

const WIDE = '(min-width: 60em)';
const $ = (id) => document.getElementById(id);

function languageFor(prefs) {
  return pickLanguage(navigator.languages || [navigator.language], prefs.lang === 'browser' ? null : prefs.lang);
}

// The menu: one list. On a phone it is a sheet opened from the bar at the bottom (a popover);
// from 60em it is a column beside the screen, and the popover attribute is removed.
function syncNavLayout() {
  const list = $('nav-list');
  if (matchMedia(WIDE).matches) {
    if (list.matches(':popover-open')) list.hidePopover();
    list.removeAttribute('popover');
  } else if (!list.hasAttribute('popover')) {
    list.setAttribute('popover', 'auto');
  }
}

function drawNav(t, current) {
  $('nav-list').replaceChildren(...NAV.map((route) => {
    const screen = screenFor(route);
    return h('li', {}, h('a', { href: `#/${route}`, 'aria-current': route === current ? 'page' : null }, t(screen.title)));
  }));
}

function drawKeyState(t) {
  const link = $('key-state');
  const { status, publicKeyHex } = keyState();
  link.hidden = false;
  link.dataset.status = status;
  link.href = status === 'unlocked' ? '#/key' : '#/unlock';
  link.replaceChildren(h('span', { class: 'key-status' }, t(`key.${status}`)));
  if (status === 'unlocked') link.append(h('code', { class: 'key-id' }, shortKey(publicKeyHex)));
  link.setAttribute('aria-label', status === 'unlocked'
    ? t('key.unlockedLabel', { key: shortKey(publicKeyHex) }) : t(`key.${status}Label`));
}

async function start() {
  let t = null;
  let lang = null;
  let version = { version: 'unknown' };
  let leave = null;
  let pendingUpdate = null;
  const main = $('main');

  const chrome = () => {
    document.documentElement.lang = lang;
    $('skip').textContent = t('app.skip');
    $('subtitle').textContent = t('app.subtitle');
    $('site-nav').setAttribute('aria-label', t('app.menu'));
    $('menu-button').textContent = t('app.menu');
    $('menu-button').hidden = false;
    $('display-button').textContent = t('display.button');
    $('display-button').hidden = false;
    $('toasts').setAttribute('aria-label', t('app.messages'));
    // Rebuilt in the new language while it may be open: keep focus on the same control.
    const panel = $('display-panel');
    const inputs = () => [...panel.querySelectorAll('input')];
    const focused = inputs().indexOf(document.activeElement);
    panel.replaceChildren(h('h2', { class: 'panel-title' }, t('display.title')), displaySettings({ t }));
    if (focused >= 0) inputs()[focused]?.focus();
    drawKeyState(t);
    drawFooter();
  };

  // The footer's link to the source is in index.html (no URL to another site in our scripts).
  const drawFooter = () => {
    const update = pendingUpdate ? h('button', { type: 'button', class: 'link-button' }, t('update.reload')) : null;
    update?.addEventListener('click', pendingUpdate);
    $('footer-status').replaceChildren(
      t('app.version', { version: version.version }),
      update ? h('span', { class: 'update-ready' }, ' · ', t('update.ready'), ' ', update) : '');
    $('source-link').textContent = t('app.source');
  };

  const draw = (moveFocus) => {
    if (location.hash && !location.hash.startsWith('#/')) return;   // an in-page anchor, not a route
    const { name, args } = routeOf(location.hash);
    const screen = screenFor(name);
    leave?.abort();
    leave = new AbortController();
    drawNav(t, NAV.includes(name) ? name : null);
    const ctx = Object.freeze({
      t, lang, route: name, args, signal: leave.signal,
      navigate: (hash) => { location.hash = hash; },
      notify, announce,
      key: Object.freeze({ state: keyState, on: onKeyState }),
      prefs: Object.freeze({ current: currentPrefs, set: setPref, on: onPrefsChange }),
      displaySettings: () => displaySettings({ t }),
    });
    main.replaceChildren(screen.render(ctx));
    const heading = main.querySelector('h1');
    document.title = name === '' ? 'mccontrol' : `${heading?.textContent || t(screen.title)} · mccontrol`;
    if (moveFocus) {
      if (heading) heading.tabIndex = -1;
      (heading || main).focus();
    }
  };

  const relabel = async () => {
    lang = languageFor(currentPrefs());
    t = translator(await loadStrings(lang));
    useStrings(t);
    chrome();
    draw(false);
  };

  await relabel();
  syncNavLayout();
  matchMedia(WIDE).addEventListener('change', syncNavLayout);
  // A link in the sheet goes somewhere: close the sheet behind it.
  $('nav-list').addEventListener('click', (e) => {
    const list = $('nav-list');
    if (e.target.closest('a') && list.matches(':popover-open')) list.hidePopover();
  });
  addEventListener('hashchange', () => draw(true));
  onKeyState(() => drawKeyState(t));
  onPrefsChange((prefs) => { if (languageFor(prefs) !== lang) relabel(); });

  version = await readVersion();
  drawFooter();
  startUpdates({
    version: version.version,
    onWaiting: (apply) => {
      pendingUpdate = apply;
      drawFooter();
      notify(t('update.ready'), { kind: 'warning', actions: [{ label: t('update.reload'), run: apply }] });
    },
  }).catch((err) => notify(t('update.failed', { reason: err.message }), { kind: 'error' }));
}

if (typeof document !== 'undefined') start();
