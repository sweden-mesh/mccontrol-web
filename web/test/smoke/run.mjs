#!/usr/bin/env node
// The smoke test: the board and every modal in a real browser, at 360 and 1280 px, in all four
// themes, under the real response headers. Fails on any console error, uncaught page error, CSP
// violation, horizontal page scroll, a board without its tiles or a modal that did not open with
// a heading, and saves a screenshot of each. Then the frame's behaviour: old routes land, Back
// and Esc close a modal, the keys open Setup and Help, and the start survives a refused Trusted
// Types policy or shows its error instead of a blank page (W-20k).
// Not part of `node --test` (CI has no Chrome); see web/README.md, "Smoke test".
//
//   node web/test/smoke/run.mjs [--root DIR] [--out DIR] [--live] [--only hash,hash]
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

import { noBroker, seedKey, unlockFake } from './fake.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WIDTHS = [360, 1280];
// The board alone is also drawn at the grid's other widths.
const BOARD_WIDTHS = [390, 1100, 1600];
// The retro board in its four themes, and the standard layout (W-29, the default) dark, light and
// colour-blind in both (W-29b, W-29c).
const RETRO = { 'mccontrol.layout': 'retro' };
const LOOKS = { amber: RETRO, green: { ...RETRO, 'mccontrol.theme': 'green' }, dark: { ...RETRO, 'mccontrol.theme': 'dark' }, light: { ...RETRO, 'mccontrol.theme': 'light' },
  'std-dark': {}, 'std-light': { 'mccontrol.scheme': 'light' }, 'std-dark-cb': { 'mccontrol.colorblind': 'on' },
  'std-light-cb': { 'mccontrol.scheme': 'light', 'mccontrol.colorblind': 'on' } };
const STD_WIDTHS = [360, 390, 1280, 1600];
// The basemap (W-29d) answered here, so the smoke needs no network: a style with one background.
const BASEMAP = 'https://tiles.openfreemap.org/';
const STUB_STYLE = JSON.stringify({ version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#8aa' } }] });
// Modals that take an argument are also opened with one: a node id from the fixture.
const SAMPLE_ARGS = { node: ['13B58595'], nodeinfo: ['13B58595'], result: ['none'], stats: ['13B58595'], help: ['signing', 'codes'], unlock: ['replace', 'to/nodes'],
  setup: ['key', 'node', 'connections', 'groups', 'sets', 'warnings', 'display', 'settings'], run: ['cmd/-', 'set/-'] };
// Old routes and where they must land.
const LEGACY = { '#/nodes': '#nodes', '#/key': '#setup/key', '#/node/13B58595': '#node/13B58595', '#/no-such-page': '#notfound', '#/': '' };
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
  const report = (where, problems) => {
    for (const p of problems) failures.push(`${where}: ${p}`);
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${where}${problems.length ? `\n       ${problems.join('\n       ')}` : ''}`);
  };

  // A page with the look's storage, the CSP watch, Beacon from the fixture and the problems
  // collected. `routes` answers other requests by URL suffix (a stand-in version.json, a refusal).
  const open = async (storage, width, { routes = {}, before = null } = {}) => {
    const problems = [];
    const page = await browser.newPage();
    await page.setViewport({ width, height: 800 });
    await page.evaluateOnNewDocument((items) => {
      // The pages share one origin's storage: each look starts from its own settings only.
      // (about:blank, where Back can lead, has no storage: nothing to set there.)
      try {
        for (const k of ['theme', 'layout', 'scheme', 'colorblind']) localStorage.removeItem(`mccontrol.${k}`);
        for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
      } catch { /* not the app's page */ }
      addEventListener('securitypolicyviolation', (e) => {
        console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`);
      });
    }, storage);
    if (before) await page.evaluateOnNewDocument(before);
    // Unlocking starts registration and the command server check: never the live broker.
    await page.evaluateOnNewDocument(noBroker);
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('requestfailed', (r) => {
      if (!r.url().startsWith(beacon) || o.live) problems.push(`request failed: ${r.url()} ${r.failure()?.errorText}`);
    });
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const url = r.url();
      const own = Object.keys(routes).find((suffix) => new URL(url).pathname.endsWith(suffix));
      if (own) { r.respond(routes[own]); return; }
      if (url.startsWith(BASEMAP)) { r.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: STUB_STYLE }); return; }
      if (o.live || !url.startsWith(beacon)) { r.continue(); return; }
      if (r.method() === 'OPTIONS') { r.respond({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Accept' } }); return; }
      const body = answers[url.slice(beacon.length)];
      r.respond({ status: body ? 200 : 404, contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body || { error: 'not in fixture' }) });
    });
    return { page, problems };
  };
  const settle = (page) => page.waitForFunction(() => document.documentElement.hasAttribute('data-started')
    || document.documentElement.hasAttribute('data-start-failed'), { timeout: 15000 }).then(() => new Promise((ok) => setTimeout(ok, 300)));
  // Started and past the unlock gate (W-28b) with the fake key: the gate then opens what the
  // address asked for.
  const ready = async (page) => { await settle(page); await unlockFake(page); };
  const state = (page) => page.evaluate(() => ({
    hash: location.hash,
    started: document.documentElement.hasAttribute('data-started'),
    failed: document.documentElement.hasAttribute('data-start-failed'),
    theme: document.documentElement.dataset.theme,
    layout: document.documentElement.dataset.layout,
    scheme: document.documentElement.dataset.scheme,
    cb: document.documentElement.hasAttribute('data-colorblind'),
    std: [...document.querySelectorAll('.std-aside, .std-main, .std-head, .std-foot')].filter((e) => e.checkVisibility()).map((e) => e.className.split(' ')[0]),
    modal: document.getElementById('modal')?.open ? document.getElementById('modal').dataset.modal : null,
    modalHeading: document.querySelector('#modal[open] :is(h1, h2)')?.textContent || '',
    labelled: Boolean(document.getElementById(document.getElementById('modal')?.getAttribute('aria-labelledby') || '-')),
    boardH1: document.querySelector('main h1')?.textContent || '',
    tiles: [...document.querySelectorAll('.tile')].filter((t) => t.offsetParent).map((t) => t.dataset.tile),
    keys: [...document.querySelectorAll('.key-button')].map((b) => b.textContent),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    error: document.querySelector('.start-error h1')?.textContent || '',
    gate: document.documentElement.hasAttribute('data-gate'),
    mainShown: getComputedStyle(document.getElementById('main')).visibility !== 'hidden',
    unlockStep: document.querySelector('#modal[open] #unlock-title')?.textContent || '',
  }));
  const shot = async (page, name, fullPage = false) => {
    await page.screenshot({ path: join(o.out, `${name.replace(/[^\w-]+/g, '_')}.png`), fullPage });
    shots += 1;
  };

  try {
    // The modals, from the app's own table (so a new modal is smoke-tested without editing this).
    const probe = await browser.newPage();
    await probe.goto(`${origin}/`, { waitUntil: 'networkidle0' });
    const names = await probe.evaluate(async () => (await import('./ui/modal.js')).modalNames());
    // W-28b: the unlock gate, before the key exists and once it is stored locked.
    {
      const problems = [];
      const s = await state(probe);
      if (s.modal !== 'unlock' || !s.gate || s.mainShown) problems.push(`no key: modal ${s.modal}, gate ${s.gate}, page shown ${s.mainShown}`);
      if (!(await probe.$('#modal[open] .choice-row button'))) problems.push('no key: no "make or import a key"');
      report('the unlock gate: no key', problems);
    }
    await seedKey(probe);
    await probe.close();
    {
      const { page, problems } = await open({}, 1280);
      try {
        await page.goto(`${origin}/#setup/key`, { waitUntil: 'networkidle0', timeout: 20000 });
        await settle(page);
        let s = await state(page);
        if (s.modal !== 'unlock' || !s.gate || s.mainShown || s.hash !== '#unlock') problems.push(`locked: modal ${s.modal}, hash ${s.hash}, gate ${s.gate}, page shown ${s.mainShown}`);
        await page.keyboard.press('Escape');
        await new Promise((ok) => setTimeout(ok, 300));
        if ((await state(page)).modal !== 'unlock') problems.push('Esc left the gate');
        await page.click('#modal .modal-help');
        await new Promise((ok) => setTimeout(ok, 300));
        if ((await state(page)).modal !== 'help') problems.push('Help is not reachable from the gate');
        await page.keyboard.press('Escape');
        await new Promise((ok) => setTimeout(ok, 300));
        if ((await state(page)).modal !== 'unlock') problems.push('closing Help did not return to the gate');
        await page.type('#modal input[autocomplete="current-password"]', 'smoke-test-only');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => !document.documentElement.hasAttribute('data-gate'), { timeout: 10000 });
        await new Promise((ok) => setTimeout(ok, 700));
        s = await state(page);
        if (s.modal !== 'setup' || s.hash !== '#setup/key' || !s.mainShown) problems.push(`after unlocking: modal ${s.modal}, hash ${s.hash}, page shown ${s.mainShown}`);
        await page.evaluate(async () => (await import('./ui/screens/key-session.js')).keyring().lock());
        await new Promise((ok) => setTimeout(ok, 500));
        s = await state(page);
        if (s.modal !== 'unlock' || !s.gate) problems.push(`locking did not bring the gate back: modal ${s.modal}`);
        await shot(page, 'gate-locked');
      } catch (err) { problems.push(err.message); } finally { await page.close(); }
      report('the unlock gate: locked, Help, unlock, lock again', problems);
    }
    let hashes = ['', ...names.flatMap((n) => [n, ...(SAMPLE_ARGS[n] || []).map((a) => `${n}/${a}`)])];
    if (o.only) hashes = hashes.filter((x) => o.only.some((y) => x === y || x.startsWith(`${y}/`) || (y === 'board' && x === '')));

    for (const [look, storage] of Object.entries(LOOKS)) {
      const std = look.startsWith('std');
      // The standard layout: every modal in front of it once (std-dark), the layout alone at four widths in each look.
      const widths = std ? STD_WIDTHS : [...WIDTHS, ...(look === 'amber' ? BOARD_WIDTHS : [])];
      for (const width of widths) {
        for (const hash of ((std ? look === 'std-dark' && WIDTHS.includes(width) : WIDTHS.includes(width)) ? hashes : [''])) {
          const where = `${look} ${width}px #${hash}`;
          const { page, problems } = await open(storage, width);
          try {
            await page.goto(`${origin}/#${hash}`, { waitUntil: 'networkidle0', timeout: 20000 });
            await ready(page);
            const s = await state(page);
            if (!s.started) problems.push(`did not start: ${s.error}`);
            if (std) {
              const scheme = look.includes('light') ? 'light' : 'dark';
              if (s.layout !== 'standard' || s.scheme !== scheme || s.cb !== look.endsWith('-cb')) problems.push(`layout ${s.layout}, scheme ${s.scheme}, colour-blind ${s.cb}`);
            } else if (s.theme !== look || s.layout !== 'retro') problems.push(`theme ${s.theme}, layout ${s.layout}`);
            if (s.overflow > 0) problems.push(`page scrolls sideways by ${s.overflow}px`);
            if (!s.boardH1) problems.push('no <h1> on the board');
            const expectTiles = std ? [] : width < 720 ? ['nodes', 'status', 'map', 'results'] : ['nodes', 'node', 'status', 'map', 'results'];
            if (s.tiles.sort().join() !== expectTiles.sort().join()) problems.push(`tiles shown: ${s.tiles.join(', ')}`);
            // The standard layout: header, list and footer; the detail beside the list from 45em.
            const expectStd = !std ? [] : width < 720 ? ['std-aside', 'std-foot', 'std-head'] : ['std-aside', 'std-foot', 'std-head', 'std-main'];
            if (s.std.sort().join() !== expectStd.join()) problems.push(`standard parts shown: ${s.std.join(', ')}`);
            // Unlocked past the gate, '#unlock' goes on to the board and '#unlock/to/nodes' to nodes.
            const lands = { unlock: '', 'unlock/to/nodes': 'nodes' }[hash] ?? hash;
            if (lands === '') {
              if (s.modal) problems.push(`a modal is open on the board: ${s.modal}`);
            } else {
              if (s.modal !== lands.split('/')[0]) problems.push(`modal ${s.modal} open for #${hash}`);
              if (!s.modalHeading) problems.push('no heading in the modal');
              if (!s.labelled) problems.push('the dialog is not labelled by its heading');
            }
            await shot(page, `${look}-${width}-${hash || 'board'}`, hash === '');
          } catch (err) {
            problems.push(`load: ${err.message}`);
          } finally {
            await page.close();
          }
          report(where, problems);
        }
      }
    }

    // The frame: old routes, Back, Esc, the keys.
    for (const width of WIDTHS) {
      for (const [from, to] of Object.entries(LEGACY)) {
        const { page, problems } = await open(RETRO, width);
        try {
          await page.goto(`${origin}/${from}`, { waitUntil: 'networkidle0', timeout: 20000 });
          await ready(page);
          const s = await state(page);
          if (s.hash !== to) problems.push(`landed on "${s.hash}", not "${to}"`);
          const name = to.slice(1).split('/')[0] || null;
          if (s.modal !== name) problems.push(`modal ${s.modal}, not ${name}`);
        } catch (err) { problems.push(`load: ${err.message}`); } finally { await page.close(); }
        report(`old route ${width}px ${from}`, problems);
      }
      const { page, problems } = await open(RETRO, width);
      try {
        await page.goto(`${origin}/`, { waitUntil: 'networkidle0', timeout: 20000 });
        await ready(page);
        const expect = async (what, modal, hash) => {
          await new Promise((ok) => setTimeout(ok, 300));
          const s = await state(page);
          if (s.modal !== modal || (hash !== undefined && s.hash !== hash)) problems.push(`${what}: modal ${s.modal}, hash "${s.hash}"`);
        };
        await page.keyboard.press(',');
        await expect("',' opens Setup", 'setup');
        await shot(page, `frame-${width}-setup-key`);
        await page.goBack();
        await expect('Back closes it', null, '');
        await page.keyboard.type('?');
        await expect("'?' opens Help", 'help', '#help');
        await page.click('#modal a[href^="#/help/"], #modal a[href^="#help/"]').catch(() => problems.push('no help topic link'));
        await expect('a link inside moves the modal on', 'help');
        await page.keyboard.press('Escape');
        await expect('Esc closes to the board', null, '');
        await page.goBack().catch(() => {});
        await page.goto(`${origin}/#node/13B58595`, { waitUntil: 'networkidle0' });
        await ready(page);
        await expect('a link to a node opens it', 'node', '#node/13B58595');
        await page.click('#modal .modal-close');
        await expect('the close button goes to the board', null, '');
        const keys = (await state(page)).keys;
        // NODES binds '/' (search) on a desktop once it has the key's nodes to search.
        if (keys.length !== (width < 720 ? 3 : 4)) problems.push(`key bar: ${keys.join(' | ')}`);
      } catch (err) { problems.push(err.message); } finally { await page.close(); }
      report(`frame ${width}px: keys, Back, Esc, close`, problems);
    }

    // The layout switch, top right in both (W-29): standard -> retro board -> standard, and the
    // standard layout's Log out asks first, then locks (W-29e).
    for (const width of [390, 1280]) {
      const { page, problems } = await open({}, width);
      try {
        await page.goto(`${origin}/`, { waitUntil: 'networkidle0', timeout: 20000 });
        await ready(page);
        const pause = () => new Promise((ok) => setTimeout(ok, 500));
        await page.click('.std-head .layout-switch'); await pause();
        let s = await state(page);
        if (s.layout !== 'retro' || !s.tiles.length) problems.push(`to the retro board: layout ${s.layout}, tiles ${s.tiles.join(',')}`);
        await page.click('#statusline .layout-switch'); await pause();
        s = await state(page);
        if (s.layout !== 'standard' || !s.std.includes('std-aside')) problems.push(`back to standard: layout ${s.layout}, parts ${s.std.join(',')}`);
        await page.evaluate(() => [...document.querySelectorAll('.std-head button')].find((b) => /Logga ut|Log out/.test(b.textContent)).click()); await pause();
        if (!(await page.$('dialog.dlg[open]'))) problems.push('Log out did not ask first');
        if ((await state(page)).gate) problems.push('Log out locked before it was confirmed');
        await shot(page, `logout-confirm-${width}`);
        await page.evaluate(() => document.querySelector('dialog.dlg[open] .button, dialog.dlg[open] .button-danger')?.click()); await pause();
        s = await state(page);
        if (!s.gate || s.modal !== 'unlock') problems.push(`after Log out: gate ${s.gate}, modal ${s.modal}`);
      } catch (err) { problems.push(err.message); } finally { await page.close(); }
      report(`the layout switch and Log out ${width}px`, problems);
    }

    // W-20k: a browser that refuses the Trusted Types policy still starts. version.json is
    // stamped so the app tries to register the offline copy, which is what needs the policy.
    {
      const { page, problems } = await open(RETRO, 1280, {
        routes: { '/version.json': { status: 200, contentType: 'application/json', body: '{"version":"smoke"}' } },
        before: () => {
          if (globalThis.trustedTypes) trustedTypes.createPolicy = () => { throw new TypeError('Policy refused (smoke)'); };
        },
      });
      try {
        await page.goto(`${origin}/`, { waitUntil: 'networkidle0', timeout: 20000 });
        await ready(page);
        const s = await state(page);
        if (!s.started || s.tiles.length !== 5) problems.push(`the board did not start: ${s.error}`);
        const toast = await page.evaluate(() => document.querySelector('.toast-error')?.textContent || '');
        if (!/Policy refused/.test(toast)) problems.push(`no message about the offline copy: "${toast}"`);
        await shot(page, 'start-policy-refused');
      } catch (err) { problems.push(err.message); } finally { await page.close(); }
      report('start: Trusted Types policy refused', problems);
    }
    // W-20k: a failure inside start() (the strings) and a module that never loads: a message, not
    // a blank page. These pages log the failure on purpose; only the message is checked.
    for (const [what, routes, name] of [
      ['the strings fail to load', { '/i18n/sv.json': { status: 500, body: 'no' }, '/i18n/en.json': { status: 500, body: 'no' } }, 'start-strings-fail'],
      ['ui/app.js does not load', { '/ui/app.js': { status: 404, body: 'no' } }, 'start-module-fail'],
    ]) {
      const { page } = await open({}, 360, { routes });
      const problems = [];
      try {
        await page.goto(`${origin}/`, { waitUntil: 'networkidle0', timeout: 20000 });
        await settle(page);
        const s = await state(page);
        if (!s.failed || !/could not start|kunde inte starta/.test(s.error)) problems.push(`no start error shown (${JSON.stringify(s.error)})`);
        await shot(page, name);
      } catch (err) { problems.push(err.message); } finally { await page.close(); }
      report(`start error: ${what}`, problems);
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
