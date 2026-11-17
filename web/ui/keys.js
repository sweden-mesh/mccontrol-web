// The board's keys (W-20c): single keys as on the Monolith board, and the key bar that lists the
// ones meant to be seen. Anyone binds a key; the shell owns the listener. No DOM at module level.
//
//   bindKey(spec, { label, run, bar, order })  -> unbind()
//       spec   ',' '?' ':' '/' 'Enter' ' ' ... (KeyboardEvent.key), or 'ctrl+k' (Ctrl or Cmd)
//       label  the bar's word for it, already translated (rebind on a language change)
//       run    fn(event); the key's default action is prevented
//       bar    true to show it in the key bar (and as a button on a phone's bottom bar)
//       order  the bar's order, low first (Setup is 80, Help 90)
//   barKeys()          the bar's bindings, in order
//   onKeysChange(fn)   fn() after a bind or an unbind; returns unsubscribe
//   handleKey(event)   true when a binding took the event (the shell's keydown listener)
//
// A key does nothing while the focus is in a field, while a modal is open (the modal has the
// keyboard; Esc closes it), or with a modifier the spec does not name. A later binding of the
// same spec wins until it is unbound (a tile can take Enter while it has the selection).

const bindings = [];
const listeners = new Set();
let serial = 0;

const changed = () => { for (const fn of listeners) fn(); };

export function parseSpec(spec) {
  const parts = String(spec).split('+');
  const key = parts.length > 1 && parts.at(-1) === '' ? '+' : parts.pop();
  return { key: key.length === 1 ? key.toLowerCase() : key, ctrl: parts.includes('ctrl') };
}

export function matches(spec, e) {
  const s = parseSpec(spec);
  const key = e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key !== s.key) return false;
  if (s.ctrl) return Boolean(e.ctrlKey || e.metaKey) && !e.altKey;
  return !e.ctrlKey && !e.metaKey && !e.altKey;
}

export function bindKey(spec, { label = '', run, bar = false, order = 50 } = {}) {
  if (typeof run !== 'function') throw new Error(`key ${spec}: run must be a function`);
  const b = { spec, label, run, bar, order, at: ++serial };
  bindings.push(b);
  changed();
  return () => {
    const i = bindings.indexOf(b);
    if (i >= 0) { bindings.splice(i, 1); changed(); }
  };
}

export function barKeys() {
  const seen = new Set();
  return [...bindings].reverse().filter((b) => b.bar && !seen.has(b.spec) && seen.add(b.spec))
    .sort((a, b) => a.order - b.order || a.at - b.at);
}

export function onKeysChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

export function handleKey(e, { modalOpen = false } = {}) {
  if (e.defaultPrevented || e.isComposing || modalOpen) return false;
  if (e.target?.closest?.(EDITABLE)) return false;
  for (let i = bindings.length - 1; i >= 0; i -= 1) {
    const b = bindings[i];
    if (matches(b.spec, e)) {
      e.preventDefault();
      b.run(e);
      return true;
    }
  }
  return false;
}
