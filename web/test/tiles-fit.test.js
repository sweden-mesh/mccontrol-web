// W-33a: STATUS's times in four lengths, the longest first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageParts } from '../ui/tiles/kit.js';

test('the parts of an age', () => {
  assert.deepEqual(ageParts(30000), [0, 'now']);
  assert.deepEqual(ageParts(13 * 60000), [13, 'min']);
  assert.deepEqual(ageParts(5 * 3600000), [5, 'h']);
  assert.deepEqual(ageParts(3 * 86400000), [3, 'd']);
});
