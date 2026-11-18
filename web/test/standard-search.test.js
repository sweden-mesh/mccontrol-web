// W-29g: the standard layout's node search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeMatches } from '../ui/standard/search.js';

const d = { name: 'SE-JKG-Väster-65c1', node: '65C1D12C', key: '65C1D12C' + 'ab'.repeat(28) };

test('name: substring, case and diacritics ignored', () => {
  assert.ok(nodeMatches(d, 'vaster'));
  assert.ok(nodeMatches(d, 'VÄST'));
  assert.ok(nodeMatches(d, '  '));
  assert.ok(!nodeMatches(d, 'öster'));
  assert.ok(nodeMatches({ name: 'SE-JKG-Öxnehaga-7316', node: '7316CA78' }, 'oxne'));
});

test('hex: a prefix of the public key or the control id, not a substring', () => {
  assert.ok(nodeMatches(d, '65c1d'));
  assert.ok(nodeMatches(d, '65C1D12CAB'));
  assert.ok(!nodeMatches(d, 'd12c'));
  assert.ok(nodeMatches({ name: 'x', node: 'D12C0000' }, 'd12c'));
});
