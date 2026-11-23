// The demo's start (W-39b): the invented key, sealed in this page's memory and unlocked by the demo
// itself, and the invented fleet in the key's (memory) stores. ui/app.js calls demoKeyOptions() for
// the key session and startDemo() once it runs; neither is reached outside a demo page.
import { sealSeed } from '../../lib/key/backup.js';
import { memoryStorage } from '../../lib/key/storage.js';
import { fromHex } from '../../lib/bytes.js';
import { demoWorld, seedDemo } from '../../lib/demo/world.js';
import { keyring } from '../screens/key-session.js';
import { services } from '../screens/node-services.js';

let world = null;
export const currentWorld = () => (world ||= demoWorld());

// What startKeySession takes in place of the browser's key store: a memory store holding the demo key
// as any key is held, sealed under a passphrase. Few iterations: it protects nothing. Auto-lock off,
// and marked as backed up so nothing asks the visitor to save a copy of it.
export async function demoKeyOptions() {
  const w = currentWorld();
  const storage = memoryStorage();
  const sealed = await sealSeed(fromHex(w.owner.seedHex), w.owner.passphrase, { iterations: 1000 });
  const created = new Date().toISOString();
  await storage.put({ id: sealed.public_key, created, source: 'created', wraps: { passphrase: sealed },
    backup: { at: created, form: 'file' }, settings: { autoLockMinutes: null }, persist: null });
  return { storage, credentials: null, storageManager: null };
}

export async function startDemo() {
  const w = currentWorld();
  const handle = await keyring().unlock(w.owner.passphrase);
  const s = await services(handle.publicKeyHex);
  if (!(await s.stores.devices.list()).length) await seedDemo(s.stores, w, { results: s.data.results });
  return w;
}
