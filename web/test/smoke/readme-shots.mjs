#!/usr/bin/env node
// The README's screenshots (W-27): both layouts with data in every tile, and each dialog, made
// from the filled board's fake data (test/smoke/fake.mjs: an invented key and eight invented
// nodes; nothing real). Rerun it when the screens change; it overwrites docs/screenshots/.
// Not part of `node --test` (CI has no Chrome).
//
//   node web/test/smoke/readme-shots.mjs [--out DIR]
//
// The PNGs are made smaller: optipng when it is installed (lossless), else Pillow's 256-colour
// palette (python3 with PIL), else left as Chrome wrote them.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, puppeteer } from './run.mjs';
import { seedFake, fakeBeacon, noBroker, unlockFake, FAKE_NODES } from './fake.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '../..');
const BASEMAP = 'https://tiles.openfreemap.org/';
const wait = (ms = 400) => new Promise((ok) => setTimeout(ok, ms));

function options(argv) {
  const o = { out: resolve(ROOT, '../docs/screenshots') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') o.out = resolve(argv[++i]);
    else { console.error(`unknown option ${argv[i]}`); process.exit(2); }
  }
  return o;
}

async function main() {
  const o = options(process.argv.slice(2));
  mkdirSync(o.out, { recursive: true });
  const server = await serve(ROOT);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const beacon = JSON.parse(readFileSync(join(ROOT, 'lib/stats/beacon.json'), 'utf8')).url;
  const browser = await puppeteer().launch({
    headless: true,
    executablePath: existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined,
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--disable-dev-shm-usage'],
  });
  const made = [];
  const problems = [];

  // One context per look: its own storage, seeded with the fake fleet. The map's tiles are the
  // real basemap (positions are the region's); GitHub and Beacon are answered from the fakes.
  const context = async (prefs) => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.evaluateOnNewDocument(noBroker);
    await page.evaluateOnNewDocument((items) => {
      for (const [k, v] of Object.entries(items)) localStorage.setItem(`mccontrol.${k}`, v);
    }, { lang: 'en', ...prefs });
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
    return { ctx, page };
  };
  const go = async (page, hash, w, h) => {
    await page.setViewport({ width: w, height: h });
    await page.goto(`${origin}/#${hash}`, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-started'), { timeout: 15000 });
    await unlockFake(page);
    await wait(1500);   // the map's tiles
  };
  const shot = async (page, name) => {
    const path = join(o.out, `${name}.png`);
    await page.mouse.move(1, 1); await wait(300);   // no row tooltip left under the pointer (W-35b)
    await page.screenshot({ path });
    made.push(path);
  };
  const sample = FAKE_NODES[4].node;

  try {
    // The standard layout, the default: dark and light, desktop and phone.
    for (const [look, prefs] of [['standard-dark', {}], ['standard-light', { scheme: 'light' }]]) {
      const { ctx, page } = await context(prefs);
      await go(page, '', 1600, 900);
      await page.click('.std-row'); await wait(1500);
      await shot(page, `${look}-1600`);
      if (look === 'standard-dark') {
        await go(page, '', 1280, 800);
        await page.click('.std-row'); await wait(1200);
        await page.click('.std-p-send input.cmd'); await wait(500);     // the suggestions open on focus (W-35c)
        await shot(page, `${look}-1280-commands`);
        await page.click(`#std-tab-history`); await wait(800);
        await shot(page, `${look}-1280-history`);
        await go(page, `neighbours/${sample}`, 1280, 800); await shot(page, `${look}-neighbours`);
        await go(page, '', 390, 844); await shot(page, `${look}-phone`);
      }
      await ctx.close();
    }

    // The retro board: amber (its default) and green, every tile filled, and each dialog.
    for (const theme of ['amber', 'green']) {
      const { ctx, page } = await context({ layout: 'retro', theme });
      await go(page, '', 1600, 900);
      await page.click('.node-row'); await wait(1500);
      await shot(page, `retro-${theme}-1600`);
      if (theme === 'amber') {
        await go(page, '', 1280, 800);
        await page.click('.node-row'); await wait(1200);
        await shot(page, 'retro-amber-1280');
        await page.evaluate(() => document.activeElement?.blur());
        await page.keyboard.press(':'); await wait();
        await page.keyboard.type('get r'); await wait();
        await shot(page, 'retro-palette');
        await page.keyboard.press('Escape'); await wait();
        await page.click('.status-row[data-line="companion"] .status-pick'); await wait(600);
        await shot(page, 'retro-companion-chooser');
        await page.keyboard.press('Escape'); await wait();
        await go(page, '', 1280, 800);
        await page.click('.result-row'); await wait(800);
        await shot(page, 'retro-result');
        await go(page, `nodeinfo/${sample}`, 1280, 800); await shot(page, 'retro-node-details');
        for (const tab of ['key', 'node', 'area', 'groups', 'sets', 'warnings', 'display']) {
          await go(page, `setup/${tab}`, 1280, 800); await shot(page, `retro-setup-${tab}`);
        }
        await go(page, '', 390, 844); await shot(page, 'retro-phone');
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  const QUANTIZE = 'import sys\nfrom PIL import Image\nfor p in sys.argv[1:]:\n    Image.open(p).convert("RGB").quantize(256, method=Image.Quantize.MEDIANCUT).save(p, optimize=True)';
  try { execFileSync('optipng', ['-quiet', '-o2', ...made], { stdio: 'ignore' }); } catch {
    try { execFileSync('python3', ['-I', '-c', QUANTIZE, ...made]); } catch { console.log('(no optipng, no PIL: the PNGs are as Chrome wrote them)'); }
  }
  for (const p of made) console.log(p);
  if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
