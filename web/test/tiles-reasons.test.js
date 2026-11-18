// W-33e: a node with nothing to say has no reasons line (it showed "null").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reasonsText } from '../ui/tiles/node-view.js';

const t = (k, v) => `${k}${v ? `:${JSON.stringify(v)}` : ''}`;
test('no reasons, absent reasons: no text', () => {
  assert.equal(reasonsText(t, []), '');
  assert.equal(reasonsText(t, undefined), '');
  assert.equal(reasonsText(t, null), '');
});
test('reasons joined', () => {
  assert.equal(reasonsText(t, [{ kind: 'battery' }, { kind: 'silent', vars: { h: 3 } }]), 'dash.att.battery; dash.att.silent:{"h":3}');
});
