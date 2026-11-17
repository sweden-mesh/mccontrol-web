// This device's display settings: the theme and the language. They belong to the device, not to
// a key, so they live in localStorage (keys "mccontrol.<name>"); ui/boot.js reads the same keys
// before the first paint. Storage may be blocked (private windows, site data off): every read and
// write tolerates that, and a choice then lasts for this page only.
//
// One theme setting since W-20f: amber (the default), green, dark, light. Before it there were
// three settings (colours system/light/dark, terminal screen off/green/amber, colour-blind on/off)
// and a reduced-motion option. migratePrefs() maps them once (boot.js does the same before paint):
// a terminal screen wins, then light or dark, else amber; the colour-blind and motion keys go.

export const CHOICES = Object.freeze({
  theme: ['amber', 'green', 'dark', 'light'],
  lang: ['browser', 'sv', 'en'],
});

// The keys of the settings that no longer exist, removed by the migration.
export const RETIRED = Object.freeze(['phosphor', 'cvd', 'motion']);

function safeStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

function read(storage, name) {
  try { return storage ? storage.getItem(`mccontrol.${name}`) : null; } catch { return null; }
}

// The theme the stored settings name, old or new: what boot.js applies before the first paint.
export function themeFrom(get) {
  const phosphor = get('phosphor');
  if (phosphor === 'green' || phosphor === 'amber') return phosphor;
  const theme = get('theme');
  return CHOICES.theme.includes(theme) ? theme : 'amber';
}

// Rewrites old settings into the new one, once. Safe to run on every load.
export function migratePrefs(storage = safeStorage()) {
  if (!storage || !RETIRED.some((name) => read(storage, name) !== null)) return;
  try {
    const theme = themeFrom((name) => read(storage, name));
    if (theme === 'amber') storage.removeItem('mccontrol.theme');
    else storage.setItem('mccontrol.theme', theme);
    for (const name of RETIRED) storage.removeItem(`mccontrol.${name}`);
  } catch { /* blocked: boot.js still reads the old keys */ }
}

export function readPrefs(storage = safeStorage()) {
  const get = (name) => read(storage, name);
  const lang = get('lang');
  return { theme: themeFrom(get), lang: CHOICES.lang.includes(lang) && lang !== 'browser' ? lang : 'browser' };
}

export function writePref(name, value, storage = safeStorage()) {
  if (!CHOICES[name] || !CHOICES[name].includes(value)) throw new Error(`no setting ${name}=${value}`);
  try {
    if (value === CHOICES[name][0]) storage?.removeItem(`mccontrol.${name}`);
    else storage?.setItem(`mccontrol.${name}`, value);
    if (name === 'theme') for (const old of RETIRED) storage?.removeItem(`mccontrol.${old}`);
  } catch { /* blocked: this page only */ }
}

// The colour scheme the browser's own parts (scroll bars, form controls) should use.
export function schemeFor(prefs) {
  return prefs.theme === 'light' ? 'light' : 'dark';
}

export function applyPrefs(prefs, doc = document) {
  const root = doc.documentElement;
  doc.querySelector('meta[name="color-scheme"]')?.setAttribute('content', schemeFor(prefs));
  root.setAttribute('data-theme', prefs.theme);
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
