// Automatic discovery (W-20a, operator decision 6): when the key is unlocked, look in each of the
// owner's regions for nodes that answer to the owner's key, at most once an hour per region, and
// add every new one with the name it reports, with an undo. "Look now" runs it at once.
//
// A region is an IATA code: those of the chosen area (lib/discovery/areas.js, a county) and those
// of every node already in the list, so a node set to another code by hand is still searched.
// One run in a region is jobs.discover(): a signed broadcast of a harmless read, then a signed
// `get name` broadcast to the nodes that answered. Costs, against the broker's caps (5 broadcasts
// an hour per key per region, 8 regions an hour per key): an automatic run is 2 of the 5; "Look
// now" is refused in a region already searched RUNS_PER_HOUR times in the last hour; a run takes
// at most REGIONS_PER_HOUR regions an hour, the rest wait. Nothing goes on the air: the nodes
// answer over their own MQTT, and each spends 2 of its 10 commands an hour.
//
// Never added: a node whose answer failed its signature (forged), a node whose key differs from
// the one stored (said, not adopted, as jobs.discover does), a node the owner removed with undo
// (kept in `ignored` until allow(node)).
//
// Mesh-only nodes never reach the broker. With a companion connected, meshCandidates() lists the
// repeaters in its contact list that are not in the list yet (no transmission); the owner adds
// one with addMeshNode(), which cannot tell whether the node holds this key.
//
// Everything persisted is per key, in the key's meta store (IndexedDB):
//   'area'          the chosen county's SCB code ('06'), or absent
//   'disc.runs'     { IATA: [ms, ...] }: the runs of the last hour, and always the newest
//   'disc.added'    the last run's added nodes [{ node, name, region }], for undo after a reload
//   'disc.ignored'  [node]: removed with undo; never added again by discovery
//
// No DOM. `clock` is { now(), setTimeout(fn, ms), clearTimeout(id) }; the tests pass a fake.
//
//   const d = createDiscovery({ stores, jobs, table, clock, unlocked: () => bool });
//   d.state()        see STATE below; d.on(fn) -> unsubscribe, fn(state) after every change
//   d.start()        schedule (call on unlock); d.stop() (on lock: a run in progress finishes)
//   d.run({ force }) one run now: due regions, or with force every region still under its cap
//   d.undo()         remove what the last run added and keep it out
//   d.setArea(scb)   choose the area ('' for none): its regions become due at once

import { iatasOf } from './areas.js';

export const COOLDOWN_MS = 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const REGIONS_PER_HOUR = 8;
export const RUNS_PER_HOUR = 2;           // 2 broadcasts each: 4 of the broker's 5
export const MAX_DELAY_MS = 2 ** 31 - 1;  // setTimeout's limit

export const META = Object.freeze({ area: 'area', runs: 'disc.runs', added: 'disc.added', ignored: 'disc.ignored' });

export const realClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
});

// STATE: what the STATUS tile shows.
//   area        the chosen SCB code, or null
//   regions     the IATA codes searched (the area's and the list's)
//   running     true while a run is in progress; progress { region, elapsed, total, answered } | null
//   lastRun     ms of the newest run in any region, or null; nextRun ms of the next automatic one, or null
//   last        the newest run's outcome, or null:
//               { at, regions, added: [{ node, name, region }], known, ignored,
//                 rejected: [{ node, region, reason: 'forged' | 'keyChanged' }],
//                 failed: [{ region, code, detail }], skipped: [{ region, reason: 'cap' | 'recent' }],
//                 undone }
//   canUndo     the last run added nodes that are still there
//   needsArea   no area and no node yet: there is nowhere to look
//   scheduled   start() has been called and stop() has not
const EMPTY = Object.freeze({
  area: null, regions: [], running: false, progress: null, lastRun: null, nextRun: null,
  last: null, canUndo: false, needsArea: false, scheduled: false,
});

const upper = (r) => String(r || '').trim().toUpperCase();
const validRegion = (r) => (/^[A-Z0-9]{2,8}$/.test(r) ? r : null);

export function createDiscovery({
  stores, jobs, table, clock = realClock, unlocked = () => true,
  cooldownMs = COOLDOWN_MS, regionsPerHour = REGIONS_PER_HOUR, runsPerHour = RUNS_PER_HOUR,
}) {
  let state = EMPTY;
  let timer = null;
  let current = null;           // the promise of the run in progress
  let scheduled = false;
  const listeners = new Set();

  const set = (changes) => {
    state = Object.freeze({ ...state, ...changes });
    for (const fn of listeners) { try { fn(state); } catch { /* a listener's problem */ } }
  };

  const readRuns = async () => (await stores.meta.get(META.runs)) || {};
  const readIgnored = async () => (await stores.meta.get(META.ignored)) || [];

  // The area's regions, then the list's, without repeats.
  async function regions() {
    const area = (await stores.meta.get(META.area)) || null;
    const out = [];
    for (const r of [...iatasOf(table, area), ...(await stores.devices.list()).map((d) => d.region)]) {
      const v = validRegion(upper(r));
      if (v && !out.includes(v)) out.push(v);
    }
    return { area, regions: out };
  }

  // Keep each region's runs of the last hour, and its newest always (the cooldown reads it).
  const pruned = (runs, now) => Object.fromEntries(Object.entries(runs).map(([r, list]) => {
    const sorted = [...list].sort((a, b) => a - b);
    const recent = sorted.filter((t) => now - t < HOUR_MS);
    return [r, recent.length ? recent : sorted.slice(-1)];
  }).filter(([, list]) => list.length));

  const newest = (list) => (list?.length ? Math.max(...list) : null);

  // When the next automatic run is due: the earliest region's newest run + the cooldown.
  function nextOf(regionList, runs, now) {
    if (!regionList.length) return null;
    let next = Infinity;
    for (const r of regionList) {
      const last = newest(runs[r]);
      next = Math.min(next, last === null ? now : last + cooldownMs);
    }
    // A region over the per-key cap waits until the oldest region of the last hour leaves it.
    const hourRegions = Object.entries(runs).filter(([, list]) => list.some((t) => now - t < HOUR_MS));
    if (hourRegions.length >= regionsPerHour && next <= now) {
      next = Math.min(...hourRegions.map(([, list]) => Math.max(...list.filter((t) => now - t < HOUR_MS)))) + HOUR_MS;
    }
    return Math.max(next, now);
  }

  async function refreshState(extra = {}) {
    const now = clock.now();
    const { area, regions: list } = await regions();
    const runs = pruned(await readRuns(), now);
    const lastRun = Object.values(runs).reduce((m, l) => Math.max(m, newest(l) ?? -Infinity), -Infinity);
    const added = (await stores.meta.get(META.added)) || [];
    const present = new Set((await stores.devices.list()).map((d) => d.node));
    set({
      area, regions: list, lastRun: Number.isFinite(lastRun) ? lastRun : null,
      nextRun: scheduled && unlocked() ? nextOf(list, runs, now) : null,
      canUndo: added.some((a) => present.has(a.node)),
      needsArea: !list.length, scheduled, ...extra,
    });
  }

  function arm() {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    if (!scheduled || state.nextRun === null) return;
    const delay = Math.min(MAX_DELAY_MS, Math.max(0, state.nextRun - clock.now()));
    timer = clock.setTimeout(() => {
      timer = null;
      if (scheduled && unlocked()) run().catch(() => {});
    }, delay);
  }

  async function work({ force, signal, onProgress }) {
    const now = clock.now();
    const { regions: list } = await regions();
    let runs = pruned(await readRuns(), now);
    const ignored = new Set(await readIgnored());
    const outcome = { at: now, regions: [], added: [], known: 0, ignored: 0, rejected: [], failed: [], skipped: [], undone: false };
    const inHour = () => new Set(Object.entries(runs).filter(([, l]) => l.some((t) => clock.now() - t < HOUR_MS)).map(([r]) => r));

    // Never searched first, then the longest ago: under the cap every region gets its turn.
    const order = [...list].sort((a, b) => (newest(runs[a]) ?? -Infinity) - (newest(runs[b]) ?? -Infinity));
    for (const region of order) {
      if (signal?.aborted) break;
      const mine = (runs[region] || []).filter((t) => clock.now() - t < HOUR_MS);
      const last = newest(runs[region]);
      if (!force && last !== null && clock.now() - last < cooldownMs) continue;
      if (mine.length >= runsPerHour) { outcome.skipped.push({ region, reason: 'recent' }); continue; }
      const hour = inHour();
      if (!hour.has(region) && hour.size >= regionsPerHour) { outcome.skipped.push({ region, reason: 'cap' }); continue; }

      // Counted before the broadcast: a run that fails half-way may still have published.
      runs = { ...runs, [region]: [...(runs[region] || []), clock.now()] };
      await stores.meta.set(META.runs, runs);
      outcome.regions.push(region);
      set({ progress: { region, elapsed: 0, total: 0, answered: 0 } });

      let found;
      try {
        found = await jobs.discover({
          region, signal,
          onProgress: (p) => { set({ progress: { region, elapsed: p.elapsed, total: p.total, answered: p.answered } }); onProgress?.(p); },
        });
      } catch (e) {
        outcome.failed.push({ region, code: e?.code || 'broker', detail: e?.message || String(e) });
        if (e?.code === 'locked') break;
        continue;
      }
      for (const e of found) {
        if (e.knownAs) {
          outcome.known += 1;
          if (e.keyChanged) outcome.rejected.push({ node: e.node, region, reason: 'keyChanged' });
          continue;
        }
        if (e.verified === false) { outcome.rejected.push({ node: e.node, region, reason: 'forged' }); continue; }
        if (ignored.has(e.node)) { outcome.ignored += 1; continue; }
        try {
          const d = await jobs.adopt(e);
          outcome.added.push({ node: d.node, name: d.name, region: d.region });
        } catch (err) {
          outcome.failed.push({ region, code: 'adopt', detail: `${e.node}: ${err?.message || err}` });
        }
      }
    }
    if (outcome.added.length) await stores.meta.set(META.added, outcome.added);
    return outcome;
  }

  // One run. Resolves to the outcome (state().last); a second call while one runs gets the same.
  function run({ force = false, signal, onProgress } = {}) {
    if (current) return current;
    current = (async () => {
      set({ running: true, progress: null });
      try {
        const outcome = await work({ force, signal, onProgress });
        await refreshState({ running: false, progress: null, ...(outcome.regions.length || outcome.skipped.length ? { last: Object.freeze(outcome) } : {}) });
        return outcome;
      } catch (e) {
        await refreshState({ running: false, progress: null });
        throw e;
      } finally {
        current = null;
        arm();
      }
    })();
    return current;
  }

  // Remove what the last run added (nodes the owner has not removed already) and keep them out.
  async function undo() {
    const added = (await stores.meta.get(META.added)) || [];
    const present = new Set((await stores.devices.list()).map((d) => d.node));
    const removed = [];
    for (const a of added) {
      if (!present.has(a.node)) continue;
      await stores.devices.remove(a.node);
      removed.push(a);
    }
    const ignored = new Set(await readIgnored());
    for (const a of added) ignored.add(a.node);
    await stores.meta.set(META.ignored, [...ignored]);
    await stores.meta.set(META.added, []);
    await refreshState(state.last ? { last: Object.freeze({ ...state.last, undone: true }) } : {});
    return removed;
  }

  // Let discovery add a node removed with undo again.
  async function allow(node) {
    const id = upper(node);
    await stores.meta.set(META.ignored, (await readIgnored()).filter((n) => n !== id));
  }

  async function setArea(scb) {
    const value = scb ? String(scb) : null;
    if (value && !iatasOf(table, value).length) throw new Error(`no area with SCB code ${value}`);
    await stores.meta.set(META.area, value);
    await refreshState();
    arm();
  }

  // Repeaters in the companion's contact list that are not in the list (or kept out): candidates
  // for a mesh-only node. Reads the companion's own list; nothing is transmitted.
  async function meshCandidates(companion) {
    if (!companion || companion.closed) return [];
    const known = new Set((await stores.devices.list()).map((d) => d.node));
    const ignored = new Set(await readIgnored());
    return (await companion.contacts())
      .filter((c) => c.type === 2 && /^[0-9A-F]{64}$/.test(c.publicKey))
      .map((c) => ({ node: c.publicKey.slice(0, 8), key: c.publicKey, name: c.name, hops: c.hops }))
      .filter((c) => !known.has(c.node) && !ignored.has(c.node));
  }

  // Add a candidate as a mesh-only node in `region` (an IATA code: the area's when not given).
  async function addMeshNode(candidate, region = null) {
    const r = validRegion(upper(region || iatasOf(table, state.area ?? (await stores.meta.get(META.area)))[0]));
    if (!r) throw new Error('Choose an area first: a node needs its region.');
    const d = await jobs.adopt({ node: candidate.node, key: candidate.key, region: r, name: candidate.name, verified: null });
    const out = await stores.devices.update(d.node, { meshOnly: true });
    await refreshState();
    return out;
  }

  async function start() {
    scheduled = true;
    await refreshState();
    arm();
  }

  function stop() {
    scheduled = false;
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    set({ nextRun: null, scheduled: false });
  }

  return Object.freeze({
    state: () => state,
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    start, stop, run, undo, allow, setArea, regions, meshCandidates, addMeshNode,
    refresh: () => refreshState(),
  });
}
