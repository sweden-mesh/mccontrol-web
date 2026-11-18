// ui/automation.js: follows the key (Beacon with any key, discovery only unlocked), publishes the
// snapshot the STATUS tile reads, sets the status line's area, and says what discovery added with
// an undo. Fake key source, fake clock, fake jobs and Beacon: nothing leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  automationState, onAutomation, startAutomation, setArea, lookNow, undoDiscovery, areaChoices, refreshNow,
} from '../ui/automation.js';
import { statusItems } from '../ui/statusline.js';
import { createDiscovery } from '../lib/discovery/index.js';
import { createRefresh } from '../lib/refresh/index.js';
import { areasTable, fakeBeacon, fakeClock, fakeJobs, memStores, OWNER, settle } from './auto-fakes.js';

test('follows the key, publishes the snapshot, the area and what discovery added', async () => {
  const clock = fakeClock();
  const stores = memStores(clock);
  const jobs = fakeJobs(stores, { JKG: [{ node: '4AC61A7F', name: 'Gisebo' }] });
  let status = { exists: true, locked: true, publicKeyHex: OWNER };
  const keyListeners = new Set();
  const messages = [];
  const t = (k, v = {}) => `${k}${Object.keys(v).length ? ` ${JSON.stringify(v)}` : ''}`;
  await startAutomation({
    t: () => t,
    notify: (text, opts) => messages.push({ text, opts }),
    deps: {
      table: areasTable,
      keyStatus: () => status,
      onKeyStatus: (fn) => { keyListeners.add(fn); return () => keyListeners.delete(fn); },
      make: async () => ({
        discovery: createDiscovery({ stores, jobs, table: areasTable, clock, unlocked: () => !status.locked }),
        refresh: createRefresh({ stores, jobs, beacon: fakeBeacon({}), clock, unlocked: () => !status.locked }),
      }),
    },
  });
  const seen = [];
  onAutomation((s) => seen.push(s.changed));

  let s = automationState();
  assert.equal(s.owner, OWNER);
  assert.equal(s.unlocked, false);
  assert.equal(s.discovery.scheduled, false);
  assert.equal(s.refresh.scheduled, true);
  assert.equal(s.area, null);
  assert.equal(statusItems().find((i) => i.name === 'area'), undefined, 'no area in the status line (W-33g)');

  await setArea('06');
  s = automationState();
  assert.equal(s.area.label, 'Jönköpings län · se-jkp');
  assert.deepEqual(s.area.iatas, ['JKG']);
  assert.equal(statusItems().find((i) => i.name === 'area'), undefined);
  assert.equal(jobs.calls.filter((c) => c[0] === 'discover').length, 0);   // locked: nothing signed

  status = { ...status, locked: false };
  for (const fn of keyListeners) await fn(status);
  await clock.advance(0);
  s = automationState();
  assert.equal(s.unlocked, true);
  assert.deepEqual(s.discovery.last.added.map((a) => a.name), ['Gisebo']);
  assert.ok(seen.includes('nodes'));
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /disc\.added .*Gisebo/);

  await messages[0].opts.actions[0].run();
  await settle();
  assert.equal(await stores.devices.get('4AC61A7F'), undefined);
  assert.equal(automationState().discovery.canUndo, false);

  const again = await lookNow();
  assert.equal(again.ignored, 1);
  assert.equal(messages.length, 1);                 // nothing new added: nothing said
  await refreshNow();
  assert.notEqual(automationState().refresh.beacon.lastRun, null);
  assert.equal(areaChoices('sv').length, 21);

  status = { exists: true, locked: true, publicKeyHex: OWNER };
  for (const fn of keyListeners) await fn(status);
  assert.equal(automationState().discovery.scheduled, false);
  assert.equal(automationState().discovery.nextRun, null);

  status = { exists: false, locked: true, publicKeyHex: null };
  for (const fn of keyListeners) await fn(status);
  assert.equal(automationState().owner, null);
  await assert.rejects(undoDiscovery(), /no key/);
});
