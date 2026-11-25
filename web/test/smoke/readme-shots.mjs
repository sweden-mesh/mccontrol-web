#!/usr/bin/env node
// The README's screenshots: both layouts and the dialogs, made from the demo (`?demo=1`): an
// invented fleet of lou-20 nodes, with and without Wi-Fi, simulated in the page. Nothing real is
// in a picture, and the demo's banner says so in each. Rerun it when the screens change; it
// overwrites docs/screenshots/. Not part of `node --test` (CI has no Chrome).
//
//   node web/test/smoke/readme-shots.mjs [--out DIR]
//
// The map's tiles are the real basemap, so it needs the network. The PNGs are made smaller:
// optipng when it is installed (lossless), else Pillow's 256-colour palette (python3 with PIL),
// else left as Chrome wrote them.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, puppeteer } from './run.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '../..');
const wait = (ms = 400) => new Promise((ok) => setTimeout(ok, ms));

// The demo's nodes the pictures use, by name.
const WIFI = 'DEMO-Kvarnberget';      // lou-20, Wi-Fi, relays
const MESH = 'DEMO-Granbo';           // lou-20, no Wi-Fi: reached through a relay
const OLD = 'DEMO-Lövåsen';           // lou-18: an update is out

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
  const browser = await puppeteer().launch({
    headless: true,
    executablePath: existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined,
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--disable-dev-shm-usage'],
  });
  const made = [];
  const problems = [];

  // One context per look: its own storage. English, so the pictures match the README.
  const context = async (prefs) => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.evaluateOnNewDocument((items) => {
      try { for (const [k, v] of Object.entries(items)) localStorage.setItem(`mccontrol.${k}`, v); } catch { /* a blank page has no storage */ }
    }, { lang: 'en', ...prefs });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    return { ctx, page, retro: prefs.layout === 'retro' };
  };
  // The demo starts over on every load: the same fleet and history each time.
  const go = async (look, hash, w, h) => {
    const { page, retro } = look;
    await page.setViewport({ width: w, height: h });
    await page.goto(`${origin}/?demo=1${hash ? `#${hash}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.reload({ waitUntil: 'domcontentloaded' });   // a new hash alone would not start the demo over
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-started'), { timeout: 20000 });
    await page.waitForSelector(retro ? '.node-row' : '.std-row', { timeout: 20000 }).catch(() => {});
    await wait(2500);   // the map's tiles, the first answers
  };
  const shot = async (look, name) => {
    const path = join(o.out, `${name}.png`);
    await look.page.mouse.move(1, 1); await wait(300);   // no row tooltip left under the pointer
    await look.page.screenshot({ path });
    made.push(path);
  };
  // Select a node by its name (a second click on the selected one would clear the selection).
  const pick = async (look, name) => {
    await look.page.evaluate((n, retro) => {
      const rows = [...document.querySelectorAll(retro ? '.node-row' : '.std-row')];
      const row = rows.find((r) => r.innerText.includes(n.replace(/^DEMO-/, '')));
      if (!row) throw new Error(`no row for ${n}`);
      const on = retro ? row.classList.contains('is-selected') || row.getAttribute('aria-current') === 'true' || row.getAttribute('aria-selected') === 'true'
        : row.getAttribute('aria-current') === 'true';
      if (!on) row.click();
    }, name, look.retro);
    await wait(1800);
  };
  const road = (look, value) => look.page.evaluate((v) => {
    const r = [...document.querySelectorAll('form.cmd-line input[type=radio]')].find((x) => x.value === v);
    if (r && !r.disabled && !r.checked) r.click();
  }, value);
  const send = async (look, command, ms = 5000) => {
    const input = await look.page.$('form.cmd-line input.cmd');
    await input.click();
    await input.type(command);
    await look.page.keyboard.press('Enter');
    await wait(ms);
  };
  const clickText = (look, scope, pattern) => look.page.evaluate((s, src) => {
    const rx = new RegExp(src, 'i');
    for (const root of [...document.querySelectorAll(s)].reverse()) {
      const el = [...root.querySelectorAll('button, summary, a')].find((x) => rx.test(x.innerText.trim()) && !x.disabled);
      if (el) { el.click(); return true; }
    }
    return false;
  }, scope, pattern.source);
  const confirmDialog = async (look) => {
    await look.page.waitForSelector('dialog.dlg[open]', { timeout: 5000 });
    await look.page.click('dialog.dlg[open] .row-end .button');
  };
  // The key tab with a replacement under way: the new key made, one node moved to it.
  const rekeyRound = async (look) => {
    await clickText(look, 'dialog[open]', /^make the new key$/);
    await wait(500);
    await look.page.evaluate(() => document.getElementById('rekey-title').closest('section').querySelector('form button[type=submit]').click());
    await wait(2500);
    const sent = await look.page.evaluate(() => {
      const b = [...document.querySelectorAll('.rekey-table tbody tr button')].find((x) => /^send$/i.test(x.innerText.trim()) && !x.disabled);
      if (b) b.click();
      return Boolean(b);
    });
    if (sent) {
      await confirmDialog(look);
      await wait(1500);
      await look.page.waitForFunction(() => !document.querySelector('.rekey-table [role=status]'), { timeout: 60000, polling: 500 }).catch(() => {});
      await wait(800);
    }
    await look.page.evaluate(() => document.getElementById('rekey-title')?.scrollIntoView({ block: 'start' }));
    await wait(400);
  };

  try {
    // The standard layout, the default: dark and light, desktop and phone.
    for (const [name, prefs] of [['standard-dark', {}], ['standard-light', { scheme: 'light' }]]) {
      const look = await context(prefs);
      await go(look, '', 1600, 900);
      await pick(look, WIFI);
      await send(look, 'get stats', 4500);
      await shot(look, `${name}-1600`);
      if (name === 'standard-dark') {
        // All nodes: the list and the map of the fleet.
        await go(look, '', 1600, 900);
        await shot(look, `${name}-overview`);
        // A node without Wi-Fi, reached through a relay: the two choosers, and an answer.
        await go(look, '', 1280, 960);
        await pick(look, MESH);
        await road(look, 'relay'); await wait(600);
        await send(look, 'ver', 5000);
        await send(look, 'get path.hash.mode', 5000);
        await shot(look, `${name}-relay`);
        // The command box with its suggestions.
        await go(look, '', 1280, 800);
        await pick(look, WIFI);
        await look.page.click('form.cmd-line input.cmd'); await wait(300);
        await look.page.keyboard.type('get '); await wait(500);
        await shot(look, `${name}-1280-commands`);
        await look.page.keyboard.press('Escape');
        await look.page.click('#std-tab-history'); await wait(900);
        await shot(look, `${name}-1280-history`);
        // An older node: the update that is out, and how it can be taken.
        await go(look, '', 1280, 800);
        await pick(look, OLD);
        await look.page.click('#std-tab-firmware'); await wait(900);
        await shot(look, `${name}-firmware`);
        // Adding a node that has no Wi-Fi by its key.
        await go(look, 'nodes', 1280, 800);
        await look.page.evaluate(() => { const d = [...document.querySelectorAll('dialog[open] details')]; d[d.length - 1].open = true; d[d.length - 1].scrollIntoView({ block: 'center' }); });
        await wait(500);
        await shot(look, `${name}-add-node`);
        // Replacing the command key on the nodes.
        await go(look, 'setup/key', 1280, 900);
        await rekeyRound(look);
        await shot(look, `${name}-rekey`);
        const sample = await look.page.evaluate(() => localStorage.getItem('mccontrol.selected'));
        await go(look, `neighbours/${sample}`, 1280, 800); await shot(look, `${name}-neighbours`);
        await go(look, '', 390, 844); await shot(look, `${name}-phone`);
      }
      await look.ctx.close();
    }

    // The retro board: amber (its default) and green, every tile filled, and each dialog.
    for (const theme of ['amber', 'green']) {
      const look = await context({ layout: 'retro', theme });
      await go(look, '', 1600, 900);
      await pick(look, WIFI);
      await send(look, 'get stats', 4500);
      await shot(look, `retro-${theme}-1600`);
      if (theme === 'amber') {
        await go(look, '', 1280, 800);
        await pick(look, WIFI);
        await shot(look, 'retro-amber-1280');
        // A node without Wi-Fi through a relay, on the board.
        await go(look, '', 1600, 900);
        await pick(look, MESH);
        await road(look, 'relay'); await wait(600);
        await send(look, 'ver', 5000);
        await shot(look, 'retro-relay');
        await go(look, '', 1280, 800);
        await look.page.evaluate(() => document.activeElement?.blur());
        await look.page.keyboard.press(':'); await wait();
        await look.page.keyboard.type('get r'); await wait();
        await shot(look, 'retro-palette');
        await look.page.keyboard.press('Escape'); await wait();
        await look.page.click('.status-row[data-line="companion"] .status-pick').catch(() => problems.push('retro: no companion line to click'));
        await wait(600);
        await shot(look, 'retro-companion-chooser');
        await look.page.keyboard.press('Escape'); await wait();
        await go(look, '', 1280, 800);
        await look.page.click('.result-row'); await wait(800);
        await shot(look, 'retro-result');
        const sample = await look.page.evaluate(() => document.querySelector('.node-row [data-node], .node-row')?.dataset?.node
          || document.querySelector('[data-node]')?.dataset.node || '');
        await go(look, `nodeinfo/${sample}`, 1280, 800); await shot(look, 'retro-node-details');
        for (const tab of ['key', 'node', 'connections', 'groups', 'sets', 'warnings', 'display']) {
          await go(look, `setup/${tab}`, 1280, 800); await shot(look, `retro-setup-${tab}`);
        }
        await go(look, '', 390, 844); await shot(look, 'retro-phone');
      }
      await look.ctx.close();
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
