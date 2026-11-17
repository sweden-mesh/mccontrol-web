import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHash, legacyHash, targetHash, modalHash, INTO_SETUP } from '../ui/routes.js';
import { isModal, modalNames, registerModal } from '../ui/modal.js';
import { TILES, tileDef, registerTile } from '../ui/board.js';
import { SCREENS } from '../ui/screens/index.js';
import { MODALS } from '../ui/modals/index.js';
import { TABS } from '../ui/modals/setup.js';
import '../ui/tiles/index.js';

const sv = JSON.parse(readFileSync(new URL('../i18n/sv.json', import.meta.url), 'utf8'));

test('the hash: the board, a modal, an old route, an in-page anchor', () => {
  for (const h of ['', '#', '#/']) assert.deepEqual(parseHash(h, isModal), { kind: 'board' });
  assert.deepEqual(parseHash('#node/4AC61A7F', isModal), { kind: 'modal', name: 'node', args: ['4AC61A7F'] });
  assert.deepEqual(parseHash('#setup/groups/my%20group', isModal), { kind: 'modal', name: 'setup', args: ['groups', 'my group'] });
  assert.deepEqual(parseHash('#main', isModal), { kind: 'other' });
  assert.deepEqual(parseHash('#/nodes', isModal), { kind: 'legacy', hash: '#nodes' });
});

test('every old route lands somewhere sensible', () => {
  const cases = {
    '#/': '', '#/nodes': '#nodes', '#/node/4AC61A7F': '#node/4AC61A7F', '#/send': '#send',
    '#/history': '#history', '#/history/4AC61A7F': '#history/4AC61A7F', '#/help': '#help',
    '#/help/codes': '#help/codes', '#/unlock': '#unlock', '#/unlock/to/node/AB': '#unlock/to/node/AB',
    '#/unlock/replace': '#unlock/replace', '#/stats/13B58595': '#stats/13B58595',
    '#/key': '#setup/key', '#/settings': '#setup/settings', '#/setup': '#setup/node',
    '#/groups': '#setup/groups', '#/groups/a%20b': '#setup/groups/a%20b', '#/sets': '#setup/sets',
    '#/no-such-page': '#notfound',
  };
  for (const [from, to] of Object.entries(cases)) assert.equal(legacyHash(from, isModal), to, from);
  // Every old screen's route is covered: a modal of its own or a Setup tab.
  for (const s of SCREENS) {
    if (s.route === '') continue;
    assert.ok(isModal(s.route) || INTO_SETUP[s.route], `old route ${s.route}`);
    if (INTO_SETUP[s.route]) assert.ok(TABS[INTO_SETUP[s.route]], `setup tab for ${s.route}`);
  }
  assert.equal(targetHash('#/key', isModal), '#setup/key');
  assert.equal(targetHash('#/', isModal), '');
  assert.equal(targetHash('#help', isModal), '#help');
  assert.equal(modalHash('setup', ['groups', 'a/b']), '#setup/groups/a%2Fb');
});

test('the modals: named, titled, rendered, dismissal chosen', () => {
  assert.deepEqual(modalNames().sort(), MODALS.map((m) => m.name).sort());
  for (const m of MODALS) {
    assert.equal(typeof m.render, 'function', m.name);
    assert.ok(m.title in sv, `title ${m.title}`);
    assert.ok([undefined, 'any', 'closerequest'].includes(m.closedby), m.name);
  }
  for (const [, [label]] of Object.entries(TABS)) assert.ok(label in sv, `tab ${label}`);
  assert.throws(() => registerModal({ name: 'help', render() {} }), /twice/);
  assert.throws(() => registerModal({ name: 'Bad Name', render() {} }), /name/);
});

test('the board has its five tiles, each titled', () => {
  assert.deepEqual([...TILES], ['nodes', 'node', 'status', 'map', 'results']);
  for (const id of TILES) {
    const def = tileDef(id);
    assert.ok(def, id);
    assert.ok(def.title in sv, `title ${def.title}`);
  }
  assert.throws(() => registerTile({ id: 'clock', render() {} }), /no tile/);
  assert.throws(() => registerTile({ id: 'map', render() {} }), /twice/);
});
