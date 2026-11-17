// This device's display settings: colour scheme, phosphor theme, colour-blind palette, reduced
// motion and language. They belong to the device, not to a key, so they live in localStorage
// (keys "mccontrol.<name>"); ui/boot.js reads the same keys before the first paint. Storage may be
// blocked (private windows, site data off): every read and write tolerates that, and a choice then
// lasts for this page only.

export const CHOICES = Object.freeze({
  theme: ['system', 'light', 'dark'],
  phosphor: ['off', 'green', 'amber'],
  cvd: ['off', 'on'],
  motion: ['system', 'reduce'],
  lang: ['browser', 'sv', 'en'],
});

// The value each choice has when nothing is stored, and the stored form of each choice.
const STORED = { theme: { light: 'light', dark: 'dark' }, phosphor: { green: 'green', amber: 'amber' },
  cvd: { on: '1' }, motion: { reduce: 'off' }, lang: { sv: 'sv', en: 'en' } };

function safeStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function readPrefs(storage = safeStorage()) {
  const prefs = {};
  for (const [name, choices] of Object.entries(CHOICES)) {
    let raw = null;
    try { raw = storage ? storage.getItem(`mccontrol.${name}`) : null; } catch { /* blocked */ }
    const found = Object.entries(STORED[name]).find(([, stored]) => stored === raw);
    prefs[name] = found ? found[0] : choices[0];
  }
  return prefs;
}

export function writePref(name, value, storage = safeStorage()) {
  if (!CHOICES[name] || !CHOICES[name].includes(value)) throw new Error(`no setting ${name}=${value}`);
  const stored = STORED[name][value];
  try {
    if (stored) storage?.setItem(`mccontrol.${name}`, stored);
    else storage?.removeItem(`mccontrol.${name}`);
  } catch { /* blocked: this page only */ }
}

// The colour scheme the page should be pinned to, or 'light dark' to follow the system. The
// phosphor theme is always dark.
export function schemeFor(prefs) {
  if (prefs.phosphor !== 'off') return 'dark';
  return prefs.theme === 'system' ? 'light dark' : prefs.theme;
}

export function applyPrefs(prefs, doc = document) {
  const root = doc.documentElement;
  doc.querySelector('meta[name="color-scheme"]')?.setAttribute('content', schemeFor(prefs));
  const set = (attr, value) => (value ? root.setAttribute(attr, value) : root.removeAttribute(attr));
  set('data-phosphor', prefs.phosphor === 'off' ? null : prefs.phosphor);
  set('data-cvd', prefs.cvd === 'on' ? '1' : null);
  set('data-motion', prefs.motion === 'reduce' ? 'off' : null);
}

// Motion is reduced when the system asks for it or the setting does.
export function motionReduced(prefs = currentPrefs()) {
  return prefs.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Calls fn(prefs) after a change here or in another tab.
export function onPrefsChange(fn) {
  const local = (e) => fn(e.detail);
  const other = (e) => {
    if (e.key === null || String(e.key).startsWith('mccontrol.')) {
      current = readPrefs();
      const prefs = current;
      applyPrefs(prefs);
      fn(prefs);
    }
  };
  document.addEventListener('mccontrol:prefs', local);
  addEventListener('storage', other);
  return () => {
    document.removeEventListener('mccontrol:prefs', local);
    removeEventListener('storage', other);
  };
}

// The settings in force on this page: storage's, plus any choice made here that storage refused.
let current = null;
export function currentPrefs() {
  if (!current) current = readPrefs();
  return current;
}

export function setPref(name, value) {
  writePref(name, value);
  current = { ...currentPrefs(), [name]: value };
  const prefs = current;
  applyPrefs(prefs);
  document.dispatchEvent(new CustomEvent('mccontrol:prefs', { detail: prefs }));
  return prefs;
}
