#!/usr/bin/env node
// The smoke test: every route in a real browser, at 360 and 1280 px, in the light and the phosphor
// look, under the real response headers. Fails on any console error, uncaught page error, CSP
// violation, horizontal page scroll or screen without an <h1>, and saves a screenshot of each.
// Not part of `node --test` (CI has no Chrome); see web/README.md, "Smoke test".
//
//   node web/test/smoke/run.mjs [--root DIR] [--out DIR] [--live] [--only route,route]
//
//   --root  the directory to serve (default: web/). Point it at a scripts/web-dist.mjs copy or an
//           unzipped release to test what is shipped.
//   --out   where the screenshots go (default: a new directory under the system's temp dir)
//   --live  let the page reach the real Beacon instead of the captured answers in
//           beacon-fixture.json (times moved to now)
//
// The server applies <root>/_headers as Cloudflare Pages does (every block whose path matches,
// `/*` matching everything), so the CSP the browser enforces is the deployed one, header and
// <meta> both. Puppeteer is the global install (`npm root -g`) driving the system Chrome.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WIDTHS = [360, 1280];
const LOOKS = { light: { 'mccontrol.theme': 'light' }, phosphor: { 'mccontrol.phosphor': 'green' } };
// Routes that take an argument are also visited with one: a node id from the fixture.
const SAMPLE_ARGS = { node: '13B58595', stats: '13B58595' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };

function options(argv) {
  const o = { root: resolve(HERE, '../..'), out: null, live: false, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root') o.root = resolve(argv[++i]);
    else if (a === '--out') o.out = resolve(argv[++i]);
    else if (a === '--live') o.live = true;
    else if (a === '--only') o.only = argv[++i].split(',');
    else { console.error(`unknown option ${a}`); process.exit(2); }
  }
  o.out ||= mkdtempSync(join(tmpdir(), 'mccontrol-smoke-'));
  return o;
}

// _headers: blocks of a path line and indented `Name: value` lines; `#` comments.
export function parseHeaders(text) {
  const blocks = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { blocks.push({ path: line.trim(), headers: [] }); continue; }
    const at = line.indexOf(':');
    blocks.at(-1)?.headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return blocks;
}

export function headersFor(blocks, path) {
  const out = {};
  for (const b of blocks) {
    const re = new RegExp(`^${b.path.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    if (re.test(path)) for (const [k, v] of b.headers) out[k] = v;
  }
  return out;
}

export function serve(root) {
  const blocks = existsSync(join(root, '_headers')) ? parseHeaders(readFileSync(join(root, '_headers'), 'utf8')) : [];
  if (!blocks.length) console.warn(`${root}/_headers missing: only the <meta> CSP applies`);
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = normalize(join(root, path === '/' ? 'index.html' : path));
    if (!file.startsWith(root + sep) || path.includes('\0')) { res.writeHead(400).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file) || path === '/_headers') { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, { ...headersFor(blocks, path), 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

export function puppeteer() {
  const require = createRequire(import.meta.url);
  try { return require('puppeteer'); } catch { /* not local */ }
  const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  return require(join(root, 'puppeteer'));
}

// The captured Beacon answers, every time moved forward by whole hours to now.
export function fixture() {
  const fix = JSON.parse(readFileSync(join(HERE, 'beacon-fixture.json'), 'utf8'));
  const shift = Math.floor((Date.now() - fix.capturedAt) / 3600000) * 3600000;
  const move = (v) => {
    if (Array.isArray(v)) return v.map(move);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, (k === 't' || k === 'lastStatusAt') && typeof x === 'number' ? x + shift : move(x)]));
    }
    return v;
  };
  return move(fix.paths);
}

async function main() {
  const o = options(process.argv.slice(2));
  mkdirSync(o.out, { recursive: true });
  const server = await serve(o.root);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const beacon = JSON.parse(readFileSync(join(o.root, 'lib/stats/beacon.json'), 'utf8')).url;
  const answers = fixture();
  const browser = await puppeteer().launch({
    headless: true,
    executablePath: existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined,
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--disable-dev-shm-usage'],
  });
  const failures = [];
  let shots = 0;
  try {
    // The routes, from the app's own table (so a new screen is smoke-tested without editing this).
    const probe = await browser.newPage();
    await probe.goto(`${origin}/`, { waitUntil: 'networkidle0' });
    const routes = await probe.evaluate(async () => (await import('./ui/screens/index.js')).SCREENS.map((s) => s.route));
    await probe.close();
    let hashes = routes.flatMap((r) => (SAMPLE_ARGS[r] ? [r, `${r}/${SAMPLE_ARGS[r]}`] : [r]));
    hashes.push('no-such-page');
    if (o.only) hashes = hashes.filter((h) => o.only.some((x) => h === x || h.startsWith(`${x}/`)));

    for (const [look, storage] of Object.entries(LOOKS)) {
      for (const width of WIDTHS) {
        for (const hash of hashes) {
          const where = `${look} ${width}px #/${hash}`;
          const problems = [];
          const page = await browser.newPage();
          await page.setViewport({ width, height: 800 });
          await page.evaluateOnNewDocument((items) => {
            for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
            addEventListener('securitypolicyviolation', (e) => {
              console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`);
            });
          }, storage);
          page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
          page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
          page.on('requestfailed', (r) => {
            if (!r.url().startsWith(beacon) || o.live) problems.push(`request failed: ${r.url()} ${r.failure()?.errorText}`);
          });
          if (!o.live) {
            await page.setRequestInterception(true);
            page.on('request', (r) => {
              if (!r.url().startsWith(beacon)) { r.continue(); return; }
              if (r.method() === 'OPTIONS') { r.respond({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Accept' } }); return; }
              const body = answers[r.url().slice(beacon.length)];
              r.respond({ status: body ? 200 : 404, contentType: 'application/json',
                headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body || { error: 'not in fixture' }) });
            });
          }
          try {
            await page.goto(`${origin}/#/${hash}`, { waitUntil: 'networkidle0', timeout: 20000 });
            await new Promise((ok) => setTimeout(ok, 300));
            const check = await page.evaluate(() => ({
              h1: document.querySelector('main h1')?.textContent || '',
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            }));
            if (!check.h1) problems.push('no <h1> in <main>');
            if (check.overflow > 0) problems.push(`page scrolls sideways by ${check.overflow}px`);
            const file = join(o.out, `${look}-${width}-${hash.replace(/[^\w-]+/g, '_') || 'home'}.png`);
            await page.screenshot({ path: file, fullPage: true });
            shots += 1;
          } catch (err) {
            problems.push(`load: ${err.message}`);
          } finally {
            await page.close();
          }
          for (const p of problems) failures.push(`${where}: ${p}`);
          console.log(`${problems.length ? 'FAIL' : 'ok  '} ${where}`);
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${shots} screenshots in ${o.out}`);
  if (failures.length) {
    const unique = [...new Set(failures)];
    console.log(`${unique.length} problem(s):\n${unique.map((f) => `  ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('smoke test passed');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
