import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickLanguage, translator, LANGUAGES } from '../i18n/i18n.js';

const strings = Object.fromEntries(LANGUAGES.map((l) => [l,
  JSON.parse(readFileSync(new URL(`../i18n/${l}.json`, import.meta.url), 'utf8'))]));

test('the language follows the browser, Swedish when none fits', () => {
  assert.equal(pickLanguage(['en-GB', 'sv']), 'en');
  assert.equal(pickLanguage(['sv-SE']), 'sv');
  assert.equal(pickLanguage(['de-DE', 'fr']), 'sv');
  assert.equal(pickLanguage([]), 'sv');
  assert.equal(pickLanguage(['sv'], 'en'), 'en');
});

test('every language has every key', () => {
  const keys = (l) => Object.keys(strings[l]).sort();
  for (const l of LANGUAGES) assert.deepEqual(keys(l), keys('sv'), l);
});

test('a translator fills names and shows a missing key as itself', () => {
  const t = translator({ hi: 'Hej {name}' });
  assert.equal(t('hi', { name: 'Ada' }), 'Hej Ada');
  assert.equal(t('nope'), 'nope');
});
