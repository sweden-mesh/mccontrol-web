// The modal frame (W-20d): everything that is not the board opens in front of it, in one native
// <dialog> opened with showModal(). The browser gives focus, the inert page, Esc and the back
// gesture; nothing here traps focus or listens for Esc. Each modal has a hash ("#node/4AC61A7F",
// "#setup/key"), so a link opens it and the browser's Back closes it. On a phone the dialog is a
// full-screen sheet (styles/app.css).
//
// The API, for anyone:
//   registerModal({ name, title, render, closedby })
//       name      the hash's first part: [a-z][a-z0-9-]*
//       title     an i18n key: the window title when the content has no heading
//       render    fn(ctx) -> one element. Its first heading names the dialog (aria-labelledby).
//       closedby  'any' (a click outside closes it too: help, a result) or 'closerequest'
//                 (the default: Esc and Back only, for anything with a form)
//       barTitle  true: the content's first heading moves into the title bar (W-32: Unlock)
//       barHelp   true: a "?" button at the right of the title bar opens Help (W-32)
//   openModal(name, ...args)    go to "#name/args": the modal opens, Back closes it
//   closeModal()                close the open modal and go back to the board
//   currentModal()              { name, args } or null
//   onModalChange(fn)           fn(current) after a modal opens, changes or closes
//   isModal(name)
//
// What render(ctx) gets: the shell's ctx (t, lang, notify, announce, key, prefs, navigate,
// displaySettings, modal), plus
//   route        the modal's name;  args  the hash's other parts, decoded
//   signal       aborts when the modal closes or shows something else: stop timers and listeners
//   close()      the same as closeModal()
//
// The shell (ui/app.js) calls routeModal() on every hash change; nobody else needs to.
import { h } from './dom.js';
import { isDemo } from './demo/mode.js';
import { modalHash } from './routes.js';

const modals = new Map();
const listeners = new Set();
let shown = null;             // { name, args, leave: AbortController }
let internalClose = false;
let toBoard = false;          // closing: walking back to the entry before the first modal
let lastDepth = -1;           // the depth of the history entry routed last (-1: none yet)
let frame = null;             // { dialog, body, closeButton, ctxFor }

export function registerModal(def) {
  if (!/^[a-z][a-z0-9-]*$/.test(def?.name || '')) throw new Error(`a modal needs a name: ${def?.name}`);
  if (typeof def.render !== 'function') throw new Error(`modal ${def.name}: render must be a function`);
  if (modals.has(def.name)) throw new Error(`modal ${def.name} is registered twice`);
  modals.set(def.name, Object.freeze({ closedby: 'closerequest', ...def }));
}

export const isModal = (name) => modals.has(name);
export const modalNames = () => [...modals.keys()];
export const currentModal = () => (shown ? { name: shown.name, args: [...shown.args] } : null);

export function onModalChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const tell = () => { const c = currentModal(); for (const fn of listeners) fn(c); };

export function openModal(name, ...args) {
  if (!isModal(name)) throw new Error(`no modal ${name}`);
  location.hash = modalHash(name, args);
}

// Back to the board: walk back over the modal entries this visit pushed, so Back afterwards
// leaves the page instead of reopening the modal; a modal the page was opened on is replaced.
export function closeModal() {
  if (!shown) return;
  const depth = history.state?.mcDepth || 0;
  if (depth > 0) {
    toBoard = true;
    history.go(-depth);
    // The walk back must end at the board. If the browser has no such entry (nothing happens), or
    // the walk lands somewhere unexpected, close here: a flag left set would keep every later
    // modal from opening.
    setTimeout(() => {
      if (!toBoard) return;
      toBoard = false;
      history.replaceState(null, '', location.pathname + location.search);
      hideFrame();
    }, 500);
  } else {
    history.replaceState(null, '', location.pathname + location.search);
    hideFrame();
  }
}

// ui/app.js: the dialog and how to build a modal's ctx.
export function useFrame(dialog, { ctxFor, closeLabel }) {
  const closeButton = h('button', { type: 'button', class: 'tool modal-close' }, closeLabel);
  const body = h('div', { class: 'modal-body' });
  const bar = h('div', { class: 'modal-bar' }, closeButton);
  dialog.replaceChildren(bar, body);
  closeButton.addEventListener('click', () => dialog.close());
  // Esc, Back on a phone, a click outside (closedby="any") or the close button: the user closed it.
  dialog.addEventListener('close', () => {
    if (internalClose) { internalClose = false; return; }
    closeModal();
  });
  frame = { dialog, body, bar, closeButton, ctxFor };
}

export function relabelFrame(closeLabel) {
  if (frame) frame.closeButton.textContent = closeLabel;
}

function hideFrame() {
  if (!shown) return;
  shown.leave.abort();
  shown = null;
  if (frame?.dialog.open) { internalClose = true; frame.dialog.close(); }
  frame?.body.replaceChildren();
  tell();
}

function stampDepth(isModalEntry) {
  let depth = history.state?.mcDepth;
  if (depth === undefined) {
    depth = isModalEntry ? Math.max(lastDepth, -1) + 1 : 0;
    history.replaceState({ ...(history.state || {}), mcDepth: depth }, '');
  }
  lastDepth = depth;
  return depth;
}

// Draws what the hash names. kind: 'board' or { name, args } of a registered modal.
export function routeModal(target, { force = false } = {}) {
  if (target === 'board') {
    stampDepth(false);
    toBoard = false;
    hideFrame();
    return null;
  }
  const depth = stampDepth(true);
  if (toBoard) {
    // Walking back reached the modal the page was opened on: replace it with the board.
    // Whatever entry the walk reached, it ends here: the modal there is replaced with the board.
    toBoard = false;
    history.replaceState(null, '', location.pathname + location.search);
    hideFrame();
    return null;
  }
  const { name, args } = target;
  const same = shown && shown.name === name && shown.args.join('/') === args.join('/');
  if (same && !force) return shown;
  const def = modals.get(name);
  shown?.leave.abort();
  const leave = new AbortController();
  shown = { name, args, leave };
  const ctx = Object.freeze({ ...frame.ctxFor(), route: name, args, signal: leave.signal, close: closeModal });
  const content = def.render(ctx);
  frame.body.replaceChildren(content);
  const heading = frame.body.querySelector('h1, h2');
  // The title bar: the heading (barTitle), a "?" for Help (barHelp), the close button (W-32).
  const help = def.barHelp ? h('button', { type: 'button', class: 'tool modal-help', 'aria-label': ctx.t('nav.help'), title: ctx.t('nav.help') }, '?') : null;
  help?.addEventListener('click', () => { location.hash = '#help'; });
  heading?.classList.toggle('modal-bar-title', Boolean(def.barTitle));
  frame.bar.replaceChildren(...[isDemo() ? h('span', { class: 'demo-tag' }, ctx.t('demo.label')) : null, def.barTitle ? heading : null, help, frame.closeButton].filter(Boolean));
  if (heading) {
    heading.id ||= `modal-title-${name}`;
    frame.dialog.setAttribute('aria-labelledby', heading.id);
  } else {
    frame.dialog.removeAttribute('aria-labelledby');
    frame.dialog.setAttribute('aria-label', ctx.t(def.title));
  }
  frame.dialog.dataset.modal = name;
  frame.dialog.setAttribute('closedby', def.closedby);
  document.title = `${heading?.textContent || ctx.t(def.title)} · mccontrol`;
  if (!frame.dialog.open) {
    frame.dialog.showModal();
    raiseToasts();
  } else {
    frame.body.scrollTop = 0;
    frame.closeButton.focus();
  }
  tell();
  return shown;
}

// Messages are a popover in the top layer; one shown before the dialog would sit under it.
function raiseToasts() {
  const box = document.getElementById('toasts');
  if (box?.matches(':popover-open')) { box.hidePopover(); box.showPopover(); }
}
