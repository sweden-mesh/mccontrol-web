// The page's automatic work (W-20a, W-20e, IATA2-MC4): discovery by itself on unlock (the alive
// scan, wherever the owner's nodes are, with no area to choose) and the status refresh. One
// instance of lib/discovery and lib/refresh per key, started and stopped with the key: Beacon
// runs while there is a key (it needs none), discovery and the daily `ver` only while it is
// unlocked. Says what discovery added in a message with an undo (the undo is also on the STATUS tile).
//
// The interface the STATUS tile (and Setup's connections tab) reads. No DOM here.
//
//   automationState()   frozen snapshot, see SNAPSHOT below
//   onAutomation(fn)    fn(snapshot) after every change; returns unsubscribe
//   lookNow()           discovery now ("Look now"): the cooldown is skipped, the broker caps are not
//   refreshNow()        Beacon now, then `ver` where due
//   undoDiscovery()     remove what the last discovery added, keep those nodes out
//   meshCandidates()    repeaters in the connected companion's contacts not in the list ([] without one)
//   addMeshNode(c)      add one as a mesh-only node, by its whole key
//   findMeshNodes(geo)  W-24: possible mesh-only nodes, no transmission: the companion's contacts and
//                       Beacon's repeaters (not observers) placed inside the county outlines (`geo`,
//                       se-lan.json) of the counties the owner's nodes name as their region home
//                       -> { counties, companion: [c], beacon: [c], beaconError }
//   checkMeshNode(c)    W-24: one signed `ver` over the mesh to c (the owner's press only); an
//                       answer adds it as mesh-only -> { answered, result, device }
//   startAutomation({ t, notify })   the shell, once, after the strings are loaded; t is a getter
//
// SNAPSHOT
//   owner        the key's public key, or null (no key: nothing runs)
//   unlocked     whether the key is unlocked
//   discovery    lib/discovery's state: running, progress, lastRun, nextRun, regions, last,
//                canUndo, scheduled (see lib/discovery/index.js)
//   refresh      lib/refresh's state: running, beacon { lastRun, nextRun, updated, unknown, failed,
//                error }, ver { lastRun, nextRun, sent, skipped } (see lib/refresh/index.js)
//   changed      what the last change was: 'key' | 'discovery' | 'refresh' | 'nodes';
//                'nodes' when discovery added or removed nodes, so the NODES tile reloads its list
import { load } from '../lib/data/load.js';
import { createDiscovery, META } from '../lib/discovery/index.js';
import { beaconCandidates } from '../lib/discovery/mesh-candidates.js';
import { areaByScope } from '../lib/discovery/areas.js';
import { areaOf } from '../lib/jobs/scheme.js';
import { createRefresh } from '../lib/refresh/index.js';
import { beaconBase, beaconClient } from '../lib/stats/beacon-client.js';
import { keyStatus, onKeyStatus } from './screens/key-session.js';
import { services } from './screens/node-services.js';
import { demoReadOnly } from './demo/mode.js';
import { companion } from './companion-session.js';

const EMPTY = Object.freeze({ owner: null, unlocked: false, discovery: null, refresh: null, changed: 'key' });

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
  snapshot = Object.freeze({
    owner: live?.owner || null,
    unlocked: Boolean(live && !statusOf().locked),
    discovery: live ? live.discovery.state() : null,
    refresh: live ? live.refresh.state() : null,
    changed,
  });
  for (const fn of listeners) { try { fn(snapshot); } catch { /* a listener's problem */ } }
}

// There is no area to choose (IATA-2, operator 2026-11-18): discovery reads the alive messages of
// every node wherever it is, and the old discovery only the IATA codes of the list's own old nodes.

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
  const discovery = createDiscovery({ stores: svc.stores, jobs: svc.jobs, rules: svc.rules, unlocked });
  const beacon = beaconClient({ base: await beaconBase() });
  const refresh = createRefresh({
    stores: svc.stores, jobs: svc.jobs, unlocked, meshOnly: (d) => svc.rules.deviceMeshOnly(d), beacon,
  });
  return { discovery, refresh, beacon, stores: svc.stores, jobs: svc.jobs };
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
    // Locked (as every reload starts): nothing is scheduled, but the last run is still read.
    if (status.locked) { live.discovery.stop(); await live.discovery.refresh(); }
    else if (!live.discovery.state().scheduled) await live.discovery.start();
    else await live.discovery.refresh();
  }
  publish('key');
}

export async function startAutomation({ t, notify, deps = {} } = {}) {
  if (demoReadOnly()) return;   // the read-only demo looks nothing up and sends nothing by itself (W-39e)
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

export const meshCandidates = () => need().discovery.meshCandidates(companion());

export async function findMeshNodes(geo) {
  const l = need();
  const fromCompanion = await l.discovery.meshCandidates(companion()).catch(() => []);
  let beacon = [];
  let beaconError = null;
  const devices = l.stores ? await l.stores.devices.list() : [];
  const counties = [...new Set(devices.map(areaOf).filter(Boolean))].map((s) => areaByScope(table, s)).filter(Boolean);
  if (counties.length && l.beacon) {
    try {
      const known = new Set(devices.map((d) => d.node));
      const ignored = new Set((await l.stores.meta.get(META.ignored)) || []);
      const inCompanion = new Set(fromCompanion.map((c) => c.node));
      const all = await l.beacon.allNodes();
      const seen = new Set();
      for (const c of counties) {
        for (const n of beaconCandidates(all, { geo, scb: c.scb, known, ignored })) {
          if (!inCompanion.has(n.node) && !seen.has(n.node)) { seen.add(n.node); beacon.push(n); }
        }
      }
    } catch (e) {
      beaconError = e?.message || String(e);
      beacon = [];
    }
  }
  return { counties, companion: fromCompanion, beacon, beaconError };
}

export async function checkMeshNode(candidate, { signal, onProgress } = {}) {
  const l = need();
  if (!l.jobs) throw new Error('There is no key.');
  const out = await l.jobs.checkMeshNode({ candidate, signal, onProgress });
  if (out.answered) { await l.discovery.refresh(); publish('nodes'); }
  return out;
}

export async function addMeshNode(candidate) {
  const d = await need().discovery.addMeshNode(candidate);
  publish('nodes');
  return d;
}
