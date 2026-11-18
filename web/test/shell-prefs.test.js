import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPrefs, writePref, schemeFor, migratePrefs, themeFrom, CHOICES, RETIRED } from '../ui/prefs.js';
import { shortKey } from '../ui/key-state.js';
import { memory } from './prefs-fakes.js';

test('nothing stored: amber, the browser language', () => {
  assert.deepEqual(readPrefs(memory()), { theme: 'amber', lang: 'browser', layout: 'standard', scheme: 'dark', colorblind: 'off' });
  assert.deepEqual(CHOICES.theme, ['amber', 'green', 'dark', 'light']);
});

test('a choice is stored, the default removes it', () => {
  const s = memory();
  writePref('theme', 'light', s);
  writePref('lang', 'en', s);
  assert.deepEqual(readPrefs(s), { theme: 'light', lang: 'en', layout: 'standard', scheme: 'dark', colorblind: 'off' });
  assert.deepEqual(Object.fromEntries(s.m), { 'mccontrol.theme': 'light', 'mccontrol.lang': 'en' });
  writePref('theme', 'amber', s);
  writePref('lang', 'browser', s);
  assert.equal(s.m.size, 0);
  assert.throws(() => writePref('theme', 'purple', s));
  assert.throws(() => writePref('cvd', 'on', s));
});

test('the layout (W-29): standard by default, its own dark or light, colour-blind; the retro theme kept', () => {
  const s = memory();
  writePref('theme', 'green', s);
  writePref('layout', 'retro', s);
  writePref('scheme', 'light', s);
  writePref('colorblind', 'on', s);
  const p = readPrefs(s);
  assert.deepEqual([p.theme, p.layout, p.scheme, p.colorblind], ['green', 'retro', 'light', 'on']);
  assert.equal(schemeFor(p), 'dark', 'the retro board shows its own theme');
  assert.equal(schemeFor({ ...p, layout: 'standard' }), 'light');
  writePref('layout', 'standard', s);
  assert.equal(s.m.get('mccontrol.layout'), undefined, 'the default is stored as nothing');
  assert.equal(readPrefs(memory({ 'mccontrol.layout': 'nonsense' })).layout, 'standard');
});

test('old settings move to the one theme: terminal screen first, then light or dark, else amber', () => {
  const cases = [
    [{ 'mccontrol.phosphor': 'green', 'mccontrol.theme': 'light' }, 'green'],
    [{ 'mccontrol.phosphor': 'amber', 'mccontrol.theme': 'dark', 'mccontrol.cvd': '1' }, 'amber'],
    [{ 'mccontrol.theme': 'light', 'mccontrol.motion': 'off' }, 'light'],
    [{ 'mccontrol.theme': 'dark' }, 'dark'],
    [{ 'mccontrol.cvd': '1' }, 'amber'],
    [{ 'mccontrol.phosphor': 'purple', 'mccontrol.theme': 'system' }, 'amber'],
  ];
  for (const [init, theme] of cases) {
    const s = memory({ ...init, 'mccontrol.lang': 'sv' });
    assert.equal(readPrefs(s).theme, theme, JSON.stringify(init));
    migratePrefs(s);
    assert.equal(readPrefs(s).theme, theme, `after: ${JSON.stringify(init)}`);
    for (const name of RETIRED) assert.equal(s.getItem(`mccontrol.${name}`), null, name);
    assert.equal(s.getItem('mccontrol.lang'), 'sv');
    assert.equal(s.getItem('mccontrol.theme'), theme === 'amber' ? null : theme);
  }
  assert.equal(themeFrom(() => null), 'amber');
});

test('blocked or junk storage reads as the defaults', () => {
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(readPrefs(blocked).theme, 'amber');
  writePref('theme', 'dark', blocked);   // no throw
  migratePrefs(blocked);                 // no throw
  assert.equal(readPrefs(memory({ 'mccontrol.theme': 'purple' })).theme, 'amber');
});

test('only Light is a light scheme', () => {
  for (const theme of CHOICES.theme) assert.equal(schemeFor({ theme }), theme === 'light' ? 'light' : 'dark');
});

test('a public key shortened for the header', () => {
  assert.equal(shortKey('4ac61a7f00112233445566778899aabbccddeeff00112233445566778899e2a1'), '4AC61A7F…E2A1');
  assert.equal(shortKey(null), '');
});
