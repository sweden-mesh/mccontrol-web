// Shared by the unlock, key, setup, settings and help screens: their stylesheet, a passphrase
// field with its Show toggle, the public key in readable groups, a copy button with its status
// line, and the QR code as SVG.
import { h } from '../dom.js';
import { encodeQr, qrPath } from '../../lib/qr.js';
import { utf8 } from '../../lib/bytes.js';
import { useStyles as useNodeStyles } from './node-kit.js';

const SVG = ['http:', '', 'www.w3.org', '2000', 'svg'].join('/');     // a namespace name, not fetched

// The screens' stylesheet (styles/key-screens.css is linked in index.html; node-kit.css too, for
// the shared field and dialog styles).
export function useStyles() {
  useNodeStyles();
}

let serial = 0;
export const uid = (prefix) => `${prefix}-${++serial}`;

// <label> + password input + "Show passphrase" checkbox (+ hint). `autocomplete` is
// 'new-password' for a passphrase being chosen and 'current-password' for one being typed.
export function passField(t, { label, autocomplete, name, hint = null, minlength = 8 }) {
  const id = uid('pass');
  const hintId = hint ? `${id}-hint` : null;
  const input = h('input', {
    type: 'password', id, name, autocomplete, required: true, minlength: String(minlength),
    spellcheck: 'false', autocapitalize: 'off', 'aria-describedby': hintId,
  });
  const show = h('input', { type: 'checkbox', id: `${id}-show` });
  show.addEventListener('change', () => { input.type = show.checked ? 'text' : 'password'; });
  const el = h('div', { class: 'field pass-field' },
    h('label', { for: id }, label),
    input,
    hint ? h('p', { class: 'hint-line', id: hintId }, hint) : null,
    h('label', { class: 'show-pass', for: `${id}-show` }, show, ' ', t('unlock.show')));
  return { el, input };
}

// "736EA54A AE6E1C76 …": the key in groups of eight, upper case.
export const groupedHex = (hex) => String(hex || '').toUpperCase().match(/.{1,8}/g)?.join(' ') ?? '';

// A visible "Copy" button and, beside it, the role=status line that says what happened (W-20h).
// The button says "Copied" for two seconds; the status line says it to a screen reader. When the
// browser refuses the clipboard, the text of `target` (an element) is selected so Ctrl+C copies
// it. `describedBy` names what is copied when several Copy buttons stand together.
export const COPIED_MS = 2000;

export function selectText(el) {
  const sel = globalThis.getSelection?.();
  if (!el || !sel) return false;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

export function copyButton(t, text, label = t('keyscreen.copy'), { target = null, describedBy = null } = {}) {
  const status = h('span', { class: 'copy-status', role: 'status' });
  const button = h('button', { type: 'button', class: 'tool copy-button', 'aria-describedby': describedBy }, label);
  let timer = null;
  let last = '';
  button.addEventListener('click', async () => {
    let message;
    let ok = false;
    try {
      await navigator.clipboard.writeText(typeof text === 'function' ? text() : text);
      message = t('keyscreen.copied');
      ok = true;
    } catch {
      message = selectText(target) ? t('setup.copySelected') : t('keyscreen.copyFailed');
    }
    if (message === last) message += ' ';        // VoiceOver skips a repeated message
    last = message;
    clearTimeout(timer);
    button.toggleAttribute('data-copied', ok);
    button.textContent = ok ? t('keyscreen.copied') : label;
    status.textContent = message;
    timer = setTimeout(() => {
      button.removeAttribute('data-copied');
      button.textContent = label;
      status.textContent = '';
    }, ok ? COPIED_MS : COPIED_MS * 2);
  });
  return h('span', { class: 'copy' }, button, status);
}

// The QR code of `text` as an SVG drawn here: dark modules on white, with the quiet zone.
export function qrSvg(text, label) {
  const { size, modules } = encodeQr(utf8(text));
  const svg = document.createElementNS(SVG, 'svg');
  const view = size + 8;
  svg.setAttribute('viewBox', `0 0 ${view} ${view}`);
  svg.setAttribute('class', 'qr');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = document.createElementNS(SVG, 'rect');
  for (const [k, v] of Object.entries({ width: view, height: view, class: 'qr-bg' })) bg.setAttribute(k, String(v));
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', qrPath(modules));
  path.setAttribute('transform', 'translate(4 4)');
  path.setAttribute('class', 'qr-fg');
  svg.append(bg, path);
  return svg;
}

// A paragraph for errors, announced when filled.
export const errorLine = () => h('p', { class: 'err', role: 'alert' });

// A Setup tab's section: an <h2> under the modal's <h1> that labels it, then the body.
export function tabScreen(id, title, ...children) {
  useStyles();
  return h('section', { 'aria-labelledby': `${id}-title`, class: `scr scr-${id}` },
    h('h2', { id: `${id}-title` }, title), ...children);
}
