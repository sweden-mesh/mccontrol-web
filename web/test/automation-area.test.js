// ui/automation.js after a reload: the key starts locked, nothing is scheduled or signed, and no
// area is in the snapshot or the status line: there is none to choose (W-33g, IATA-2). An area
// stored by an older version is ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automationState, startAutomation } from '../ui/automation.js';
import { statusItems } from '../ui/statusline.js';
import { createDiscovery } from '../lib/discovery/index.js';
import { createRefresh } from '../lib/refresh/index.js';
import { areasTable, fakeBeacon, fakeClock, fakeJobs, memStores, OWNER } from './auto-fakes.js';

test('a locked key: nothing scheduled, no area anywhere, an old stored area ignored', async () => {
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
        discovery: createDiscovery({ stores, jobs, clock, unlocked: () => false }),
        refresh: createRefresh({ stores, jobs, beacon: fakeBeacon({}), clock, unlocked: () => false }),
      }),
    },
  });
  const s = automationState();
  assert.equal(s.unlocked, false);
  assert.equal('area' in s, false);
  assert.deepEqual(s.discovery.regions, []);
  assert.equal(s.discovery.scheduled, false);
  assert.equal(s.discovery.nextRun, null);
  assert.equal(statusItems().find((i) => i.name === 'area'), undefined, 'no area in the status line (W-33g)');
  assert.equal(jobs.calls.length, 0);
});
