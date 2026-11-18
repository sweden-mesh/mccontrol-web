// Automatic discovery (W-20a, IATA2-MC4): when the key is unlocked, look for nodes that answer to
// the owner's key, at most once an hour, and add every new one with the name it gives, with an
// undo. "Look now" runs it at once.
//
// First and always, the alive scan (IATA-2 §6): the retained `mcc/alive/<KEY>` messages on the
// shared command server, each tried with the owner's key; what opens is a lou-20-or-later node of
// the owner's, wherever it is, with no region or area to choose. It only reads (jobs.discoverAlive).
//
// Then, only while the list holds lou-19-or-older nodes, the old discovery in their IATA codes
// (the stored one, or Beacon's for the node; never chosen or shown in the page): jobs.discover(),
// a signed broadcast of a harmless read, then a signed `get name` broadcast to the nodes that
// answered. lou-20 nodes do not hear broadcasts. Costs, against the broker's caps (5 broadcasts
// an hour per key per region, 8 regions an hour per key): an automatic run is 2 of the 5; "Look
// now" is refused in a region already searched RUNS_PER_HOUR times in the last hour; a run takes
// at most REGIONS_PER_HOUR regions an hour, the rest wait. Nothing goes on the air.
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
//   'disc.runs'     { IATA: [ms, ...], '*alive': [ms] }: the runs of the last hour, and always the newest
//   'disc.added'    the last run's added nodes [{ node, name }], for undo after a reload
//   'disc.ignored'  [node]: removed with undo; never added again by discovery
//
// No DOM. `clock` is { now(), setTimeout(fn, ms), clearTimeout(id) }; the tests pass a fake.
//
//   const d = createDiscovery({ stores, jobs, rules, clock, unlocked: () => bool });
//   d.state()        see STATE below; d.on(fn) -> unsubscribe, fn(state) after every change
//   d.start()        schedule (call on unlock); d.stop() (on lock: a run in progress finishes)
//   d.run({ force }) one run now: the alive scan, then due regions (with force every region still under its cap)
//   d.undo()         remove what the last run added and keep it out

import { oldRegion, scheme } from '../jobs/scheme.js';

export const COOLDOWN_MS = 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const REGIONS_PER_HOUR = 8;
export const RUNS_PER_HOUR = 2;           // 2 broadcasts each: 4 of the broker's 5
export const MAX_DELAY_MS = 2 ** 31 - 1;  // setTimeout's limit

export const META = Object.freeze({ runs: 'disc.runs', added: 'disc.added', ignored: 'disc.ignored' });
export const ALIVE = '*alive';       // the alive scan's entry in 'disc.runs'

export const realClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
});

// STATE: what the STATUS tile shows.
//   regions     the IATA codes the old discovery searches (those of the list's lou-19-or-older nodes)
//   running     true while a run is in progress; progress { region, elapsed, total, answered } | null
//   lastRun     ms of the newest run in any region, or null; nextRun ms of the next automatic one, or null
//   last        the newest run's outcome, or null:
//               { at, regions, alive: { ours, offline, notYours } | null, added: [{ node, name }], known, ignored,
//                 rejected: [{ node, region, reason: 'forged' | 'keyChanged' }],
//                 failed: [{ region, code, detail }], skipped: [{ region, reason: 'cap' | 'recent' }],
//                 undone }
//   canUndo     the last run added nodes that are still there
//   scheduled   start() has been called and stop() has not
const EMPTY = Object.freeze({
  regions: [], running: false, progress: null, lastRun: null, nextRun: null,
  last: null, canUndo: false, scheduled: false,
});

const upper = (r) => String(r || '').trim().toUpperCase();
const validRegion = (r) => (/^[A-Z0-9]{2,8}$/.test(r) ? r : null);

export function createDiscovery({
  stores, jobs, rules = null, clock = realClock, unlocked = () => true,
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

  // The IATA codes of the list's lou-19-or-older nodes, without repeats: the only places the old
  // discovery still finds anything (lou-20 answers no broadcast).
  async function regions() {
    const out = [];
    for (const d of await stores.devices.list()) {
      if (rules && scheme(rules, d) !== 'old') continue;
      const v = validRegion(upper(oldRegion(d)));
      if (v && !out.includes(v)) out.push(v);
    }
    return { regions: out };
  }

  // Keep each region's runs of the last hour, and its newest always (the cooldown reads it).
  const pruned = (runs, now) => Object.fromEntries(Object.entries(runs).map(([r, list]) => {
    const sorted = [...list].sort((a, b) => a - b);
    const recent = sorted.filter((t) => now - t < HOUR_MS);
    return [r, recent.length ? recent : sorted.slice(-1)];
  }).filter(([, list]) => list.length));

  const newest = (list) => (list?.length ? Math.max(...list) : null);

  // When the next automatic run is due: the earliest of the alive scan and the regions, by its
  // newest run + the cooldown.
  function nextOf(regionList, runs, now) {
    let next = Infinity;
    for (const r of [ALIVE, ...regionList]) {
      const last = newest(runs[r]);
      next = Math.min(next, last === null ? now : last + cooldownMs);
    }
    // A region over the per-key cap waits until the oldest region of the last hour leaves it.
    const hourRegions = Object.entries(runs).filter(([r, list]) => r !== ALIVE && list.some((t) => now - t < HOUR_MS));
    if (hourRegions.length >= regionsPerHour && next <= now) {
      next = Math.min(...hourRegions.map(([, list]) => Math.max(...list.filter((t) => now - t < HOUR_MS)))) + HOUR_MS;
    }
    return Math.max(next, now);
  }

  async function refreshState(extra = {}) {
    const now = clock.now();
    const { regions: list } = await regions();
    const runs = pruned(await readRuns(), now);
    const lastRun = Object.values(runs).reduce((m, l) => Math.max(m, newest(l) ?? -Infinity), -Infinity);
    const added = (await stores.meta.get(META.added)) || [];
    const present = new Set((await stores.devices.list()).map((d) => d.node));
    set({
      regions: list, lastRun: Number.isFinite(lastRun) ? lastRun : null,
      nextRun: scheduled && unlocked() ? nextOf(list, runs, now) : null,
      canUndo: added.some((a) => present.has(a.node)),
      scheduled, ...extra,
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
    const outcome = { at: now, regions: [], alive: null, added: [], known: 0, ignored: 0, rejected: [], failed: [], skipped: [], undone: false };
    const inHour = () => new Set(Object.entries(runs).filter(([r, l]) => r !== ALIVE && l.some((t) => clock.now() - t < HOUR_MS)).map(([r]) => r));

    // The alive scan: free (it only reads), so every run has one.
    const lastAlive = newest(runs[ALIVE]);
    if (force || lastAlive === null || clock.now() - lastAlive >= cooldownMs) {
      runs = { ...runs, [ALIVE]: [clock.now()] };
      await stores.meta.set(META.runs, runs);
      set({ progress: { region: null, elapsed: 0, total: 0, answered: 0 } });
      try {
        const found = await jobs.discoverAlive({
          signal,
          onProgress: (p) => { set({ progress: { region: null, elapsed: p.elapsed, total: p.total, answered: p.answered } }); onProgress?.(p); },
        });
        const count = (s) => found.filter((e) => e.state === s).length;
        outcome.alive = { ours: count('online'), offline: count('offline'), notYours: count('not-yours') };
        for (const e of found) {
          if (e.knownAs) { outcome.known += 1; continue; }
          if (e.state !== 'online') continue;
          if (ignored.has(e.node)) { outcome.ignored += 1; continue; }
          try {
            const d = await jobs.adopt({ node: e.key, key: e.key, region: '', name: e.name, alive: e.alive });
            outcome.added.push({ node: d.node, name: d.name });
          } catch (err) {
            outcome.failed.push({ region: null, code: 'adopt', detail: `${e.node}: ${err?.message || err}` });
          }
        }
      } catch (e) {
        outcome.failed.push({ region: null, code: e?.code || 'broker', detail: e?.message || String(e) });
        if (e?.code === 'locked') return outcome;
      }
    }

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
          outcome.added.push({ node: d.node, name: d.name });
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
        await refreshState({ running: false, progress: null, ...(outcome.alive || outcome.regions.length || outcome.skipped.length || outcome.failed.length ? { last: Object.freeze(outcome) } : {}) });
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

  // Repeaters in the companion's contact list that are not in the list (or kept out): candidates
  // for a mesh-only node. Reads the companion's own list; nothing is transmitted.
  async function meshCandidates(companion) {
    if (!companion || companion.closed) return [];
    const known = new Set((await stores.devices.list()).map((d) => d.node));
    const ignored = new Set(await readIgnored());
    return (await companion.contacts())
      .filter((c) => c.type === 2 && /^[0-9A-F]{64}$/.test(c.publicKey))
      .map((c) => ({ node: c.publicKey.slice(0, 8), key: c.publicKey, name: c.name, hops: c.hops, source: 'companion' }))
      .filter((c) => !known.has(c.node) && !ignored.has(c.node));
  }

  // Add a candidate as a mesh-only node, by its whole key (no region: a mesh-only node has none).
  async function addMeshNode(candidate) {
    const d = await jobs.adopt({ node: candidate.node, key: candidate.key, region: '', name: candidate.name, verified: null });
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
    start, stop, run, undo, allow, regions, meshCandidates, addMeshNode,
    refresh: () => refreshState(),
  });
}
