// ui/boot.js runs before the first paint as a plain script: run it here in a small stand-in page
// and check that it agrees with ui/prefs.js on the theme and the migration, and that its start
// guard draws a visible message when a module fails before ui/app.js has started (W-20k).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { readPrefs, migratePrefs, schemeFor } from '../ui/prefs.js';
import { memory } from './prefs-fakes.js';

const SOURCE = readFileSync(new URL('../ui/boot.js', import.meta.url), 'utf8');

function element(tag) {
  const attrs = new Map();
  return {
    tagName: tag.toUpperCase(), children: [], textContent: '', value: '', id: '', className: '',
    setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    hasAttribute: (k) => attrs.has(k), removeAttribute: (k) => attrs.delete(k),
    append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; },
  };
}

function page(storage, language = 'en-GB') {
  const root = element('html');
  const meta = element('meta');
  const main = element('main');
  const listeners = [];
  const window = {
    localStorage: storage, navigator: { language },
    addEventListener: (type, fn) => listeners.push([type, fn]),
    document: {
      documentElement: root, createElement: element,
      querySelector: (sel) => (sel.includes('color-scheme') ? meta : null),
      getElementById: (id) => (id === 'main' ? main : null),
    },
  };
  window.window = window;
  vm.runInNewContext(SOURCE, window);
  const fire = (event) => { for (const [type, fn] of listeners) if (type === event.type) fn(event); };
  return { root, meta, main, fire, window };
}

test('boot.js applies the same theme as prefs.js, and migrates the same way', () => {
  const cases = [{}, { 'mccontrol.theme': 'light' }, { 'mccontrol.scheme': 'light', 'mccontrol.colorblind': 'on' }, { 'mccontrol.theme': 'dark', 'mccontrol.cvd': '1' },
    { 'mccontrol.phosphor': 'green', 'mccontrol.theme': 'light', 'mccontrol.motion': 'off' },
    { 'mccontrol.phosphor': 'amber' }, { 'mccontrol.theme': 'green' }, { 'mccontrol.theme': 'system' }];
  for (const init of cases) {
    const expected = readPrefs(memory(init)).theme;
    const viaPrefs = memory(init);
    migratePrefs(viaPrefs);
    const viaBoot = memory(init);
    const { root, meta } = page(viaBoot);
    assert.equal(root.getAttribute('data-theme'), expected, JSON.stringify(init));
    // The standard layout (the default, W-29) is dark unless its own setting says light.
    assert.equal(meta.getAttribute('content'), schemeFor(readPrefs(memory(init))));
    assert.equal(root.getAttribute('data-layout'), 'standard');
    assert.deepEqual(Object.fromEntries(viaBoot.m), Object.fromEntries(viaPrefs.m), JSON.stringify(init));
  }
});

test('boot.js survives storage that throws', () => {
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(page(blocked).root.getAttribute('data-theme'), 'amber');
});

test('a module that fails before the app starts leaves a message, not a blank page', () => {
  const p = page(memory());
  p.fire({ type: 'error', target: p.window, error: new TypeError("Failed to create the policy 'mccontrol-sw'"), message: 'x' });
  assert.ok(p.root.hasAttribute('data-start-failed'));
  const [box] = p.main.children;
  assert.equal(box.className, 'start-error');
  const text = JSON.stringify(box.children.map((c) => c.textContent || c.value));
  assert.match(text, /could not start in this browser/);
  assert.match(text, /mccontrol-sw/);
});

test('a script that does not load is named; Swedish for a Swedish browser', () => {
  const p = page(memory(), 'sv-SE');
  p.fire({ type: 'error', target: { tagName: 'SCRIPT', src: 'https://x/ui/app.js' } });
  const text = JSON.stringify(p.main.children[0].children.map((c) => c.textContent || c.value));
  assert.match(text, /kunde inte starta/);
  assert.match(text, /ui\/app\.js/);
});

test('after the start, or for an image that fails, the guard stays quiet', () => {
  const p = page(memory());
  p.fire({ type: 'error', target: { tagName: 'IMG', src: 'x.png' } });
  assert.equal(p.main.children.length, 0);
  p.root.setAttribute('data-started', '');
  p.fire({ type: 'error', target: p.window, error: new Error('late'), message: 'late' });
  assert.equal(p.main.children.length, 0);
});
