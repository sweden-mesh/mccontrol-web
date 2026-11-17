// The page's automatic work (W-20a, W-20b, W-20e): discovery by itself on unlock, the area it
// searches, and the status refresh. One instance of lib/discovery and lib/refresh per key,
// started and stopped with the key: Beacon runs while there is a key (it needs none), discovery
// and the daily `ver` only while it is unlocked. Sets the status line's `area` item, and says what
// discovery added in a message with an undo (the undo is also on the STATUS tile).
//
// The interface the STATUS tile (and Setup's area tab) reads. No DOM here.
//
//   automationState()   frozen snapshot, see SNAPSHOT below
//   onAutomation(fn)    fn(snapshot) after every change; returns unsubscribe
//   lookNow()           discovery now ("Look now"): the cooldown is skipped, the broker caps are not
//   refreshNow()        Beacon now, then `ver` where due
//   undoDiscovery()     remove what the last discovery added, keep those nodes out
//   setArea(scb)        choose the area by SCB code ('' for none); its regions are searched at once
//   areaChoices(lang)   [{ scb, county, scope, iatas, label }] for a picker (ui/area.js)
//   meshCandidates()    repeaters in the connected companion's contacts not in the list ([] without one)
//   addMeshNode(c)      add one as a mesh-only node in the area
//   startAutomation({ t, notify })   the shell, once, after the strings are loaded; t is a getter
//
// SNAPSHOT
//   owner        the key's public key, or null (no key: nothing runs)
//   unlocked     whether the key is unlocked
//   area         { scb, county, scope, iatas, label } | null
//   discovery    lib/discovery's state: running, progress, lastRun, nextRun, regions, last,
//                canUndo, needsArea, scheduled (see lib/discovery/index.js)
//   refresh      lib/refresh's state: running, beacon { lastRun, nextRun, updated, unknown, failed,
//                error }, ver { lastRun, nextRun, sent, skipped } (see lib/refresh/index.js)
//   changed      what the last change was: 'key' | 'area' | 'discovery' | 'refresh' | 'nodes';
//                'nodes' when discovery added or removed nodes, so the NODES tile reloads its list
import { load } from '../lib/data/load.js';
import { createDiscovery } from '../lib/discovery/index.js';
import { areaByScb, areaLabel, areaList } from '../lib/discovery/areas.js';
import { createRefresh } from '../lib/refresh/index.js';
import { beaconBase, beaconClient } from '../lib/stats/beacon.js';
import { keyStatus, onKeyStatus } from './screens/key-session.js';
import { services } from './screens/node-services.js';
import { companion } from './companion-session.js';
import { setStatusItem } from './statusline.js';

const EMPTY = Object.freeze({ owner: null, unlocked: false, area: null, discovery: null, refresh: null, changed: 'key' });

let snapshot = EMPTY;
let table = null;
let live = null;        // { owner, discovery, refresh, off: [unsubscribe] }
let say = { t: () => (k) => k, notify: () => {} };
const listeners = new Set();

export const automationState = () => snapshot;

export function onAutomation(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function publish(changed) {
  const area = live?.discovery.state().area ? areaByScb(table, live.discovery.state().area) : null;
  snapshot = Object.freeze({
    owner: live?.owner || null,
    unlocked: Boolean(live && !statusOf().locked),
    area: area ? Object.freeze({ ...area, label: areaLabel(area) }) : null,
    discovery: live ? live.discovery.state() : null,
    refresh: live ? live.refresh.state() : null,
    changed,
  });
  drawArea();
  for (const fn of listeners) { try { fn(snapshot); } catch { /* a listener's problem */ } }
}

let areaShown = false;
function drawArea() {
  const t = say.t();
  if (!snapshot.owner) {
    if (areaShown) setStatusItem('area', { word: t('area.none'), state: null });
    return;
  }
  areaShown = true;
  const a = snapshot.area;
  setStatusItem('area', a
    ? { word: a.county, state: null, href: '#setup/area', label: t('area.statusLabel', { area: a.label }) }
    : { word: t('area.none'), state: 'warn', href: '#setup/area', label: t('area.chooseLabel') });
}

// What one finished discovery run says: "2 nodes answer your key: Gisebo, Torpa. Added." + Undo.
function tell(outcome) {
  if (!outcome?.added?.length) return;
  const t = say.t();
  const names = outcome.added.map((a) => a.name || a.node).join(', ');
  say.notify(t('disc.added', { n: outcome.added.length, names }), {
    actions: [{ label: t('disc.undo'), run: () => undoDiscovery().catch(() => {}) }],
  });
}

// `make(owner)` -> { discovery, refresh } is replaceable for the tests.
async function makeFor(owner) {
  const svc = await services(owner);
  const unlocked = () => !keyStatus().locked;
  const discovery = createDiscovery({ stores: svc.stores, jobs: svc.jobs, table, unlocked });
  const refresh = createRefresh({
    stores: svc.stores, jobs: svc.jobs, unlocked, meshOnly: (d) => svc.rules.deviceMeshOnly(d),
    beacon: beaconClient({ base: await beaconBase() }),
  });
  return { discovery, refresh };
}

let make = makeFor;
let statusOf = keyStatus;
let following = Promise.resolve();

// Follow the key: a new owner gets new instances; lock and unlock start and stop discovery.
async function follow(status) {
  const owner = status.exists ? status.publicKeyHex : null;
  if (live && live.owner !== owner) {
    live.discovery.stop();
    live.refresh.stop();
    for (const off of live.off) off();
    live = null;
  }
  if (owner && !live) {
    const parts = await make(owner);
    let seenAt = parts.discovery.state().last?.at ?? null;
    live = { owner, ...parts, off: [
      // A run that ends with a new outcome: tell what it added, and the NODES tile to reload.
      parts.discovery.on((s) => {
        const fresh = s.last && !s.running && s.last.at !== seenAt && !s.last.undone;
        if (fresh) seenAt = s.last.at;
        publish(fresh && s.last.added.length ? 'nodes' : 'discovery');
        if (fresh) tell(s.last);
      }),
      parts.refresh.on(() => publish('refresh')),
    ] };
    await parts.refresh.start();
  }
  if (live) {
    if (status.locked) live.discovery.stop();
    else if (!live.discovery.state().scheduled) await live.discovery.start();
    else await live.discovery.refresh();
  }
  publish('key');
}

export async function startAutomation({ t, notify, deps = {} } = {}) {
  say = { t: t || say.t, notify: notify || say.notify };
  table = deps.table || await load('areas');
  if (deps.make) make = deps.make;
  statusOf = deps.keyStatus || keyStatus;
  const on = deps.onKeyStatus || onKeyStatus;
  const queue = (s) => { following = following.then(() => follow(s)).catch((e) => console.warn('automation:', e)); return following; };
  on(queue);
  await queue(statusOf());
}

const need = () => {
  if (!live) throw new Error('There is no key.');
  return live;
};

export const lookNow = () => need().discovery.run({ force: true });

export const refreshNow = () => need().refresh.runNow({ force: true });

export async function undoDiscovery() {
  const removed = await need().discovery.undo();
  publish('nodes');
  return removed;
}

export async function setArea(scb) {
  await need().discovery.setArea(scb);
  publish('area');
}

export const areaChoices = (lang) => areaList(table, lang);

export const meshCandidates = () => need().discovery.meshCandidates(companion());

export async function addMeshNode(candidate) {
  const d = await need().discovery.addMeshNode(candidate);
  publish('nodes');
  return d;
}
