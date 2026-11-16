import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeOf, screenFor } from '../ui/app.js';
import { NOT_FOUND } from '../ui/screens/index.js';

test('hash routes', () => {
  assert.deepEqual(routeOf(''), { name: '', args: [] });
  assert.deepEqual(routeOf('#/'), { name: '', args: [] });
  assert.deepEqual(routeOf('#/node/4AC61A7F'), { name: 'node', args: ['4AC61A7F'] });
  assert.equal(screenFor('').route, '');
  assert.equal(screenFor('nope'), NOT_FOUND);
});
