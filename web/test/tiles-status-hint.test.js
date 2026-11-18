// W-35b: a node row's tooltip says every reason on its own line, or that all is well.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusLines } from '../ui/status-hint.js';

const ctx = { t: (k, v) => ({ 'dash.att.battery': `battery ${v?.volts} V`, 'dash.att.refused': `refused ${v?.command}` }[k] || k) };

test('every reason, its own severity, the first letter upper case', () => {
  assert.deepEqual(statusLines(ctx, { state: 'alert', reasons: [{ kind: 'refused', vars: { command: 'ver' } }, { kind: 'battery', vars: { volts: '3.30' } }] }),
    [{ state: 'alert', text: 'Refused ver' }, { state: 'warn', text: 'Battery 3.30 V' }]);
});
test('no reasons: all OK, or not known for a node never heard', () => {
  assert.deepEqual(statusLines(ctx, { state: 'ok', reasons: [] }), [{ state: 'ok', text: 'hint.allOk' }]);
  assert.deepEqual(statusLines(ctx, { state: 'unknown', reasons: [] }), [{ state: 'unknown', text: 'hint.notKnown' }]);
});
