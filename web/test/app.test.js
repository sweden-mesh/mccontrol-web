import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routeOf, screenFor } from '../ui/app.js';
import { SCREENS, NAV, NOT_FOUND } from '../ui/screens/index.js';

const sv = JSON.parse(readFileSync(new URL('../i18n/sv.json', import.meta.url), 'utf8'));

test('hash routes', () => {
  assert.deepEqual(routeOf(''), { name: '', args: [] });
  assert.deepEqual(routeOf('#/'), { name: '', args: [] });
  assert.deepEqual(routeOf('#/node/4AC61A7F'), { name: 'node', args: ['4AC61A7F'] });
  assert.equal(screenFor('').route, '');
  assert.equal(screenFor('nope'), NOT_FOUND);
});

test('every screen of plan §7 and the dashboard has a route, a title and a renderer', () => {
  const routes = SCREENS.map((s) => s.route);
  for (const r of ['', 'unlock', 'key', 'setup', 'nodes', 'node', 'groups', 'history', 'settings', 'help']) {
    assert.ok(routes.includes(r), `route ${r}`);
  }
  assert.equal(new Set(routes).size, routes.length, 'a route twice');
  for (const s of [...SCREENS, NOT_FOUND]) {
    assert.equal(typeof s.render, 'function', s.route);
    assert.ok(s.title in sv, `title ${s.title}`);
  }
  for (const r of NAV) assert.notEqual(screenFor(r), NOT_FOUND, `menu entry ${r}`);
});
