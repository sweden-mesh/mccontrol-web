#!/usr/bin/env node
// The demo's smoke test (W-39): `?demo=1` in a real browser. A demo page must reach nothing and leave
// nothing: it fails on any request to a host other than the page's own (the basemap is answered here,
// as in the other smokes), any WebSocket, any IndexedDB database, anything written to localStorage but
// the display settings, a console error, an uncaught page error or a CSP violation.
// Not part of `node --test` (CI has no Chrome); see web/README.md, "Smoke test".
//
//   node web/test/smoke/demo.mjs [--root DIR] [--out DIR]
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, puppeteer } from './run.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const BASEMAP = 'https://tiles.openfreemap.org/';
const STUB_STYLE = JSON.stringify({ version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#8aa' } }] });
const SHARED = ['theme', 'lang', 'layout', 'scheme', 'colorblind'].map((n) => `mccontrol.${n}`);

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? resolve(process.argv[i + 1]) : fallback; };
const root = arg('--root', resolve(HERE, '../..'));
const out = arg('--out', mkdtempSync(join(tmpdir(), 'mccontrol-demo-')));
mkdirSync(out, { recursive: true });

const server = await serve(root);
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer().launch({ headless: true,
  executablePath: existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--disable-dev-shm-usage'] });
const failures = [];
const report = (where, problems) => {
  for (const p of problems) failures.push(`${where}: ${p}`);
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${where}${problems.length ? `\n       ${problems.join('\n       ')}` : ''}`);
};

// A demo page with the watches on. `storage` is this device's display settings.
export async function open(storage, width, { path = '/?demo=1' } = {}) {
  const problems = [];
  const page = await browser.newPage();
  await page.setViewport({ width, height: 800 });
  await page.evaluateOnNewDocument((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) { req.continue(); return; }
    if (url.startsWith(BASEMAP)) { req.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: STUB_STYLE }); return; }
    problems.push(`a request left the page: ${url.slice(0, 120)}`);
    req.abort();
  });
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', (e) => problems.push(`a WebSocket was opened: ${e.url}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  await page.evaluateOnNewDocument(() => document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP: ${e.violatedDirective} ${e.blockedURI}`)));
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  await page.waitForSelector('html[data-started]', { timeout: 15000 }).catch(() => problems.push('the page did not start'));
  return { page, problems };
}

// What a demo page left behind: IndexedDB databases and localStorage keys that are not display settings.
export async function leftBehind(page) {
  return page.evaluate(async (shared) => {
    const dbs = (await indexedDB.databases()).map((d) => d.name);
    // The page's own localStorage is the demo's stand-in: ask the browser's real one through a new frame.
    const frame = document.createElement('iframe');
    frame.hidden = true;
    document.body.append(frame);
    const real = frame.contentWindow.localStorage;
    const extra = Array.from({ length: real.length }, (_, i) => real.key(i)).filter((k) => !shared.includes(k));
    frame.remove();
    return { dbs, extra };
  }, SHARED);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    for (const [look, storage] of Object.entries({ standard: {}, retro: { 'mccontrol.layout': 'retro' } })) {
      for (const width of [360, 1280]) {
        const { page, problems } = await open(storage, width);
        await new Promise((ok) => setTimeout(ok, 1500));
        const left = await leftBehind(page);
        if (left.dbs.length) problems.push(`IndexedDB databases: ${left.dbs.join(', ')}`);
        if (left.extra.length) problems.push(`localStorage keys: ${left.extra.join(', ')}`);
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) problems.push('the page scrolls sideways');
        await page.screenshot({ path: join(out, `demo-${look}-${width}.png`) });
        report(`demo ${look} ${width}px`, problems);
        await page.close();
      }
    }
    // The ordinary page is unchanged: it opens its key store as before.
    {
      const problems = [];
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(() => { globalThis.WebSocket = class extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} }; });
      await page.goto(`${origin}/`, { waitUntil: 'load' });
      await page.waitForSelector('html[data-started]', { timeout: 15000 }).catch(() => problems.push('the page did not start'));
      const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
      if (!dbs.includes('mccontrol-key')) problems.push(`the ordinary page did not open its key store (${dbs.join(', ') || 'none'})`);
      report('ordinary page', problems);
      await page.close();
    }
  } finally { await browser.close(); server.close(); }
  console.log(`screenshots: ${out}`);
  if (failures.length) { console.log(`\n${failures.length} problem(s)`); process.exit(1); }
}
