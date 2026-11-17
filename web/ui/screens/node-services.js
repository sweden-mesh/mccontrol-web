// What the node, send, group, set, history and dashboard screens work with, built once:
// the rules and data from lib/data, the stores of the current key (IndexedDB), the jobs, and
// the firmware release list. The screens import only this module for it, so a test page (or
// the headless screenshots) can serve its own module in its place.
//
// The keyring is the key stream's (W-5): it calls provideKeyring(ring) where it builds it,
// next to provideKeySource(). Until then every job answers "the key is locked".
import { loadAll } from '../../lib/data/load.js';
import { rulesFrom } from '../../lib/protocol/rules.js';
import { indexedDb } from '../../lib/store/db.js';
import { openStores } from '../../lib/store/index.js';
import { createJobs } from '../../lib/jobs/jobs.js';
import { latestRelease, releaseSource } from '../../lib/jobs/releases.js';
import { refreshFleet } from '../../lib/jobs/fleet.js';

const LOCKED = Object.freeze({ handle: () => null, hold: () => { throw new Error('The key is locked.'); }, touch: () => {} });
let ring = LOCKED;
export function provideKeyring(next) { ring = next || LOCKED; }

let base = null;
const perOwner = new Map();

async function load() {
  const data = await loadAll();
  return { data, rules: rulesFrom(data), db: indexedDb(globalThis.indexedDB) };
}

// { data, rules, stores, jobs, releases(), fleet(nodes) } for the key `owner` (its public key).
export async function services(owner) {
  if (!base) base = load();
  const { data, rules, db } = await base;
  if (!perOwner.has(owner)) {
    const stores = openStores(db, owner, { defaultSets: data.brokers.default_sets || {} });
    const jobs = createJobs({ ring: { handle: () => ring.handle(), hold: () => ring.hold(), touch: () => ring.touch() },
      stores, rules, brokers: data.brokers, results: data.results });
    perOwner.set(owner, Object.freeze({
      data, rules, stores, jobs,
      releases: () => latestRelease({ meta: stores.meta }),
      releasePage: async () => (await releaseSource()).page,
      fleet: (nodes = null) => refreshFleet({ stores, brokers: data.brokers, nodes }),
    }));
  }
  return perOwner.get(owner);
}
