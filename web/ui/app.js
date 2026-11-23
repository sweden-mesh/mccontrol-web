// The app shell (W-20c, W-20d): language, the header's status line, the board, the key bar, the
// modal in front of the board, messages, offline updates. The board is the page; the hash names
// the modal open in front of it (ui/routes.js), so a link opens a modal and Back closes it.
//
// The shared ctx, given to every tile (ui/board.js adds tile, board, keys, narrow) and every
// modal (ui/modal.js adds route, args, signal, close):
//   t(key, vars)    the strings of the current language;  lang  'sv' | 'en'
//   navigate(hash)  go somewhere: '#node/4AC61A7F', '' for the board; old '#/route' forms work
//   notify(text, { kind: 'info'|'warning'|'error', actions: [{label, run}] }), announce(text)
//   key             { state(), on(fn) }: { status: 'none'|'locked'|'unlocked', publicKeyHex }
//                   (the keyring itself, the handle and holds: screens/key-session.js)
//   prefs           { current(), set(name, value), on(fn) }: the device's display settings
//   displaySettings()  the display settings form (theme, language)
//   modal           { open(name, ...args), close(), current() }
//
// start() draws a visible message in <main> when it fails (W-20k); ui/boot.js does the same for
// a module that fails before this one runs.
import { isDemo, demoReadOnly } from './demo/mode.js';   // first: a demo page replaces its doors before any other module runs (W-39)
import { pickLanguage, translator, loadStrings } from '../i18n/i18n.js';
import { h } from './dom.js';
import { currentPrefs, setPref, onPrefsChange, migratePrefs } from './prefs.js';
import { keyState, onKeyState, shortKey } from './key-state.js';
import { notify, announce, useStrings } from './notify.js';
import { displaySettings } from './appearance.js';
import { readVersion, startUpdates } from './update.js';
import { startKeySession } from './screens/key-session.js';
import { startAutoRegistration } from './screens/key-register.js';
import { bindPaletteKeys } from './modals/palette.js';
import { parseHash, targetHash } from './routes.js';
import {
  isModal, openModal, closeModal, currentModal, routeModal, useFrame, relabelFrame, onModalChange,
} from './modal.js';
import { drawBoard, drawStatusLine, drawKeyBar } from './board.js';
import { drawStandard, layoutSwitch } from './standard/index.js';
import { setStatusItem, statusItems, onStatusChange } from './statusline.js';
import { bindKey, handleKey, onKeysChange } from './keys.js';
import { startAutomation } from './automation.js';
import { mountUsbDebug } from './usb-debug.js';
import './tiles/index.js';
import './modals/index.js';

const $ = (id) => document.getElementById(id);

// The unlock gate (W-28b): while there is no unlocked key, the page behind is hidden and inert and
// only the unlock modal (make, import or unlock) and Help can be open. Auto-lock brings it back.
// What was asked for before the gate is opened once the key is unlocked.
export const GATE_OPEN = Object.freeze(['unlock', 'help']);
export const gated = (status = keyState().status) => status !== 'unlocked';
let gateReturn = null;
let loadedStrings = null;   // the translator, once the strings have loaded (for the start error)

function languageFor(prefs) {
  return pickLanguage(navigator.languages || [navigator.language], prefs.lang === 'browser' ? null : prefs.lang);
}

export function navigate(hash) {
  const next = targetHash(hash, isModal);
  if (next === '') {
    if (currentModal()) closeModal();
    else if (location.hash) location.hash = '';
  } else {
    location.hash = next;
  }
}

// The start error, in the page's words when they loaded, in plain text when they did not.
function showStartError(err, t) {
  console.error('mccontrol could not start:', err);
  const root = document.documentElement;
  if (root.hasAttribute('data-start-failed')) return;
  root.setAttribute('data-start-failed', '');
  const say = (key, fallback) => (t ? t(key) : fallback);
  const reason = h('textarea', { class: 'start-error-reason', readonly: true, rows: 3, 'aria-label': say('start.reasonLabel', 'The reason') });
  reason.value = err?.stack || String(err);
  $('main').replaceChildren(h('section', { class: 'start-error', 'aria-labelledby': 'start-error-title' },
    h('h1', { id: 'start-error-title' }, say('start.failed', 'mccontrol could not start in this browser')),
    h('p', {}, say('start.reason', 'The reason, to copy into a bug report:')),
    reason,
    h('p', {}, say('start.tryAgain', 'Try reloading the page, or open it in a private window.'))));
}

async function start() {
  let t = null;
  let lang = null;
  let version = { version: 'unknown' };
  let pendingUpdate = null;
  const main = $('main');

  const base = () => Object.freeze({
    t, lang, navigate, notify, announce,
    key: Object.freeze({ state: keyState, on: onKeyState }),
    prefs: Object.freeze({ current: currentPrefs, set: setPref, on: onPrefsChange }),
    displaySettings: () => displaySettings({ t }),
    modal: Object.freeze({ open: openModal, close: closeModal, current: currentModal }),
  });

  const drawFooter = () => {
    const update = pendingUpdate ? h('button', { type: 'button', class: 'link-button' }, t('update.reload')) : null;
    update?.addEventListener('click', pendingUpdate);
    $('footer-status').replaceChildren(
      t('app.version', { version: version.version }),
      update ? h('span', { class: 'update-ready' }, ' · ', t('update.ready'), ' ', update) : '');
    $('source-link').textContent = t('app.source');
  };

  const drawKey = () => {
    const { status, publicKeyHex } = keyState();
    setStatusItem('key', {
      word: status === 'unlocked' ? shortKey(publicKeyHex).slice(0, 8) : t(`key.${status}`),
      state: status === 'unlocked' ? 'ok' : status === 'locked' ? 'warn' : 'unknown',
      href: status === 'unlocked' ? '#setup/key' : '#unlock',
      label: status === 'unlocked' ? t('key.unlockedLabel', { key: shortKey(publicKeyHex) }) : t(`key.${status}Label`),
    });
  };

  let clockTimer = null;
  const drawClock = () => {
    setStatusItem('clock', { word: new Date().toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) });
    clearTimeout(clockTimer);
    clockTimer = setTimeout(drawClock, 60000 - (Date.now() % 60000));
  };

  // The shell's own keys, and the palette's (':' and Ctrl+K).
  let unbind = [];
  const bindShellKeys = () => {
    for (const u of unbind) u();
    unbind = [
      bindKey(',', { label: t('board.setup'), run: () => openModal('setup'), bar: true, order: 80 }),
      bindKey('?', { label: t('board.help'), run: () => openModal('help'), bar: true, order: 90 }),
      ...bindPaletteKeys(t),
    ];
  };

  // What the hash names: the board alone, or a modal in front of it.
  const route = ({ force = false } = {}) => {
    const p = parseHash(location.hash, isModal);
    if (p.kind === 'legacy') {
      history.replaceState(history.state, '', p.hash || location.pathname + location.search);
      route({ force });
      return;
    }
    if (p.kind === 'other') return;   // an in-page anchor such as #main
    if (gated()) {
      if (p.kind === 'board' || !GATE_OPEN.includes(p.name)) {
        if (p.kind === 'modal') gateReturn = location.hash;
        // The board's own entry stays depth 0, so leaving the gate walks back to it, not off the page.
        const state = p.kind === 'board' ? { ...(history.state || {}), mcDepth: history.state?.mcDepth ?? 0 } : history.state;
        history.replaceState(state, '', '#unlock');
        route({ force });
        return;
      }
    }
    if (p.kind === 'board') {
      routeModal('board');
      document.title = 'mccontrol';
      return;
    }
    routeModal({ name: p.name, args: p.args }, { force });
    // The gate's dialog cannot be closed: no Esc, no click outside (the close button is hidden).
    if (gated() && p.name === 'unlock') $('modal').setAttribute('closedby', 'none');
  };
  const applyGate = () => {
    const on = gated();
    document.documentElement.toggleAttribute('data-gate', on);
    for (const id of ['statusline', 'main', 'footer']) $(id).inert = on;
  };

  let titleKept = false;
  const relabel = async () => {
    lang = languageFor(currentPrefs());
    t = translator(await loadStrings(lang));
    useStrings(t);
    loadedStrings = t;
    document.documentElement.lang = lang;
    $('skip').textContent = t('app.skip');
    $('toasts').setAttribute('aria-label', t('app.messages'));
    $('statusline').setAttribute('aria-label', t('board.statusLine'));
    relabelFrame(t('app.close'));
    drawKey();
    drawClock();
    if (statusItems().find((i) => i.name === 'broker')?.shell !== false) {
      setStatusItem('broker', { word: t('tile.connecting'), state: 'unknown', shell: true });
    }
    drawStatusLine($('status-items'), t);
    bindShellKeys();
    drawKeyBar($('keys'), t);
    drawFooter();
    drawLayout();
    if (isDemo()) { const banner = await import('./demo/banner.js'); banner.drawBanner(t, { sending: !demoReadOnly() }); if (!titleKept) { titleKept = true; banner.keepTitle((key) => t(key)); if (demoReadOnly()) (await import('./demo/readonly.js')).closeSendControls((key) => t(key)); } }
    if (currentModal()) route({ force: true });
  };

  // The standard layout (W-29, the default) or the retro board; the switch is top right in both.
  let layout = null;
  let drawnScheme = currentPrefs().scheme;
  const drawLayout = () => {
    layout = currentPrefs().layout;
    $('statusline').querySelector('.layout-switch')?.remove();
    if (layout === 'retro') {
      $('statusline').append(layoutSwitch(base(), 'standard'));
      drawBoard(main, base());
    } else {
      drawStandard(main, base());
    }
  };

  migratePrefs();
  // The page's one keyring, before the board: the tiles then know whether there is a key. A
  // browser that refuses IndexedDB still gets the board, with "no key".
  try {
    if (isDemo()) {
      // The demo (W-39): an invented key in memory, unlocked by the demo, and an invented fleet.
      const demo = await import('./demo/start.js');
      await startKeySession(demo.demoKeyOptions());
      await demo.startDemo({ t: (key, vars) => t(key, vars) });
    } else {
      await startKeySession();
      startAutoRegistration();
    }
  } catch (err) { console.warn('key store unavailable:', err); }
  useFrame($('modal'), { ctxFor: base, closeLabel: 'Close' });
  await relabel();
  document.documentElement.setAttribute('data-started', '');
  mountUsbDebug();   // only with ?usbdebug=1 (W-25b)
  // Discovery, the area and the status refresh (W-20a, W-20b, W-20e): never in the way of the start.
  startAutomation({ t: () => t, notify }).catch((err) => console.warn('automatic discovery and refresh are off:', err));

  addEventListener('hashchange', () => route());
  $('modal').addEventListener('cancel', (e) => { if (gated() && currentModal()?.name === 'unlock') e.preventDefault(); });
  applyGate();
  // Past the gate, back at the board: open what was asked for before it.
  onModalChange((current) => {
    // Closing Help (or anything) behind the gate goes back to the gate, not to the board.
    if (!current && gated()) { queueMicrotask(() => { if (!currentModal() && gated()) route(); }); return; }
    if (current || !gateReturn) return;
    const back = gateReturn;
    gateReturn = null;
    location.hash = back;
  });
  route();
  document.addEventListener('keydown', (e) => handleKey(e, { modalOpen: Boolean(currentModal()) }));
  onKeysChange(() => drawKeyBar($('keys'), t));
  onStatusChange(() => drawStatusLine($('status-items'), t));
  onKeyState(drawKey);
  // Locking (auto-lock too) closes whatever is open behind the gate; unlocking leaves the way on
  // to the unlock screen, which goes on by itself (to the board and so to gateReturn, or to a new
  // key's tab).
  onKeyState(() => {
    const was = document.documentElement.hasAttribute('data-gate');
    applyGate();
    if (was === gated()) return;
    if (gated() || currentModal()?.name !== 'unlock') route({ force: true });
  });
  onPrefsChange((prefs) => {
    if (languageFor(prefs) !== lang) relabel();
    // The map follows the standard layout's colours; the rest follows the tokens by itself.
    else if (prefs.layout !== layout || (layout === 'standard' && prefs.scheme !== drawnScheme)) drawLayout();
    drawnScheme = prefs.scheme;
  });

  version = await readVersion();
  drawFooter();
  if (isDemo()) return;   // no offline copy and no update prompt from a demo page
  startUpdates({
    version: version.version,
    onWaiting: (apply) => {
      pendingUpdate = apply;
      drawFooter();
      notify(t('update.ready'), { kind: 'warning', actions: [{ label: t('update.reload'), run: apply }] });
    },
  }).catch((err) => notify(t('update.failed', { reason: err.message }), { kind: 'error' }));
}

if (typeof document !== 'undefined') start().catch((err) => showStartError(err, loadedStrings));
