// A node row's full status on hover and on keyboard focus (W-35b): every reason on its own line
// (refused, not heard, battery, update available…) or "All OK". One tooltip for the page, a manual
// popover in the top layer (no list or tile clips it), placed by script under the row or over it
// at the bottom of the screen. It only shows: the row's click is unchanged. Esc hides it; the
// pointer may move onto it. A screen reader gets the same text as the row's description (a hidden
// span), not the popover. On touch there is no hover: the node's detail says the same.
//
//   statusLines(ctx, status)          [{ state, text }]   (no DOM; tested)
//   statusHint(ctx, button, status)   wires the row button, returns the hidden description span
//   hintGone()                        after a list redraw: hide a tooltip whose row is gone
import { h } from './dom.js';
import { GLYPH } from './statusline.js';
import { ALERT_KINDS as ALERT } from './tiles/data.js';

let tip = null;
let owner = null;
let timer = null;
let serial = 0;

const upper = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function statusLines(ctx, status) {
  const reasons = status?.reasons || [];
  if (reasons.length) return reasons.map((r) => ({ state: ALERT.has(r.kind) ? 'alert' : 'warn', text: upper(ctx.t(`dash.att.${r.kind}`, r.vars)) }));
  return [status?.state === 'unknown' ? { state: 'unknown', text: ctx.t('hint.notKnown') } : { state: 'ok', text: ctx.t('hint.allOk') }];
}

function hide() {
  clearTimeout(timer);
  timer = null;
  if (tip?.matches(':popover-open')) tip.hidePopover();
  owner = null;
}

export function hintGone() {
  if (owner && !owner.isConnected) hide();
}

function place(button) {
  const r = button.getBoundingClientRect();
  const height = tip.offsetHeight;
  const below = innerHeight - r.bottom;
  tip.style.left = `${Math.max(4, Math.min(r.left + 24, innerWidth - tip.offsetWidth - 4))}px`;
  tip.style.top = `${below < height + 8 && r.top > below ? Math.max(4, r.top - height - 2) : r.bottom + 2}px`;
}

function ensureTip() {
  if (tip?.isConnected) return tip;
  tip = h('div', { class: 'status-hint', popover: 'manual', 'aria-hidden': 'true' });
  tip.addEventListener('pointerenter', () => clearTimeout(timer));
  tip.addEventListener('pointerleave', () => { timer = setTimeout(hide, 150); });
  document.body.append(tip);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && owner) hide(); });
  addEventListener('scroll', hide, { capture: true, passive: true });
  return tip;
}

function show(ctx, button, lines) {
  clearTimeout(timer);
  const t = ensureTip();
  t.replaceChildren(...lines.map((l) => h('p', { 'data-state': l.state },
    h('span', { class: 'glyph' }, GLYPH[l.state] || GLYPH.unknown), ' ', l.text)));
  owner = button;
  if (!t.matches(':popover-open')) t.showPopover();
  place(button);
}

export function statusHint(ctx, button, status) {
  const lines = statusLines(ctx, status);
  const id = `status-hint-${serial += 1}`;
  const desc = h('span', { class: 'visually-hidden', id }, lines.map((l) => l.text).join('. '));
  button.setAttribute('aria-describedby', id);
  const later = () => { clearTimeout(timer); timer = setTimeout(() => { if (button.isConnected) show(ctx, button, lines); }, 400); };
  button.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') later(); });
  button.addEventListener('pointerleave', () => { clearTimeout(timer); if (owner === button) timer = setTimeout(hide, 150); });
  button.addEventListener('focus', () => { if (button.matches(':focus-visible')) show(ctx, button, lines); });
  button.addEventListener('blur', () => { if (owner === button) hide(); });
  button.addEventListener('click', () => { if (owner === button) hide(); });
  ctx.signal?.addEventListener('abort', () => { if (owner === button || !owner?.isConnected) hide(); }, { once: true });
  return desc;
}
