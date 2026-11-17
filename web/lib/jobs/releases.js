// The newest firmware release, from the GitHub releases of sweden-mesh/MeshCore-lou. The URL is
// in releases.json, so the third-party origin is data, not code; it must be in the CSP's
// connect-src. Asked at most once an hour per key: the answer is kept in the meta store.
// A failure (offline, rate limit, CSP) gives the last cached answer or null: the screens then
// show no "update available" mark, never a wrong one.
const CACHE_ID = 'releases';

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let conf = null;
export const releaseSource = (read = fetchJson) => {
  if (!conf) conf = read(new URL('./releases.json', import.meta.url).href);
  return conf;
};

// The newest release that is neither a draft nor a pre-release: { tag, name, url, published }.
export function newestRelease(list) {
  const r = (Array.isArray(list) ? list : []).find((x) => x && !x.draft && !x.prerelease && x.tag_name);
  return r ? { tag: r.tag_name, name: r.name || r.tag_name, url: r.html_url || null, published: r.published_at || null } : null;
}

// `meta` is stores.meta; `read(url)` fetches JSON (tests pass a fake); `source` the parsed
// releases.json (tests pass their own).
export async function latestRelease({ meta = null, read = fetchJson, now = () => Date.now(), source = null } = {}) {
  const where = source || await releaseSource();
  const cached = meta ? await meta.get(CACHE_ID) : null;
  if (cached && now() - cached.fetched < where.cache_secs * 1000) return cached.release;
  try {
    const release = newestRelease(await read(where.api));
    if (meta && release) await meta.set(CACHE_ID, { fetched: now(), release });
    return release;
  } catch {
    return cached?.release ?? null;
  }
}

// Is `release` newer than what the node runs? null when either is unknown.
export function updateAvailable(rules, version, release) {
  if (!version || !release) return null;
  const mine = rules.revision(version);
  const theirs = rules.revision(release.tag);
  if (mine === null || theirs === null) return null;
  return theirs > mine;
}
