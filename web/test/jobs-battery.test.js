// W-26j: no battery reading is "NA", never "0.00 V"; 0 mV and a missing value are the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batteryKnown, needsAttention, voltsText } from '../lib/jobs/overview.js';

test('a battery reading: volts, or NA for 0 mV and for none', () => {
  assert.equal(voltsText(3980), '3.98 V');
  assert.equal(voltsText(3100), '3.10 V');
  for (const none of [0, null, undefined, NaN, -1]) {
    assert.equal(voltsText(none), 'NA');
    assert.equal(batteryKnown(none), false);
  }
});

test('0 mV is no reading, so it is not a low battery; 3.1 V is', () => {
  const rules = { revision: () => null, admits: () => true };
  const at = (mv, node) => ({ node, name: node, fleet: { batteryMv: mv, seen: '2026-11-18T10:00:00Z' } });
  const out = needsAttention([at(0, 'ZERO'), at(null, 'NONE'), at(3100, 'LOW')], { now: Date.parse('2026-11-18T11:00:00Z'), hours: 24, thresholdMv: 3500, rules });
  assert.deepEqual(out.filter((x) => x.kind === 'battery').map((x) => [x.node, x.vars.volts]), [['LOW', '3.10']]);
});
