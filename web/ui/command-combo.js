// The command field's suggestions (W-33c, W-33d): an own listbox in the page's style, in place of
// the native <datalist> whose popup no page can style. It opens when the field gets focus or a
// click, and narrows as one types (W-35c). The combobox pattern: the field is
// role=combobox with aria-expanded, aria-controls and aria-activedescendant; ↓ ↑ move, Enter takes
// the marked one (and does not send), Esc closes, a click takes one. The list is a popover in the
// top layer, placed under the field or above it when the field sits at the bottom of the screen,
// so no tile or dialog clips it.
//
// What it offers is the command table's lines (as the datalist did), only those the node's
// firmware has when its version is known (rules.admits, the table's per-command minimum, W-22);
// with no known version, every line, the list saying "version unknown". A command typed anyway
// still meets the normal checks before it is signed.
//
//   commandSuggestions(svc)              every line: [{ text, command }]
//   suggestionsFor(svc, lines, devices)  -> { lines, unknown }   (no DOM; tested)
//   attachCombo(ctx, input, { svc, devices })   devices() -> the nodes it would go to
import { h } from './dom.js';

let serial = 0;

export function commandSuggestions(svc) {
  const seen = new Set();
  const out = [];
  const add = (text, command) => { if (text && !seen.has(text) && !text.includes('<')) { seen.add(text); out.push({ text, command }); } };
  for (const c of svc.data.commands.table) {
    if (c.text === 'get' || c.text === 'set') { c.examples.forEach((e) => { const t = e.split(':')[0].trim(); add(t, t); }); continue; }
    if (c.kind === 'none') add(c.text, c.text);
    for (const choice of c.choices) add(`${c.text} ${choice}`.trim(), `${c.text} ${choice}`.trim());
    for (const ex of c.examples) add(`${c.text} ${ex}`, `${c.text} ${ex}`);
  }
  return out;
}

// Only what every node's known firmware admits; a node without a known version (or on the mesh
// road only, whose rules differ) filters nothing and makes the list say "version unknown".
export function suggestionsFor(svc, lines, devices) {
  // Known: a version whose features the rules can read (a lou image without them is not).
  const known = devices.filter((d) => d.ver && !svc.rules.deviceMeshOnly(d) && (!svc.rules.features || svc.rules.features(d.ver)));
  const unknown = !devices.length || known.length < devices.length;
  if (!known.length) return { lines, unknown: true };
  return { lines: lines.filter((l) => known.every((d) => svc.rules.admits(d.ver, l.command))), unknown };
}

export function attachCombo(ctx, input, { svc, devices }) {
  const id = `combo-${serial += 1}`;
  const all = commandSuggestions(svc);
  const note = h('li', { class: 'combo-note', role: 'presentation' });
  const list = h('ul', { class: 'combo-list', id: `${id}-list`, role: 'listbox', popover: 'manual', 'aria-label': ctx.t('combo.label') });
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', list.id);
  input.removeAttribute('list');
  let shown = [];
  let active = -1;

  const isOpen = () => list.matches(':popover-open');
  const close = () => {
    if (isOpen()) list.hidePopover();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };
  const place = () => {
    const r = input.getBoundingClientRect();
    const below = innerHeight - r.bottom;
    list.style.left = `${Math.max(4, r.left)}px`;
    list.style.width = `${Math.max(r.width, 200)}px`;
    const height = Math.min(list.scrollHeight, 288);
    if (below < height + 8 && r.top > below) { list.style.top = `${Math.max(4, r.top - height - 2)}px`; } else { list.style.top = `${r.bottom + 2}px`; }
  };
  const mark = (i) => {
    active = i;
    for (const [k, li] of [...list.querySelectorAll('[role="option"]')].entries()) li.setAttribute('aria-selected', String(k === i));
    const li = list.querySelector(`#${id}-o${i}`);
    if (li) { input.setAttribute('aria-activedescendant', li.id); li.scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
  };
  const take = (text) => {
    input.value = text;
    close();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  };
  const open = () => {
    const q = input.value.trim().toLowerCase();
    const { lines, unknown } = suggestionsFor(svc, all, devices());
    const starts = lines.filter((l) => l.text.toLowerCase().startsWith(q));
    const inside = q ? lines.filter((l) => !l.text.toLowerCase().startsWith(q) && l.text.toLowerCase().includes(q)) : [];
    shown = [...starts, ...inside].slice(0, 40);
    if (!shown.length || (shown.length === 1 && shown[0].text.toLowerCase() === q)) { close(); return; }
    note.textContent = unknown ? ctx.t('combo.unknown') : '';
    list.replaceChildren(...(unknown ? [note] : []), ...shown.map((l, i) => {
      const li = h('li', { id: `${id}-o${i}`, role: 'option', 'aria-selected': 'false', class: 'combo-option' }, l.text);
      li.addEventListener('pointerdown', (e) => { e.preventDefault(); take(l.text); });
      return li;
    }));
    // Beside the field (inside its dialog, which makes the rest of the page inert).
    if (!list.isConnected) input.after(list);
    if (!isOpen()) list.showPopover();
    input.setAttribute('aria-expanded', 'true');
    active = -1;
    input.removeAttribute('aria-activedescendant');
    place();
  };

  const opts = { signal: ctx.signal };
  input.addEventListener('input', (e) => { if (e.isTrusted) open(); }, opts);
  // Open on focus and on a click into the field too, not only after typing (W-35c).
  input.addEventListener('focus', () => open(), opts);
  input.addEventListener('pointerdown', () => { if (document.activeElement === input && !isOpen()) open(); }, opts);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen()) { open(); if (!isOpen()) return; }
      const n = shown.length;
      mark(e.key === 'ArrowDown' ? (active + 1) % n : (active <= 0 ? n - 1 : active - 1));
    } else if (e.key === 'Enter' && isOpen() && active >= 0) {
      e.preventDefault();
      take(shown[active].text);
    } else if (e.key === 'Enter') {
      close();                                    // Enter with no suggestion marked sends: the list goes away
    } else if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') close();
  }, opts);
  input.addEventListener('blur', () => close(), opts);
  // Sent by the button too: the list does not stay over an emptied field.
  addEventListener('submit', (e) => { if (e.target === input.form) close(); }, { ...opts, capture: true });
  addEventListener('resize', () => { if (isOpen()) place(); }, opts);
  addEventListener('scroll', () => { if (isOpen()) place(); }, { ...opts, capture: true, passive: true });
  ctx.signal.addEventListener('abort', () => { close(); list.remove(); }, { once: true });
  return { close };
}
