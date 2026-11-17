// The offline copy and its updates (W-10). sw.js keeps one release of the app; a new release is
// installed beside it and waits. The page then says so, and the owner chooses when to switch:
// never a silent swap under someone in the middle of a send.
//
// version.json is "dev" in the repository and stamped by scripts/web-dist.mjs for a deploy or a
// release zip; a dev copy registers no service worker, so a local server always serves the files
// as they are on disk.

// register() is a Trusted Types sink (a script URL). The policy accepts this one URL only.
const policy = globalThis.trustedTypes?.createPolicy('mccontrol-sw', {
  createScriptURL(url) {
    if (url !== 'sw.js') throw new TypeError(`not the service worker: ${url}`);
    return url;
  },
});

export async function readVersion() {
  try {
    const res = await fetch('version.json', { cache: 'no-store' });
    if (res.ok) return await res.json();
  } catch { /* offline and not cached: the version is unknown */ }
  return { version: 'unknown' };
}

// onWaiting(apply) is called when a new release has installed and waits; apply() switches to it
// and reloads the page.
export async function startUpdates({ version, onWaiting }) {
  if (version === 'dev' || !('serviceWorker' in navigator)) return null;
  const url = policy ? policy.createScriptURL('sw.js') : 'sw.js';
  const reg = await navigator.serviceWorker.register(url, { scope: './', updateViaCache: 'none' });

  let reloading = false;
  const apply = (worker) => () => {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloading) { reloading = true; location.reload(); }
    });
    worker.postMessage({ type: 'skip-waiting' });
  };
  const offer = (worker) => {
    // The first install has nothing to replace: it simply serves the next visit.
    if (worker && navigator.serviceWorker.controller) onWaiting(apply(worker));
  };

  offer(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    worker?.addEventListener('statechange', () => { if (worker.state === 'installed') offer(worker); });
  });
  // A page left open for days still hears about a release: look again every six hours.
  setInterval(() => reg.update().catch(() => {}), 6 * 60 * 60 * 1000);
  return reg;
}
