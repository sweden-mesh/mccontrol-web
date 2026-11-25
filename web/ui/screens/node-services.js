// What the node, send, group, set and history screens work with, built once:
// the rules and data from lib/data, the stores of the current key (IndexedDB), the jobs, and
// the firmware release list. The screens import only this module for it, so a test page (or
// the headless screenshots) can serve its own module in its place.
//
// The keyring is the page's one (key-session.js): startKeySession() calls provideKeyring(ring)
// where it builds it, next to provideKeySource(). Until then every job answers "the key is
// locked". Brokers come from settings-store's brokerConfig (a region's own broker on this
// device), Beacon from the statistics' client (one Beacon for the page). The mesh road (W-16)
// goes through the page's companion connection (companion-session.js); the auto road asks
// Beacon when the node's status was last seen.
import { loadAll } from '../../lib/data/load.js';
import { rulesFrom } from '../../lib/protocol/rules.js';
import { indexedDb, memoryDb } from '../../lib/store/db.js';
import { isDemo, demoReadOnly } from '../demo/mode.js';
import { copyStores, openStores } from '../../lib/store/index.js';
import { createJobs } from '../../lib/jobs/jobs.js';
import { META_ID, provedNodes } from '../../lib/jobs/rekey.js';
import { latestRelease, releaseSource } from '../../lib/jobs/releases.js';
import { refreshFleet } from '../../lib/jobs/fleet.js';
import { beaconBase, beaconClient } from '../../lib/stats/beacon-client.js';
import { brokerConfig, meshAfterMins } from './settings-store.js';
import { companion } from '../companion-session.js';

const LOCKED = Object.freeze({ handle: () => null, hold: () => { throw new Error('The key is locked.'); }, touch: () => {} });
let ring = LOCKED;
export function provideKeyring(next) { ring = next || LOCKED; }

let base = null;
const perOwner = new Map();

async function load() {
  const data = await loadAll();
  return { data, rules: rulesFrom(data), db: isDemo() ? memoryDb() : indexedDb(globalThis.indexedDB), beacon: beaconClient({ base: await beaconBase() }) };
}

// { data, rules, stores, jobs, nextJobs, copyTo(key), releases(), fleet(nodes) } for the key `owner` (its public key).
export async function services(owner) {
  if (!base) base = load();
  const { data, rules, db, beacon } = await base;
  if (!perOwner.has(owner)) {
    const stores = openStores(db, owner, { defaultSets: data.brokers.default_sets || {} });
    // While the key is replaced on the nodes (lib/jobs/rekey.js) a second set of jobs signs with
    // the next key. Both seal a relay hop with the key that relay is on: the next key once the
    // relay has proved on it, the key in use until then.
    const proved = async () => provedNodes(await stores.meta.get(META_ID));
    const build = (keys, hopHandle) => createJobs({ ring: keys, hopHandle,
      stores, rules, brokers: data.brokers, results: data.results, configOf: (region) => brokerConfig(data.brokers, region),
      companion: isDemo() ? () => null : companion, meshAfterMins: () => meshAfterMins(), readOnly: demoReadOnly(),
      mqttSeen: async (d) => {
        const oid = d.observerId || (await beacon.findNode(d.key || d.node)).observerId;
        const at = oid ? Number((await beacon.observer(oid))?.lastStatusAt) : NaN;
        return Number.isFinite(at) ? at : null;
      } });
    const jobs = build({ handle: () => ring.handle(), hold: () => ring.hold(), touch: () => ring.touch(),
      loadSecrets: () => ring.loadSecrets?.() ?? {}, saveSecrets: (m) => ring.saveSecrets?.(m) },
    async (via) => ((await proved()).has(via.node) ? ring.rekeyHandle?.() ?? null : null));
    // The next key's shared secrets live for the page only; at finish they are the key's own to make.
    let nextSecrets = {};
    const nextJobs = build({ handle: () => ring.rekeyHandle?.() ?? null, hold: () => ring.hold(), touch: () => ring.touch(),
      loadSecrets: async () => ({ ...nextSecrets }), saveSecrets: async (m) => { nextSecrets = { ...m }; } },
    async (via) => ((await proved()).has(via.node) ? null : ring.handle()));
    perOwner.set(owner, Object.freeze({
      data, rules, stores, jobs, nextJobs,
      // Finish of a key replacement: what is kept for this key, copied to the key that replaces it.
      copyTo: (next) => copyStores(db, owner, next, { skipMeta: [META_ID] }),
      releases: () => latestRelease({ meta: stores.meta }),
      releasePage: async () => (await releaseSource()).page,
      fleet: (nodes = null) => refreshFleet({ stores, client: beacon, nodes }),
    }));
  }
  return perOwner.get(owner);
}
