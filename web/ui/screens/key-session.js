// The one keyring of the page, and what the screens need of it. The shell starts it before the
// first screen is drawn (startKeySession); it plugs itself into the header's key state
// (provideKeySource) and into the node screens' services (provideKeyring), so every screen signs
// with the same handle and one auto-lock clock.
//
//   keyring()          the keyring (lib/key/keyring.js), or null before start
//   keyStatus()        the last status the keyring gave: { exists, locked, publicKeyHex, backup, ... }
//   currentHandle()    the unlocked signing handle, or null
//   holdKey()          a running job keeps the key past an auto-lock: returns release(); throws when locked
//   onKeyStatus(fn)    fn(status) after every lock, unlock or change of the stored key; returns unsubscribe
//   unlockHash(route)  "#/unlock/to/<route>": unlock, then come back here
import { createKeyring } from '../../lib/key/keyring.js';
import { indexedDbStorage } from '../../lib/key/storage.js';
import { provideKeySource } from '../key-state.js';
import { provideKeyring } from './node-services.js';

const EMPTY = Object.freeze({ exists: false, locked: true, publicKeyHex: null, source: null,
  backup: null, autoLockMinutes: 15, fingerprint: false, persist: null, passphraseChanged: null });

let ring = null;
let status = EMPTY;
const listeners = new Set();

export const keyring = () => ring;
export const keyStatus = () => status;
export const currentHandle = () => ring?.handle() ?? null;

export function holdKey() {
  if (!ring) throw new Error('The key is locked.');
  return ring.hold();
}

export function onKeyStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function unlockHash(route = '') {
  const path = String(route).replace(/^#?\/?/, '');
  return path ? `#/unlock/to/${path}` : '#/unlock';
}

// The header's three words for a status.
export function shellState(s) {
  if (!s.exists) return { status: 'none', publicKeyHex: null };
  return { status: s.locked ? 'locked' : 'unlocked', publicKeyHex: s.publicKeyHex };
}

async function refresh() {
  status = Object.freeze(await ring.status());
  for (const fn of listeners) { try { fn(status); } catch { /* a listener's problem */ } }
  shellListeners.forEach((fn) => fn());
}

const shellListeners = new Set();

// `options` replaces the browser's storage and passkeys (tests). Activity anywhere on the page
// restarts the idle clock.
export async function startKeySession(options = {}) {
  if (ring) return ring;
  ring = createKeyring({
    storage: options.storage || indexedDbStorage(globalThis.indexedDB),
    credentials: options.credentials ?? globalThis.navigator?.credentials ?? null,
    storageManager: options.storageManager ?? globalThis.navigator?.storage ?? null,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.iterations ? { iterations: options.iterations } : {}),
  });
  ring.subscribe(() => { refresh(); });
  await refresh();
  provideKeySource({
    state: () => shellState(status),
    subscribe: (fn) => { shellListeners.add(fn); return () => shellListeners.delete(fn); },
  });
  provideKeyring({ handle: () => ring.handle(), hold: () => ring.hold(), touch: () => ring.touch() });
  if (globalThis.document) {
    let last = 0;
    const touch = () => {
      const now = Date.now();
      if (now - last < 5000) return;
      last = now;
      ring.touch();
    };
    for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, touch, { capture: true, passive: true });
  }
  return ring;
}
