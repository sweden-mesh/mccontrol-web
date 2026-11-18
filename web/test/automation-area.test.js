// ui/automation.js after a reload: the key starts locked, and the area stored for it must still
// be in the snapshot (W-23e; no longer on the status line, W-33g), with nothing scheduled or signed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automationState, startAutomation } from '../ui/automation.js';
import { statusItems } from '../ui/statusline.js';
import { createDiscovery } from '../lib/discovery/index.js';
import { createRefresh } from '../lib/refresh/index.js';
import { areasTable, fakeBeacon, fakeClock, fakeJobs, memStores, OWNER } from './auto-fakes.js';

test('a locked key shows the area stored for it', async () => {
  const clock = fakeClock();
  const stores = memStores(clock);
  await stores.meta.set('area', '06');
  const jobs = fakeJobs(stores, {});
  const status = { exists: true, locked: true, publicKeyHex: OWNER };
  await startAutomation({
    t: () => (k) => k,
    deps: {
      table: areasTable,
      keyStatus: () => status,
      onKeyStatus: () => () => {},
      make: async () => ({
        discovery: createDiscovery({ stores, jobs, table: areasTable, clock, unlocked: () => false }),
        refresh: createRefresh({ stores, jobs, beacon: fakeBeacon({}), clock, unlocked: () => false }),
      }),
    },
  });
  const s = automationState();
  assert.equal(s.unlocked, false);
  assert.equal(s.area.label, 'Jönköpings län · se-jkp');
  assert.equal(s.discovery.scheduled, false);
  assert.equal(s.discovery.nextRun, null);
  assert.equal(statusItems().find((i) => i.name === 'area'), undefined, 'no area in the status line (W-33g)');
  assert.equal(jobs.calls.length, 0);
});
