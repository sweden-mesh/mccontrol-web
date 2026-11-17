// The status refresh (W-20e, operator decision 5): Beacon on load and every 15 minutes, free for
// the nodes; one signed `ver` per node per day, and after Beacon reports a new firmware.
//
// Beacon (lib/stats/beacon.js's client, read-only HTTP): per node, /nodes?pubkeyPrefix= (its
// Beacon id, neighbours, position, IATA codes) and /observers/<id> (battery, airtime, noise
// floor, uptime, firmware, when its status was last seen). Stored on the device as `fleet`, the
// shape lib/jobs/fleet.js writes plus more fields:
//   fleet { batteryMv, seen (ISO | null), firmware, fetched (ISO), airTxSecs, airRxSecs,
//           noiseFloor, uptimeSecs, neighbours, neighbourIds, beaconId, lat, lng, iatas }
// A node Beacon does not know has its fleet cleared (nothing stale); when Beacon cannot be
// reached the old values stay, with their age.
//
// The daily `ver` is a signed command, so it spends one of the node's 10 commands an hour. It is
// sent only when the key is unlocked, over MQTT (never over the mesh: that would transmit), to a
// node that is not mesh-only, that was heard on MQTT in the last HEARD_WITHIN_MS (Beacon's status
// or an answer), whose last `ver` answer or try is a day old, and that has had fewer than
// budgetPerHour - keepForOwner commands in the last hour (the owner's own commands come first).
//
// Persisted per key in the meta store: 'refresh.beaconAt' (ms of the last Beacon pass),
// 'refresh.verTried' ({ node: ms } of the last automatic `ver`), 'refresh.verDue' ([node]: Beacon
// saw a new firmware, so `ver` is due at once).
//
// No DOM. `clock` as lib/discovery's.
//
//   const r = createRefresh({ stores, beacon, jobs, clock, unlocked, meshOnly });
//   r.state(), r.on(fn), r.start(), r.stop()
//   r.runBeacon({ force }), r.runVer({ force }), r.runNow()   (runNow: Beacon, then `ver` where due)

import { realClock, MAX_DELAY_MS } from '../discovery/index.js';

export const BEACON_EVERY_MS = 15 * 60 * 1000;
export const VER_EVERY_MS = 24 * 60 * 60 * 1000;
export const HEARD_WITHIN_MS = 2 * 60 * 60 * 1000;
export const BUDGET_PER_HOUR = 10;
export const KEEP_FOR_OWNER = 5;
const HOUR_MS = 60 * 60 * 1000;

export const META = Object.freeze({ beaconAt: 'refresh.beaconAt', verTried: 'refresh.verTried', verDue: 'refresh.verDue' });

// STATE: what the STATUS tile shows.
//   running     'beacon' | 'ver' | null
//   beacon      { lastRun, nextRun, updated, unknown, failed, error }   (ms; counts of the last pass)
//   ver         { lastRun, nextRun, sent: [{ node, name, ok, code }], skipped: [{ node, name, reason }] }
//               reason: 'notHeard' | 'budget' | 'meshOnly' | 'locked'; nextRun: when the next node's
//               day is over (null: none can be asked)
//   scheduled   start() has been called and stop() has not
const EMPTY = Object.freeze({
  running: null, scheduled: false,
  beacon: Object.freeze({ lastRun: null, nextRun: null, updated: 0, unknown: 0, failed: 0, error: null }),
  ver: Object.freeze({ lastRun: null, nextRun: null, sent: [], skipped: [] }),
});

const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const label = (d) => d.name || d.node;

// Beacon sends some lists as JSON text.
function listOf(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}

// The fleet record from Beacon's node item and observer (either may be null).
export function fleetFrom(item, observer, now) {
  const stats = observer?.statusMetadata?.stats || {};
  const seen = num(Number(observer?.lastStatusAt));
  const ids = listOf(item?.neighborIds).map(String);
  return {
    batteryMv: num(stats.battery_mv),
    seen: seen !== null ? new Date(seen).toISOString() : null,
    firmware: observer?.firmwareVersion || '',
    fetched: new Date(now).toISOString(),
    airTxSecs: num(stats.tx_air_secs),
    airRxSecs: num(stats.rx_air_secs),
    noiseFloor: num(stats.noise_floor),
    uptimeSecs: num(stats.uptime_secs),
    neighbours: num(item?.knownNeighborCount) ?? (ids.length || null),
    neighbourIds: ids,
    beaconId: item?.id || null,
    lat: num(item?.lat),
    lng: num(item?.lng),
    iatas: listOf(item?.iatas).map((x) => (typeof x === 'string' ? x : x?.iata)).filter(Boolean),
  };
}

export function createRefresh({
  stores, beacon, jobs, clock = realClock, unlocked = () => true, meshOnly = (d) => d.meshOnly === true,
  beaconEveryMs = BEACON_EVERY_MS, verEveryMs = VER_EVERY_MS, heardWithinMs = HEARD_WITHIN_MS,
  budgetPerHour = BUDGET_PER_HOUR, keepForOwner = KEEP_FOR_OWNER,
}) {
  let state = EMPTY;
  let timer = null;
  let current = null;
  let scheduled = false;
  const listeners = new Set();

  const set = (changes) => {
    state = Object.freeze({ ...state, ...changes });
    for (const fn of listeners) { try { fn(state); } catch { /* a listener's problem */ } }
  };
  const setPart = (part, changes) => set({ [part]: Object.freeze({ ...state[part], ...changes }) });

  // -- Beacon ----------------------------------------------------------------------------------

  async function beaconPass() {
    const now = clock.now();
    let updated = 0; let unknown = 0; let failed = 0; let error = null;
    const due = new Set((await stores.meta.get(META.verDue)) || []);
    for (const d of await stores.devices.list()) {
      try {
        const item = await beacon.findNode(d.key || d.node);
        const oid = item.observerId || null;
        let observer = null;
        if (oid) {
          try { observer = await beacon.observer(oid); } catch (e) { if (e?.code !== 'unknown') throw e; }
        }
        const fleet = fleetFrom(item, observer, now);
        if (d.fleet?.firmware && fleet.firmware && d.fleet.firmware !== fleet.firmware) due.add(d.node);
        await stores.devices.update(d.node, { fleet, observerId: oid || d.observerId || null });
        updated += 1;
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        if (e?.code === 'unknown') {
          unknown += 1;
          if (d.fleet) await stores.devices.update(d.node, { fleet: null });
        } else {
          failed += 1;
          error = e?.message || String(e);
        }
      }
    }
    await stores.meta.set(META.verDue, [...due]);
    await stores.meta.set(META.beaconAt, now);
    return { lastRun: now, updated, unknown, failed, error };
  }

  // -- daily ver -------------------------------------------------------------------------------

  // When `d` was last asked its version: its last answer or the last automatic try.
  const lastVer = (d, tried) => Math.max(ms(d.reads?.ver?.at) ?? -Infinity, tried[d.node] ?? -Infinity);
  const heardAt = (d) => Math.max(ms(d.fleet?.seen) ?? -Infinity, ms(d.lastHeardMqtt) ?? -Infinity);

  async function usedLastHour(node, now) {
    const since = new Date(now - HOUR_MS).toISOString();
    return (await stores.history.list({ node, since })).length;
  }

  // { due: [device], skipped: [{ node, name, reason }], nextRun }
  async function plan(now, force) {
    const tried = (await stores.meta.get(META.verTried)) || {};
    const forced = new Set((await stores.meta.get(META.verDue)) || []);
    const due = []; const skipped = [];
    let next = Infinity;
    for (const d of await stores.devices.list()) {
      if (meshOnly(d)) continue;                           // never a timed send over the mesh
      const last = lastVer(d, tried);
      const dueAt = forced.has(d.node) ? -Infinity : last + verEveryMs;
      if (!force && dueAt > now) { next = Math.min(next, dueAt); continue; }
      if (now - heardAt(d) > heardWithinMs) { skipped.push({ node: d.node, name: label(d), reason: 'notHeard' }); continue; }
      if (await usedLastHour(d.node, now) >= budgetPerHour - keepForOwner) {
        skipped.push({ node: d.node, name: label(d), reason: 'budget' });
        continue;
      }
      due.push(d);
    }
    return { due, skipped, nextRun: Number.isFinite(next) ? next : null };
  }

  async function verPass({ force = false } = {}) {
    const now = clock.now();
    const { due, skipped, nextRun } = await plan(now, force);
    if (!unlocked()) {
      return { lastRun: state.ver.lastRun, nextRun, sent: [], skipped: [...skipped, ...due.map((d) => ({ node: d.node, name: label(d), reason: 'locked' }))] };
    }
    const sent = [];
    for (const d of due) {
      const tried = (await stores.meta.get(META.verTried)) || {};
      await stores.meta.set(META.verTried, { ...tried, [d.node]: clock.now() });
      await stores.meta.set(META.verDue, ((await stores.meta.get(META.verDue)) || []).filter((n) => n !== d.node));
      try {
        const out = await jobs.send({ command: 'ver', nodes: [d.node], road: 'mqtt' });
        const o = out.outcomes?.[0];
        sent.push({ node: d.node, name: label(d), ok: Boolean(o?.result?.ok), code: o?.result ? o.result.code : null });
      } catch (e) {
        if (e?.code === 'locked') {
          skipped.push({ node: d.node, name: label(d), reason: 'locked' });
          break;
        }
        sent.push({ node: d.node, name: label(d), ok: false, code: null, error: e?.message || String(e) });
      }
    }
    const after = await plan(clock.now(), false);
    return { lastRun: due.length ? now : state.ver.lastRun, nextRun: after.nextRun, sent, skipped };
  }

  // -- the schedule ----------------------------------------------------------------------------

  async function nextBeacon() {
    const at = await stores.meta.get(META.beaconAt);
    return typeof at === 'number' ? at + beaconEveryMs : clock.now();
  }

  async function arm() {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    if (!scheduled) return;
    const next = await nextBeacon();
    setPart('beacon', { nextRun: Math.max(next, clock.now()) });
    if (!scheduled) return;
    timer = clock.setTimeout(() => {
      timer = null;
      if (scheduled) runNow().catch(() => {});
    }, Math.min(MAX_DELAY_MS, Math.max(0, next - clock.now())));
  }

  function exclusive(name, work) {
    if (current) return current;
    current = (async () => {
      set({ running: name });
      try {
        return await work();
      } finally {
        set({ running: null });
        current = null;
        await arm();
      }
    })();
    return current;
  }

  // Beacon now when it is due (or forced), then `ver` where due. Every 15 minutes while started.
  const runNow = ({ force = false } = {}) => exclusive('beacon', async () => {
    if (force || (await nextBeacon()) <= clock.now()) setPart('beacon', await beaconPass());
    set({ running: 'ver' });
    setPart('ver', await verPass());
    return state;
  });

  const runBeacon = () => exclusive('beacon', async () => { setPart('beacon', await beaconPass()); return state; });
  const runVer = ({ force = false } = {}) => exclusive('ver', async () => { setPart('ver', await verPass({ force })); return state; });

  async function start() {
    scheduled = true;
    set({ scheduled: true });
    const at = await stores.meta.get(META.beaconAt);
    if (typeof at === 'number') setPart('beacon', { lastRun: at });
    await arm();
  }

  function stop() {
    scheduled = false;
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    set({ scheduled: false, beacon: Object.freeze({ ...state.beacon, nextRun: null }) });
  }

  return Object.freeze({
    state: () => state,
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    start, stop, runNow, runBeacon, runVer,
  });
}
