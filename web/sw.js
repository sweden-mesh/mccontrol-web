// The offline copy of one release (W-10). scripts/web-dist.mjs stamps VERSION, so a new release
// is a changed sw.js, which the browser installs beside the running one. Installing fetches every
// file listed in integrity.json, checks its SHA-256 against the list and refuses the release when
// one differs. The new release then waits until the page asks for it (ui/update.js, after the
// owner presses "Reload"); nothing activates on its own while an older release is in use.
const VERSION = 'dev';
const CACHE = `mccontrol-${VERSION}`;
// Not served as part of the app: the host's header file and this worker itself.
const SKIP = new Set(['_headers', 'sw.js']);

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

async function install() {
  const res = await fetch('integrity.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`integrity.json: HTTP ${res.status}`);
  const kept = res.clone();             // the list the files were checked against, not a second fetch
  const manifest = await res.json();
  if (manifest.version !== VERSION) throw new Error(`integrity.json is ${manifest.version}, not ${VERSION}`);
  const cache = await caches.open(CACHE);
  await Promise.all(Object.entries(manifest.files).filter(([path]) => !SKIP.has(path)).map(async ([path, sha]) => {
    // index.html is served as ./ (a static host redirects /index.html to /).
    const url = path === 'index.html' ? './' : path;
    const file = await fetch(url, { cache: 'reload' });
    if (!file.ok) throw new Error(`${path}: HTTP ${file.status}`);
    const got = hex(await crypto.subtle.digest('SHA-256', await file.clone().arrayBuffer()));
    if (got !== sha) throw new Error(`${path}: SHA-256 differs from integrity.json`);
    await cache.put(url, file);
  }));
  await cache.put('integrity.json', kept);
}

self.addEventListener('install', (event) => {
  event.waitUntil(install().catch(async (err) => {
    await caches.delete(CACHE);
    throw err;
  }));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    const first = !names.some((n) => n.startsWith('mccontrol-') && n !== CACHE);
    await Promise.all(names.filter((n) => n.startsWith('mccontrol-') && n !== CACHE).map((n) => caches.delete(n)));
    // A first install has no older release to replace: it may take the open pages at once.
    if (first) await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;   // brokers and Beacon pass through
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? './' : req;
    return (await cache.match(key, { ignoreSearch: req.mode === 'navigate' })) || fetch(req);
  })());
});
