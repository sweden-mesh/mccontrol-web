// Messages: toasts in one place on the page, and announcements for screen readers.
//
// notify(text, { kind, actions, timeout }) shows a toast in the "Messages" region (#toasts, a
// manual popover so it stays above dialogs, moved into an open modal dialog so it can be clicked) and announces it. kind 'info' disappears after
// `timeout` ms (default 10 s) unless the pointer or focus is in it; 'error' and 'warning' stay until
// closed. `actions` is a list of { label, run } buttons; every action must also be reachable
// somewhere else on the page (a toast can be missed). Returns a function that closes the toast.
//
// announce(text) says something to screen readers without showing it (ariaNotify where the
// browser has it, the #announce status region otherwise).
import { h } from './dom.js';

let strings = (key) => key;
export function useStrings(t) { strings = t; }

export function announce(text) {
  if (typeof document.ariaNotify === 'function') {
    document.ariaNotify(text);
    return;
  }
  const region = document.getElementById('announce');
  if (!region) return;
  region.textContent = '';
  // A new text node after a tick, so the same sentence twice is announced twice.
  setTimeout(() => { region.textContent = text; }, 50);
}

function region() {
  return document.getElementById('toasts');
}

// A modal dialog makes everything outside it inert, the top layer included: a toast shown over
// one could be read and not clicked. So the region lives inside the open modal dialog (the last
// one when several are open), and in the page again when none is.
export function placeToasts() {
  const box = region();
  if (!box) return;
  const host = [...document.querySelectorAll('dialog[open]')].filter((d) => d.matches(':modal')).at(-1) || document.body;
  const open = box.matches(':popover-open');
  if (box.parentNode === host && !open) return;
  if (open) box.hidePopover();
  if (box.parentNode !== host) host.append(box);
  if (box.children.length) box.showPopover();   // shown again: above a dialog opened after it
}
if (typeof document !== 'undefined') {
  // Neither event bubbles; both are seen on the way down.
  for (const type of ['close', 'toggle']) {
    document.addEventListener(type, (e) => { if (e.target instanceof HTMLDialogElement) placeToasts(); }, true);
  }
}

function syncOpen(box) {
  const open = box.matches(':popover-open');
  if (box.children.length && !open) box.showPopover();
  if (!box.children.length && open) box.hidePopover();
}

export function notify(text, { kind = 'info', actions = [], timeout = 10000 } = {}) {
  const box = region();
  if (!box) return () => {};
  const close = h('button', { type: 'button', class: 'toast-close' }, strings('app.close'));
  const toast = h('div', { class: `toast toast-${kind}` },
    h('p', { class: 'toast-text' }, text),
    actions.length ? h('div', { class: 'toast-actions' },
      actions.map(({ label, run }) => {
        const b = h('button', { type: 'button', class: 'button' }, label);
        b.addEventListener('click', () => { run(); remove(); });
        return b;
      })) : null,
    close);

  let timer = null;
  function remove() {
    if (!toast.isConnected) return;
    clearTimeout(timer);
    const hadFocus = toast.contains(document.activeElement);
    const next = toast.nextElementSibling || toast.previousElementSibling;
    toast.remove();
    syncOpen(box);
    if (hadFocus) (next?.querySelector('button') || document.getElementById('main')).focus();
  }
  close.addEventListener('click', remove);

  if (kind === 'info' && timeout > 0) {
    const arm = () => { clearTimeout(timer); timer = setTimeout(remove, timeout); };
    const hold = () => clearTimeout(timer);
    toast.addEventListener('pointerenter', hold);
    toast.addEventListener('pointerleave', () => { if (!toast.contains(document.activeElement)) arm(); });
    toast.addEventListener('focusin', hold);
    toast.addEventListener('focusout', (e) => { if (!toast.contains(e.relatedTarget)) arm(); });
    arm();
  }

  box.append(toast);
  placeToasts();
  syncOpen(box);
  announce(actions.length ? `${text} ${strings('app.actionsAvailable')}` : text);
  return remove;
}
