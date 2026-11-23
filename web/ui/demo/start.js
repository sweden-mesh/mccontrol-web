// The demo's start (W-39b): the invented key, sealed in this page's memory and unlocked by the demo
// itself, and the invented fleet in the key's (memory) stores. ui/app.js calls demoKeyOptions() for
// the key session and startDemo() once it runs; neither is reached outside a demo page.
import { memoryStorage } from '../../lib/key/storage.js';
import { demoWorld, seedDemo } from '../../lib/demo/world.js';
import { keyring, closeDemoRing } from '../screens/key-session.js';
import { demoAddress, demoReadOnly, provideDemoPlane } from './mode.js';
import { demoPlane } from '../../lib/demo/nodes.js';
import { services } from '../screens/node-services.js';

let world = null;
export const currentWorld = () => (world ||= demoWorld());

// What startKeySession takes in place of the browser's key store and passkeys: a memory store, and
// few key-stretching rounds, since the demo's passphrase protects nothing.
export const demoKeyOptions = () => ({ storage: memoryStorage(), credentials: null, storageManager: null, iterations: 1000 });

// The demo key goes in through the keyring's own door, as an imported key (the bare seed, as the
// terminal tool keeps one), which leaves it unlocked; auto-lock off, and marked as backed up so
// nothing asks the visitor to save a copy of a key that is not theirs.
export async function startDemo({ t = (k) => k } = {}) {
  const w = currentWorld();
  const ring = keyring();
  const handle = await ring.importKey(w.owner.seedHex, w.owner.passphrase);
  await ring.setAutoLock(null);
  await ring.exportBackup(w.owner.passphrase);   // only its side effect: the key counts as backed up
  const s = await services(handle.publicKeyHex);
  if (!(await s.stores.devices.list()).length) await seedDemo(s.stores, w, { results: s.data.results });
  // The simulated nodes behind the page's socket (v2); read-only, nobody asks for them.
  if (!demoReadOnly()) provideDemoPlane(demoPlane(w, { rules: s.rules }));
  closeDemoRing(() => { globalThis.location.assign(demoAddress(false)); }, () => t('demo.notHere'));   // worded when asked: the strings load after the key
  return w;
}
