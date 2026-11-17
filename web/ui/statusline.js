// The header's status line (W-20c): the few states that gate everything, each a glyph and a
// word, never colour alone. The shell fills `key` and `clock`; the STATUS tile's owner fills
// `broker` and the discovery/area work fills `area`. No DOM here; ui/board.js draws it.
//
//   setStatusItem(name, { word, state, href, label })   name: 'broker' | 'key' | 'area' | 'clock'
//       word   the short text after the name ("ok", "unlocked 14 m", "Jönköpings län")
//       state  'ok' | 'warn' | 'alert' | 'unknown' | null (no glyph)
//       href   optional: the item is a link (e.g. '#unlock')
//       label  optional: the accessible name, when the visible words are too short
//       (the shell's own placeholder for an item carries shell: true; any other setter replaces it)
//   statusItems()        [{ name, word, state, href, label }] in the line's order
//   onStatusChange(fn)   returns unsubscribe
//   GLYPH                the status glyphs, shared with the tiles: ● ok, ▲ warn, ✕ alert, ? unknown

export const GLYPH = Object.freeze({ ok: '●', warn: '▲', alert: '✕', unknown: '?' });
export const ORDER = Object.freeze(['broker', 'key', 'area', 'clock']);

const items = new Map();
const listeners = new Set();

export function setStatusItem(name, item) {
  if (!ORDER.includes(name)) throw new Error(`no status item ${name}`);
  items.set(name, Object.freeze({ name, word: '', state: null, href: null, label: null, shell: false, ...item }));
  for (const fn of listeners) fn();
}

export const statusItems = () => ORDER.filter((n) => items.has(n)).map((n) => items.get(n));

export function onStatusChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
