import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readPrefs, writePref, schemeFor, CHOICES } from '../ui/prefs.js';
import { shortKey } from '../ui/key-state.js';

function memory() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

test('nothing stored: follow the system and the browser', () => {
  assert.deepEqual(readPrefs(memory()),
    { theme: 'system', phosphor: 'off', cvd: 'off', motion: 'system', lang: 'browser' });
});

test('a choice is stored, the default removes it', () => {
  const s = memory();
  writePref('theme', 'dark', s);
  writePref('phosphor', 'amber', s);
  writePref('cvd', 'on', s);
  writePref('motion', 'reduce', s);
  writePref('lang', 'en', s);
  assert.deepEqual(readPrefs(s), { theme: 'dark', phosphor: 'amber', cvd: 'on', motion: 'reduce', lang: 'en' });
  // The keys ui/boot.js reads before the first paint.
  assert.deepEqual(Object.fromEntries(s.m), { 'mccontrol.theme': 'dark', 'mccontrol.phosphor': 'amber',
    'mccontrol.cvd': '1', 'mccontrol.motion': 'off', 'mccontrol.lang': 'en' });
  for (const name of Object.keys(CHOICES)) writePref(name, CHOICES[name][0], s);
  assert.equal(s.m.size, 0);
  assert.throws(() => writePref('theme', 'purple', s));
});

test('blocked or junk storage reads as the defaults', () => {
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
  assert.equal(readPrefs(blocked).theme, 'system');
  writePref('theme', 'dark', blocked);   // no throw
  const s = memory();
  s.setItem('mccontrol.phosphor', 'purple');
  assert.equal(readPrefs(s).phosphor, 'off');
});

test('the phosphor theme is always dark', () => {
  assert.equal(schemeFor({ theme: 'system', phosphor: 'off' }), 'light dark');
  assert.equal(schemeFor({ theme: 'light', phosphor: 'off' }), 'light');
  assert.equal(schemeFor({ theme: 'light', phosphor: 'green' }), 'dark');
});

test('boot.js reads the keys prefs.js writes', () => {
  const boot = readFileSync(new URL('../ui/boot.js', import.meta.url), 'utf8');
  for (const name of ['theme', 'phosphor', 'cvd', 'motion']) assert.ok(boot.includes(`get('${name}')`), name);
  assert.ok(boot.includes("'mccontrol.' + name"));
});

test('a public key shortened for the header', () => {
  assert.equal(shortKey('4ac61a7f00112233445566778899aabbccddeeff00112233445566778899e2a1'), '4AC61A7F…E2A1');
  assert.equal(shortKey(null), '');
});
