// The command palette (W-20d, W-20j, proposal §2.4): ':' or Ctrl+K on the board. Every verb
// (Setup's tabs, Help, History, lock and unlock), every command of the exported table (with what
// it does), the command sets, the groups and "every node in a region". Type to narrow; arrows and
// Enter, or a click, choose.
//
// The palette never signs or sends. A command or a set opens the "run" modal
// ("#run/cmd/<target>/<command>", "#run/set/<target>/<set>"), which is the send form of the old
// screens: it checks the command against the deny list and the node's firmware before signing,
// asks before a command that takes something away, and asks for every region-wide send with the
// region and the number of nodes named. <target> is "n:ID,ID" (nodes), "g:<group>", "r:<region>"
// or "-" (choose there); the palette takes the tagged nodes, else the selected one.
//
// A non-modal <dialog popover>: the board stays as it is, a click outside or Esc closes it.
import { h } from '../dom.js';
import { load } from '../../lib/data/load.js';
import { isModal, currentModal } from '../modal.js';
import { bindKey } from '../keys.js';
import { selected, tagged } from '../board-state.js';
import { keyState } from '../key-state.js';
import { keyring } from '../screens/key-session.js';
import { services } from '../screens/node-services.js';
import { byName, field, nameOf, put, withServices } from '../screens/node-kit.js';
import { sendPanel } from '../screens/send.js';
import { runSetPanel } from '../screens/sets.js';
import { useStyles } from '../screens/key-kit.js';
import { TABS } from './setup.js';
import { buildEntries, filterEntries, parseTarget, targetFor } from './palette-entries.js';


// --- the palette ------------------------------------------------------------------------------

let palette = null;     // { dialog, input, list, count, entries, shown, active }
let strings = (k) => k;

async function gather() {
  const key = keyState();
  const target = targetFor({ selected: selected(), tagged: tagged() });
  let table = [];
  try { table = (await load('commands')).table; } catch { /* no table: verbs only */ }
  let sets = {}; let groups = []; let regions = [];
  if (key.publicKeyHex) {
    try {
      const svc = await services(key.publicKeyHex);
      sets = await svc.stores.sets.list();
      groups = (await svc.stores.groups.list()).filter((g) => g.members.length);
      const devices = await svc.stores.devices.list();
      const counts = new Map();
      for (const d of devices) if (d.region) counts.set(d.region, (counts.get(d.region) || 0) + 1);
      regions = [...counts].sort().map(([region, count]) => ({ region, count }));
    } catch { /* the stores refused: commands and verbs only */ }
  }
  return buildEntries({ t: strings, tabs: TABS, table, sets, groups, regions, key, target, modals: isModal });
}

function frame() {
  if (palette) return palette;
  const input = h('input', {
    type: 'text', id: 'palette-input', role: 'combobox', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false',
    'aria-autocomplete': 'list', 'aria-expanded': 'true', 'aria-controls': 'palette-list', enterkeyhint: 'go',
  });
  const list = h('ul', { id: 'palette-list', role: 'listbox', class: 'palette-list' });
  const count = h('p', { class: 'palette-count', role: 'status' });
  const title = h('h2', { id: 'palette-title', class: 'palette-title' });
  const label = h('label', { for: 'palette-input', class: 'visually-hidden' });
  const close = h('button', { type: 'button', class: 'tool palette-close' });
  const dialog = h('dialog', { class: 'palette', popover: 'auto', 'aria-labelledby': 'palette-title' },
    h('div', { class: 'palette-head' }, title, close), label, input, count, list);
  palette = { dialog, input, list, count, title, label, close, entries: [], shown: [], active: 0 };
  close.addEventListener('click', () => dialog.hidePopover());
  input.addEventListener('input', () => { palette.active = 0; draw(); });
  input.addEventListener('keydown', onKey);
  list.addEventListener('click', (e) => {
    const li = e.target.closest('[role="option"]');
    if (li) choose(palette.shown.find((x) => x.id === li.id));
  });
  document.body.append(dialog);
  return palette;
}

function draw() {
  const p = palette;
  p.shown = filterEntries(p.entries, p.input.value);
  p.active = Math.max(0, Math.min(p.active, p.shown.length - 1));
  p.list.replaceChildren(...p.shown.map((e, i) => h('li', {
    id: e.id, role: 'option', class: `palette-row palette-${e.kind}`, 'aria-selected': String(i === p.active),
  }, h('span', { class: e.mono ? 'palette-label mono' : 'palette-label', translate: e.mono ? 'no' : null }, e.label),
  e.hint ? h('span', { class: 'palette-hint' }, e.hint) : null)));
  const active = p.shown[p.active];
  if (active) p.input.setAttribute('aria-activedescendant', active.id); else p.input.removeAttribute('aria-activedescendant');
  p.count.textContent = p.shown.length ? strings('palette.count', { n: p.shown.length }) : strings('palette.none');
}

function move(by) {
  const p = palette;
  if (!p.shown.length) return;
  p.active = (p.active + by + p.shown.length) % p.shown.length;
  for (const li of p.list.children) li.setAttribute('aria-selected', String(li.id === p.shown[p.active].id));
  p.input.setAttribute('aria-activedescendant', p.shown[p.active].id);
  document.getElementById(p.shown[p.active].id)?.scrollIntoView({ block: 'nearest' });
}

function onKey(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); } else if (e.key === 'Enter') {
    e.preventDefault();
    choose(palette.shown[palette.active]);
  }
}

function choose(entry) {
  if (!entry) return;
  palette.dialog.hidePopover();
  if (entry.action === 'lock') { keyring()?.lock(); return; }
  if (entry.hash) location.hash = entry.hash;
}

export async function openPalette() {
  if (currentModal()) return;
  const p = frame();
  p.title.textContent = strings('palette.title');
  p.label.textContent = strings('palette.inputLabel');
  p.input.placeholder = strings('palette.placeholder');
  p.list.setAttribute('aria-label', strings('palette.title'));
  p.close.textContent = strings('app.close');
  p.input.value = '';
  p.entries = [];
  p.active = 0;
  draw();
  if (!p.dialog.matches(':popover-open')) p.dialog.showPopover();
  p.input.focus();
  p.entries = await gather();
  if (p.dialog.matches(':popover-open')) draw();
}

// ui/app.js: the palette's keys, rebound on a language change. Returns the unbind functions.
export function bindPaletteKeys(t) {
  strings = t;
  const run = () => { openPalette(); };
  return [
    bindKey(':', { label: t('palette.key'), run, bar: true, order: 70 }),
    bindKey('ctrl+k', { label: t('palette.key'), run }),
  ];
}

// --- the run modal: one command or one set, to a target --------------------------------------

function targetOptions(ctx, devices, groups, regions) {
  return [
    h('option', { value: '-' }, ctx.t('sets.pickTarget')),
    h('optgroup', { label: ctx.t('setup.run.nodes') }, devices.map((d) => h('option', { value: `n:${d.node}` }, nameOf(d)))),
    groups.length ? h('optgroup', { label: ctx.t('setup.tab.groups') }, groups.map((g) => h('option', { value: `g:${g.id}` }, `${g.id} (${g.members.length})`))) : null,
    regions.length ? h('optgroup', { label: ctx.t('setup.run.regions') }, regions.map((r) => h('option', { value: `r:${r}` }, ctx.t('palette.region', { region: r })))) : null,
  ];
}

export function renderRun(ctx) {
  useStyles();
  const what = ctx.args[0] === 'set' ? 'set' : 'cmd';
  const body = h('div', {});
  const el = h('section', { 'aria-labelledby': 'run-title', class: 'scr scr-run' },
    h('h1', { id: 'run-title', class: 'modal-title' }, ctx.t(what === 'set' ? 'setup.run.setTitle' : 'setup.run.cmdTitle')), body);
  withServices(ctx, body, async (svc) => {
    const devices = (await svc.stores.devices.list()).sort(byName(ctx.lang));
    const groups = (await svc.stores.groups.list()).filter((g) => g.members.length);
    const sets = await svc.stores.sets.list();
    const regions = [...new Set(devices.map((d) => d.region).filter(Boolean))].sort();
    if (!devices.length) { put(body, h('p', {}, ctx.t('send.noNodes'))); return; }
    const named = parseTarget(ctx.args[1]);
    const several = named?.kind === 'nodes' && named.ids.length > 1;
    const select = h('select', {}, targetOptions(ctx, devices, groups, regions),
      several ? h('option', { value: ctx.args[1] }, ctx.t('setup.run.tagged', { n: named.ids.length })) : null);
    select.value = named ? ctx.args[1] : '-';
    if (select.value !== (named ? ctx.args[1] : '-')) select.value = '-';
    const slot = h('div', {});
    let command = what === 'cmd' ? (ctx.args[2] || '') : '';
    const draw = () => {
      command = slot.querySelector('.cmd-input')?.value ?? command;
      const p = parseTarget(select.value);
      let target = null;
      if (p?.kind === 'nodes') target = { devices: devices.filter((d) => p.ids.includes(d.node)) };
      if (p?.kind === 'group') {
        const g = groups.find((x) => x.id === p.id);
        if (g) target = { group: g, devices: devices.filter((d) => g.members.includes(d.node)) };
      }
      if (p?.kind === 'region') target = { region: p.region, devices: devices.filter((d) => d.region === p.region) };
      if (!target?.devices.length) { put(slot, h('p', { class: 'muted' }, ctx.t('send.pickTarget'))); return; }
      put(slot,
        target.region ? h('p', { class: 'warn-text' }, ctx.t('setup.run.regionWarn', { region: target.region, n: target.devices.length })) : null,
        what === 'set' ? runSetPanel(ctx, svc, target, sets, { initial: ctx.args[2] || '' }) : sendPanel(ctx, svc, target, { initial: command }));
      slot.querySelector('.cmd-input, select')?.focus();
    };
    select.addEventListener('change', draw, { signal: ctx.signal });
    put(body, field(ctx.t('sets.target'), select), slot);
    draw();
  });
  return el;
}

export const runModal = { name: 'run', title: 'setup.run.cmdTitle', render: renderRun };
