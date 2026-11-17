#!/usr/bin/env node
// The board with fake data (test/smoke/fake.mjs): the phone pass and the beta notes' screenshots.
// Every look at 360, 390 and 412 px (and landscape 740 x 360), and 1280 px; checks what only a
// filled board shows: rows a finger tall on a phone, nothing sideways, the node sheet's command
// line at the bottom of the screen, the key bar not covering the last row, nothing cut off in the
// status line. Not part of `node --test` (CI has no Chrome).
//
//   node web/test/smoke/filled.mjs [--out DIR] [--shots]
//
//   --shots   also the beta notes' set: the palette, Setup's tabs, a result
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { serve, puppeteer } from './run.mjs';
import { seedFake, fakeBeacon, noBroker, FAKE_NODES } from './fake.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const LOOKS = ['amber', 'green', 'dark', 'light'];
const PHONES = [[360, 780], [390, 844], [412, 915]];

function options(argv) {
  const o = { root: resolve(HERE, '../..'), out: null, shots: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') o.out = resolve(argv[++i]);
    else if (argv[i] === '--shots') o.shots = true;
    else { console.error(`unknown option ${argv[i]}`); process.exit(2); }
  }
  o.out ||= mkdtempSync(join(tmpdir(), 'mccontrol-filled-'));
  return o;
}

// What a phone screen shows: the problems a person would see.
const inspect = () => {
  const out = [];
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth) out.push(`page scrolls sideways by ${de.scrollWidth - de.clientWidth}px`);
  const phone = innerWidth < 720;
  const dialog = document.querySelector('#modal[open]');
  const scope = dialog || document;
  if (phone) {
    for (const el of scope.querySelectorAll('.node-row, .result-row, .key-button, .modal-close, .tabs a, .status-row button, .status-row a')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height && r.height < 43.5) out.push(`${el.className || el.tagName} "${el.textContent.trim().slice(0, 20)}" is ${Math.round(r.height)}px tall`);
    }
  }
  // Text cut off: an element whose own text overflows it and that does not end in an ellipsis.
  const hidden = (el) => el.closest('.visually-hidden, .skip, [hidden]') || getComputedStyle(el).clipPath !== 'none';
  // Visible to a finger: its centre hits it, and it is not under the fixed key bar or a sticky bar
  // (content passes under those while it scrolls; that is not an overlap).
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit && (el === hit || el.contains(hit) || hit.contains(el)));
  };
  for (const el of scope.querySelectorAll('button, a, .status-word, .tile-title, h1, h2, label')) {
    if (!el.offsetParent || hidden(el)) continue;
    if (el.closest('.tabs')) continue;   // Setup's tabs scroll sideways on a phone, on purpose
    const cs = getComputedStyle(el);
    if (el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis' && cs.overflow !== 'visible') out.push(`cut off: "${el.textContent.trim().slice(0, 30)}"`);
  }
  const fixed = (el) => { for (let e = el; e; e = e.parentElement) if (getComputedStyle(e).position === 'fixed') return true; return false; };
  // The fixed key bar must not hide the end of the page: the body leaves room for it.
  const bar = document.querySelector('.keys');
  if (phone && !dialog && bar && getComputedStyle(bar).position === 'fixed') {
    const room = parseFloat(getComputedStyle(document.body).paddingBottom);
    if (room + 1 < bar.getBoundingClientRect().height) out.push(`the key bar (${Math.round(bar.getBoundingClientRect().height)}px) covers the page's end (${room}px room)`);
  }
  // Two controls on top of each other.
  const boxes = [...scope.querySelectorAll('button, a, input, select')].filter((e) => e.offsetParent && !hidden(e) && shown(e))
    .map((e) => [e, e.getBoundingClientRect()]).filter(([, r]) => r.width && r.height);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const [a, ra] = boxes[i]; const [b, rb] = boxes[j];
      if (a.contains(b) || b.contains(a)) continue;
      if (fixed(a) !== fixed(b)) continue;   // content scrolls under the fixed key bar
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const hgt = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 2 && hgt > 2) out.push(`overlap: "${a.textContent.trim().slice(0, 16) || a.tagName}" and "${b.textContent.trim().slice(0, 16) || b.tagName}"`);
    }
  }
  if (dialog?.dataset.modal === 'node') {
    const line = dialog.querySelector('.cmd-line');
    const r = line?.getBoundingClientRect();
    if (!r) out.push('the node sheet has no command line');
    else if (!phone && r.bottom > dialog.getBoundingClientRect().bottom + 1) out.push('the command line is below the dialog');
    else if (phone && Math.abs(r.bottom - innerHeight) > 2) out.push(`the command line ends ${Math.round(innerHeight - r.bottom)}px above the bottom`);
  }
  return [...new Set(out)];
};

async function main() {
  const o = options(process.argv.slice(2));
  mkdirSync(o.out, { recursive: true });
  const server = await serve(o.root);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const beacon = JSON.parse(readFileSync(join(o.root, 'lib/stats/beacon.json'), 'utf8')).url;
  const browser = await puppeteer().launch({
    headless: true,
    executablePath: existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined,
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--disable-dev-shm-usage'],
  });
  const failures = [];
  const report = (where, problems) => {
    for (const p of problems) failures.push(`${where}: ${p}`);
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${where}${problems.length ? `\n       ${problems.join('\n       ')}` : ''}`);
  };

  // One browser context per look: its own IndexedDB, seeded once.
  const context = async (look) => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.evaluateOnNewDocument(noBroker);
    await page.evaluateOnNewDocument((theme) => {
      localStorage.setItem('mccontrol.theme', theme);
      localStorage.setItem('mccontrol.lang', 'sv');
      addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective}`));
    }, look);
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const url = r.url();
      if (url.startsWith('https://api.github.com')) { r.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '[]' }); return; }
      if (!url.startsWith(beacon)) { r.continue(); return; }
      if (r.method() === 'OPTIONS') { r.respond({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Accept' } }); return; }
      const body = fakeBeacon(url.slice(beacon.length));
      r.respond({ status: body ? 200 : 404, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body || {}) });
    });
    await page.goto(`${origin}/`, { waitUntil: 'networkidle0' });
    await seedFake(page);
    return { ctx, page, problems };
  };
  const go = async (page, hash, w, hgt) => {
    await page.setViewport({ width: w, height: hgt });
    await page.goto(`${origin}/#${hash}`, { waitUntil: 'networkidle0', timeout: 20000 });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-started'), { timeout: 15000 });
    await new Promise((ok) => setTimeout(ok, 700));
  };
  const shot = (page, name, fullPage = false) => page.screenshot({ path: join(o.out, `${name}.png`), fullPage });
  const sample = FAKE_NODES[4].node;

  try {
    for (const look of LOOKS) {
      const { ctx, page, problems } = await context(look);
      const views = [...PHONES.map(([w, hh]) => [w, hh, '']), ...PHONES.map(([w, hh]) => [w, hh, `node/${sample}`]),
        [360, 780, 'setup/key'], [360, 780, 'help'], [740, 360, ''], [740, 360, `node/${sample}`], [1280, 800, '']];
      for (const [w, hh, hash] of views) {
        problems.length = 0;
        try {
          await go(page, hash, w, hh);
          const seen = await page.evaluate(inspect);
          const rows = await page.evaluate(() => document.querySelectorAll('.node-row').length);
          if (!rows) seen.push('no node rows');
          await shot(page, `${look}-${w}x${hh}-${hash.replace(/\W+/g, '_') || 'board'}`, !hash && w < 720);
          report(`${look} ${w}x${hh} #${hash}`, [...problems, ...seen]);
        } catch (err) { report(`${look} ${w}x${hh} #${hash}`, [err.message]); }
      }
      if (o.shots) {
        await go(page, '', 1280, 800);
        await shot(page, `beta-board-${look}-1280`);
        if (look === 'amber') {
          await go(page, '', 360, 780); await shot(page, 'beta-phone-board-360', true);
          await go(page, `node/${sample}`, 360, 780); await shot(page, 'beta-phone-node-360');
          for (const tab of ['key', 'node', 'area', 'groups', 'sets', 'warnings', 'display']) {
            await go(page, `setup/${tab}`, 1280, 800); await shot(page, `beta-setup-${tab}`);
          }
          await go(page, '', 1280, 800);
          await page.keyboard.press(':');
          await new Promise((ok) => setTimeout(ok, 300));
          await page.keyboard.type('set af');
          await new Promise((ok) => setTimeout(ok, 300));
          await shot(page, 'beta-palette');
          const id = await page.evaluate(() => document.querySelector('.result-row')?.closest('[data-id]')?.dataset.id
            || document.querySelector('.result-row')?.dataset.id || null);
          await page.keyboard.press('Escape');
          if (id) { await go(page, `result/${id}`, 1280, 800); } else { await page.click('.result-row'); await new Promise((ok) => setTimeout(ok, 500)); }
          await shot(page, 'beta-result');
        }
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\nscreenshots in ${o.out}`);
  if (failures.length) { console.log(`${failures.length} problem(s)`); process.exit(1); }
  console.log('filled board passed');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
