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
import { seedFake, fakeBeacon, noBroker, renameLong, companionLong, unlockFake, FAKE_NODES } from './fake.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const LOOKS = ['amber', 'green', 'dark', 'light'];
const PHONES = [[360, 780], [390, 844], [412, 915]];
// The long-values pass (beta.3: "failed" over "Connect by USB" in STATUS): every tile at these.
const LONG_WIDTHS = [[1100, 800], [1280, 800], [1600, 900], [360, 780]];

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
    // scrolled out of a tile that scrolls inside itself: not shown, though the hit is an ancestor
    for (let e = el.parentElement; e; e = e.parentElement) {
      if (getComputedStyle(e).overflow === 'visible') continue;
      const c = e.getBoundingClientRect();
      if (x < c.left || x > c.right || y < c.top || y > c.bottom) return false;
    }
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

// Inside a tile's row, two boxes on top of each other, or one sticking out of its tile (clipped).
// A row: a list item or a row of columns. Its pieces: what shows text or takes a click.
const rowOverlaps = () => {
  const out = [];
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.clipPath === 'none' && !el.closest('[hidden]'); };
  const ellipsed = (el, row) => { for (let e = el.parentElement; e && e !== row.parentElement; e = e.parentElement) if (getComputedStyle(e).textOverflow === 'ellipsis' && getComputedStyle(e).overflow !== 'visible') return true; return false; };
  const label = (el) => `"${(el.textContent || el.tagName).trim().slice(0, 18)}"`;
  for (const tile of document.querySelectorAll('.tile')) {
    const body = tile.querySelector('.tile-body')?.getBoundingClientRect();
    if (!body?.width) continue;
    for (const row of tile.querySelectorAll('li, .row, .node-row, .result-row, .status-row, .tile-foot')) {
      const parts = [...row.querySelectorAll('.row-name, .mark-word, .glyph, button, a, input, .muted, span:not(:has(*)), code')]
        .filter((el) => visible(el) && !ellipsed(el, row) && el.closest('li, .row, .node-row, .result-row, .status-row, .tile-foot') === row);
      const boxes = parts.map((el) => [el, el.getBoundingClientRect()]);
      for (const [el] of boxes) {
        const cs = getComputedStyle(el);
        if (cs.display !== 'inline' && cs.overflow === 'visible' && el.scrollWidth > el.clientWidth + 1) out.push(`${tile.dataset.tile}: ${label(el)} runs out of its box by ${el.scrollWidth - el.clientWidth}px`);
      }
      for (const [el, r] of boxes) {
        if (r.right > body.right + 1 || r.left < body.left - 1) out.push(`${tile.dataset.tile}: ${label(el)} sticks out of the tile by ${Math.round(Math.max(r.right - body.right, body.left - r.left))}px`);
      }
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const [a, ra] = boxes[i]; const [b, rb] = boxes[j];
          if (a.contains(b) || b.contains(a)) continue;
          const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
          const hgt = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
          if (w > 1 && hgt > 1) out.push(`${tile.dataset.tile}: ${label(a)} overlaps ${label(b)}`);
        }
      }
    }
  }
  return [...new Set(out)];
};

const wait = (ms = 300) => new Promise((ok) => setTimeout(ok, ms));

// The board as a person uses it, with the fake data: what each step must show.
async function interact(page, go, sample) {
  const problems = [];
  const step = async (what, fn) => { try { const p = await fn(); if (p) problems.push(`${what}: ${p}`); } catch (err) { problems.push(`${what}: ${err.message}`); } };
  const state = () => page.evaluate(() => ({
    hash: location.hash, modal: document.querySelector('#modal[open]')?.dataset.modal || null,
    node: document.querySelector('.tile[data-tile="node"] h2:not(.tile-title), .tile[data-tile="node"] .node-modal-title, .tile[data-tile="node"] .node-name')?.textContent || '',
    prompt: document.querySelector('.tile[data-tile="node"] .cmd-prompt, #modal[open] .cmd-prompt')?.textContent || '',
    current: document.querySelector('.node-row[aria-current="true"]')?.textContent || '',
    send: document.querySelector('.tile[data-tile="node"] .cmd-send')?.textContent || '',
    fresh: document.querySelectorAll('.result-item.is-new').length,
    palette: document.querySelector('#palette-input') ? document.querySelectorAll('#palette-list [role="option"]').length : -1,
  }));
  await go(page, '', 1280, 800);
  await step('a click selects the row and fills NODE', async () => {
    await page.click('.node-row'); await wait();
    const s = await state();
    if (!s.current) return 'no row is current';
    if (!s.prompt.includes('SE-JKG-')) return `the command line says "${s.prompt}"`;
    return s.modal ? `a modal opened on a desktop: ${s.modal}` : null;
  });
  await step('the box tags, the command line sends to the tagged', async () => {
    for (const i of [1, 2]) { await (await page.$$('.tag-box'))[i].click(); await wait(); }
    const s = await state();
    return /2/.test(s.send) ? null : `the send button says "${s.send}"`;
  });
  await step("':' opens the palette, typing narrows, Esc closes", async () => {
    await page.focus('body'); await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press(':'); await wait();
    const before = (await state()).palette;
    if (before <= 0) return `palette entries: ${before}`;
    await page.keyboard.type('get name'); await wait();
    const after = (await state()).palette;
    if (!(after > 0 && after < before)) return `typing did not narrow: ${before} -> ${after}`;
    await page.keyboard.press('Escape'); await wait();
    return page.evaluate(() => (document.querySelector('#palette-input')?.checkVisibility() ? 'still open after Esc' : null));
  });
  await step('a result opens and is then seen', async () => {
    const before = (await state()).fresh;
    await page.click('.result-item.is-new .result-row'); await wait(500);
    let s = await state();
    if (s.modal !== 'result') return `modal ${s.modal}`;
    await page.keyboard.press('Escape'); await wait(500);
    s = await state();
    return s.fresh === before - 1 ? null : `new results ${before} -> ${s.fresh}`;
  });
  await go(page, '', 360, 780);
  await step('on a phone a row opens the node full screen', async () => {
    await page.click('.node-row'); await wait(500);
    const s = await state();
    if (s.modal !== 'node' || !/^#node\/[0-9A-F]{8}$/.test(s.hash)) return `modal ${s.modal}, hash ${s.hash}`;
    await page.goBack(); await wait(500);
    return (await state()).modal ? 'Back did not close it' : null;
  });
  await step('Mark all seen empties the new results', async () => {
    // Scrolled clear of the fixed key bar first, as a person would: Puppeteer's own scroll stops
    // with it at the bottom edge, under the bar, once HISTORY shows one node's few rows (W-25d).
    await page.$eval('.tile[data-tile="results"] .tile-foot .link-button', (b) => b.scrollIntoView({ block: 'center' }));
    await page.click('.tile[data-tile="results"] .tile-foot .link-button'); await wait(500);
    const s = await state();
    return s.fresh === 0 ? null : `${s.fresh} still new`;
  });
  return problems;
}

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
    await unlockFake(page);   // past the unlock gate (W-28b); noBroker keeps it off the air
    await new Promise((ok) => setTimeout(ok, 700));
  };
  const shot = (page, name, fullPage = false) => page.screenshot({ path: join(o.out, `${name}.png`), fullPage });
  const sample = FAKE_NODES[4].node;

  try {
    for (const look of LOOKS) {
      const { ctx, page, problems } = await context(look);
      const views = [...PHONES.map(([w, hh]) => [w, hh, '']), ...PHONES.map(([w, hh]) => [w, hh, `node/${sample}`]),
        [740, 360, ''], [740, 360, `node/${sample}`], [1280, 800, ''],
        // Every modal with data, as a phone's full-screen sheet.
        ...['setup/key', 'setup/node', 'setup/area', 'setup/groups', 'setup/sets', 'setup/warnings', 'setup/display', 'help', 'history',
          'nodes', `nodeinfo/${sample}`, `stats/${sample}`, `run/cmd/n:${sample}/ver`, 'run/set/-'].map((x) => [360, 780, x])];
      for (const [w, hh, hash] of views) {
        problems.length = 0;
        try {
          await go(page, hash, w, hh);
          const seen = await page.evaluate(inspect);
          const rows = await page.evaluate(() => document.querySelectorAll('.node-row').length);
          if (!rows) seen.push('no node rows');
          if (hash) {
            const sheet = await page.evaluate(() => { const d = document.querySelector('#modal[open]'); const r = d?.getBoundingClientRect();
              return d ? { name: d.dataset.modal, w: r.width, h: r.height, labelled: Boolean(document.getElementById(d.getAttribute('aria-labelledby') || '-')) } : null; });
            if (!sheet || sheet.name !== hash.split('/')[0]) seen.push(`modal ${sheet?.name} open`);
            else if (!sheet.labelled) seen.push('the dialog is not labelled by its heading');
            else if (w < 720 && (Math.round(sheet.w) !== w || Math.round(sheet.h) !== hh)) seen.push(`not a full-screen sheet: ${Math.round(sheet.w)}x${Math.round(sheet.h)}`);
          }
          await shot(page, `${look}-${w}x${hh}-${hash.replace(/\W+/g, '_') || 'board'}`, !hash && w < 720);
          report(`${look} ${w}x${hh} #${hash}`, [...problems, ...seen]);
        } catch (err) { report(`${look} ${w}x${hh} #${hash}`, [err.message]); }
      }
      if (look === 'amber') report('the board, used: select, tag, palette, a result', await interact(page, go, sample));
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
      // One "Show passphrase" per form, showing every passphrase field of it together (beta.3 bench).
      for (const [hash, prep] of [['setup/key', null], ['unlock/replace', 0], ['unlock/replace', 1]]) {
        const where = `${look} 1280x800 #${hash}${prep === null ? '' : ` ${['make', 'import'][prep]}`}: one passphrase toggle per form`;
        problems.length = 0;
        try {
          await go(page, hash, 1280, 800);
          const seen = await page.evaluate(async (pick) => {
            const out = [];
            const scope = document.querySelector('#modal[open]') || document;
            for (const d of scope.querySelectorAll('details')) d.open = true;
            if (pick !== null) scope.querySelectorAll('.choice-row button')[pick]?.click();
            if (pick === 1) { const p = scope.querySelector('#import-paste'); p.value = 'ab'.repeat(32); p.dispatchEvent(new Event('input')); }
            await new Promise((ok) => setTimeout(ok, 200));
            let multi = 0;
            for (const form of scope.querySelectorAll('form')) {
              const fields = [...form.querySelectorAll('input[autocomplete$="-password"]')].filter((i) => i.offsetParent);
              const toggles = [...form.querySelectorAll('.show-pass input')];
              if (toggles.length > 1) out.push(`a form has ${toggles.length} Show passphrase boxes`);
              if (fields.length < 2) continue;
              multi += 1;
              const box = toggles.find((x) => x.offsetParent);
              if (!box) { out.push('a form with several passphrase fields has no visible toggle'); continue; }
              box.click();
              if (fields.some((i) => i.type !== 'text')) out.push('the toggle did not show every field');
              if (!form.querySelector('[autocomplete="new-password"]')) out.push('new-password autocomplete lost');
              form.scrollIntoView();
            }
            if (!multi) out.push('no form with several passphrase fields found');
            return out;
          }, prep);
          await shot(page, `pass-toggle-${look}-${hash.replace(/\W+/g, '_')}${prep === null ? '' : `-${['make', 'import'][prep]}`}`);
          report(where, [...problems, ...seen]);
        } catch (err) { report(where, [err.message]); }
      }
      // The long values: names at 31 bytes, a long companion error, then a long companion name.
      await renameLong(page);
      for (const [w, hh] of LONG_WIDTHS) {
        for (const how of ['error', 'connected']) {
          problems.length = 0;
          const where = `${look} ${w}x${hh} long values, companion ${how}`;
          try {
            await go(page, '', w, hh);
            if (w >= 720) { await page.click('.node-row'); await wait(); }
            await companionLong(page, how);
            await wait();
            const word = await page.evaluate(() => document.querySelector('.status-row[data-line="companion"] .mark-word')?.textContent || '');
            const seen = [...await page.evaluate(inspect), ...await page.evaluate(rowOverlaps)];
            if (how === 'connected' ? !word.includes('Kvarnbergsvägen') : word.length > 30 || !word) seen.push(`the companion line says "${word}"`);
            const status = await page.$('.tile[data-tile="status"]');
            await status.screenshot({ path: join(o.out, `long-${look}-${w}-status-${how}.png`) });
            if (how === 'error') await shot(page, `long-${look}-${w}x${hh}-board`, w < 720);
            report(where, [...problems, ...seen]);
          } catch (err) { report(where, [err.message]); }
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
