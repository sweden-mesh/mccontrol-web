// What the command palette lists, and how it narrows the list (ui/modals/palette.js draws it).
// No DOM, so the tests run it.
import { helpKey } from './command-help.js';

// --- what the palette lists (no DOM) --------------------------------------------------------

// Every command of the table as the line to start from: a command that takes nothing as it is,
// each choice of a choice, and a command that takes text with a space after it (the value is
// typed in the send form, where its examples are shown).
export function commandLines(table) {
  const out = [];
  for (const c of table) {
    if (c.kind === 'choice' || c.kind === 'multi') {
      for (const choice of c.choices) out.push({ line: `${c.text} ${choice}`.trim(), command: c });
    } else {
      out.push({ line: c.kind === 'text' ? `${c.text} ` : c.text, command: c });
    }
  }
  return out;
}

// The target the palette sends to: the tagged nodes, else the selected one, else "choose".
export function targetFor({ selected: sel = null, tagged: tags = [] } = {}) {
  if (tags.length) return `n:${tags.join(',')}`;
  return sel ? `n:${sel}` : '-';
}

// "n:AB,CD" -> { kind: 'nodes', ids }, "g:x" -> { kind: 'group', id }, "a:se-jkp" -> { kind: 'area', area } (a county, by
// the scope the nodes name as their region home: one sealed command per node, never a broadcast)
export function parseTarget(arg) {
  const [kind, ...rest] = String(arg || '').split(':');
  const value = rest.join(':');
  if (kind === 'n' && value) return { kind: 'nodes', ids: value.split(',').filter(Boolean).map((x) => x.toUpperCase()) };
  if (kind === 'g' && value) return { kind: 'group', id: value };
  if (kind === 'a' && value) return { kind: 'area', area: value.toLowerCase() };
  return null;
}

export const runHash = (what, target, name = '') =>
  `#run/${what}/${encodeURIComponent(target || '-')}${name ? `/${encodeURIComponent(name)}` : ''}`;

// The entries: { id, kind, label, hint, hash } or { ..., action }.
export function buildEntries({ t, tabs = {}, table = [], sets = {}, groups = [], areas = [], key = { status: 'none' }, target = '-', modals = () => true }) {
  const out = [];
  const add = (e) => out.push({ id: `pal-${out.length}`, hint: '', ...e });
  for (const [name, tab] of Object.entries(tabs)) add({ kind: 'verb', label: t('palette.setupTab', { tab: t(tab.label) }), hash: `#setup/${name}` });
  if (modals('help')) {
    add({ kind: 'verb', label: t('palette.help'), hash: '#help' });
    add({ kind: 'verb', label: t('palette.codes'), hash: '#help/codes' });
  }
  if (modals('history')) add({ kind: 'verb', label: t('palette.history'), hash: '#history' });
  if (key.status === 'unlocked') add({ kind: 'verb', label: t('palette.lock'), action: 'lock' });
  if (target !== '-') add({ kind: 'verb', label: t('palette.sendTo'), hint: t('palette.sendToHint'), hash: runHash('cmd', target) });
  for (const { line, command } of commandLines(table)) {
    add({ kind: 'command', label: line, hint: t(helpKey(command)), hash: runHash('cmd', target, line), mono: true });
  }
  for (const name of Object.keys(sets)) add({ kind: 'set', label: t('palette.runSet', { set: name }), hint: sets[name].join(' · '), hash: runHash('set', target, name) });
  for (const g of groups) {
    add({ kind: 'group', label: t('palette.sendGroup', { group: g.id }), hint: t('groups.size', { n: g.members.length }), hash: runHash('cmd', `g:${g.id}`) });
    add({ kind: 'group', label: t('palette.editGroup', { group: g.id }), hash: `#setup/groups/${encodeURIComponent(g.id)}` });
  }
  for (const a of areas) add({ kind: 'area', label: t('palette.region', { region: a.label }), hint: t('palette.regionHint', { n: a.count }), hash: runHash('cmd', `a:${a.scope}`) });
  return out;
}

// The entries that match every word typed, best first: a label that starts with the query, then
// one that holds it whole, then the rest in their order. Case and accents are ignored.
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export function filterEntries(entries, query) {
  const q = fold(query).trim();
  if (!q) return entries;
  const words = q.split(/\s+/);
  const scored = [];
  entries.forEach((e, i) => {
    const label = fold(e.label);
    const all = `${label} ${fold(e.hint)}`;
    if (!words.every((w) => all.includes(w))) return;
    const score = label.startsWith(q) ? 0 : label.includes(q) ? 1 : words.every((w) => label.includes(w)) ? 2 : 3;
    scored.push([score, i, e]);
  });
  return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
}

