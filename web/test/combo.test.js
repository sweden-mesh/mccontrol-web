// W-33d: the suggestions only list what the node's firmware has; an unknown version lists all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestionsFor } from '../ui/command-combo.js';

const rules = { admits: (ver, c) => !(ver === 'old' && c.startsWith('set cmd')), deviceMeshOnly: (d) => Boolean(d.meshOnly), features: (v) => (v === 'bare' ? '' : 'arrc') };
const lines = [{ text: 'ver', command: 'ver' }, { text: 'set cmd on', command: 'set cmd on' }];
const svc = { rules };

test('a known version filters, an unknown one lists all and says so', () => {
  assert.deepEqual(suggestionsFor(svc, lines, [{ ver: 'old' }]), { lines: [lines[0]], unknown: false });
  assert.deepEqual(suggestionsFor(svc, lines, [{ ver: 'new' }]), { lines, unknown: false });
  assert.deepEqual(suggestionsFor(svc, lines, [{ ver: null }]), { lines, unknown: true });
  assert.deepEqual(suggestionsFor(svc, lines, [{ ver: 'old', meshOnly: true }]), { lines, unknown: true });
  assert.equal(suggestionsFor(svc, lines, [{ ver: 'old' }, { ver: null }]).unknown, true, 'one unknown among several');
  assert.deepEqual(suggestionsFor(svc, lines, [{ ver: 'bare' }]), { lines, unknown: true }, 'a version without its features');
});
