// The behaviour exported from the Python package (python -m mccontrol.webexport), loaded once.
// The JSON files beside this module are generated: never edit them by hand.

export const NAMES = ['brokers', 'cautions', 'commands', 'denylist', 'facts', 'firmware', 'help',
  'protocol', 'results', 'areas'];

const cache = new Map();

// `read(url)` returns the parsed JSON; the default fetches it (same origin, so CSP 'self').
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export function load(name, read = fetchJson) {
  if (!NAMES.includes(name)) throw new Error(`no data file ${name}`);
  if (!cache.has(name)) cache.set(name, read(new URL(`./${name}.json`, import.meta.url)));
  return cache.get(name);
}

export async function loadAll(read = fetchJson) {
  const entries = await Promise.all(NAMES.map(async (n) => [n, await load(n, read)]));
  return Object.fromEntries(entries);
}
