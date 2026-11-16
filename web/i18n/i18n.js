// Language: the browser's first language we have, else Swedish. A later setting (W-6) may
// override it per device. Strings live in sv.json and en.json with the same keys; a key
// missing from one is a bug the tests catch.

export const LANGUAGES = ['sv', 'en'];
export const FALLBACK = 'sv';

export function pickLanguage(preferred = [], override = null) {
  if (override && LANGUAGES.includes(override)) return override;
  for (const tag of preferred) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (LANGUAGES.includes(base)) return base;
  }
  return FALLBACK;
}

// `strings` is the parsed JSON of one language; `t(key, vars)` fills {name} from vars and
// returns the key itself when the string is missing, so a gap shows instead of breaking.
export function translator(strings) {
  return (key, vars = {}) => {
    const text = strings[key];
    if (text === undefined) return key;
    return text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
  };
}

export async function loadStrings(lang) {
  const res = await fetch(new URL(`./${lang}.json`, import.meta.url));
  if (!res.ok) throw new Error(`strings ${lang}: HTTP ${res.status}`);
  return res.json();
}
