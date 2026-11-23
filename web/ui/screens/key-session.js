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
import { indexedDbStorage, memoryStorage } from '../../lib/key/storage.js';
import { isDemo } from '../demo/mode.js';
import { provideKeySource } from '../key-state.js';
import { provideKeyring } from './node-services.js';

const EMPTY = Object.freeze({ exists: false, locked: true, publicKeyHex: null, source: null,
  backup: null, autoLockMinutes: 15, fingerprint: false, persist: null, passphraseChanged: null });

let ring = null;
let status = EMPTY;
const listeners = new Set();

export const keyring = () => ring;

// The demo (W-39d), once its own invented key is in: only the doors that use the key stay open.
// Everything that makes, changes, shows or copies a key answers "not in the demo", and locking
// leaves the demo, since nobody holds its passphrase.
export const DEMO_OPEN = Object.freeze(['handle', 'hold', 'touch', 'status', 'subscribe', 'reconcile', 'loadSecrets', 'saveSecrets']);
export function closeDemoRing(leave, message) {
  const real = ring;
  const closed = {};
  for (const [name, v] of Object.entries(real)) {
    closed[name] = typeof v !== 'function' ? v : name === 'lock' ? leave
      : DEMO_OPEN.includes(name) ? v : async () => { throw new Error(message); };
  }
  ring = Object.freeze(closed);
  return ring;
}
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

// Other tabs of this page share the stored key but each holds its own handle. When the stored
// key changes here (made, replaced, passphrase, fingerprint, auto-lock) the others are told, and
// each re-reads it and locks a handle that no longer matches (W-12). Locking itself stays per tab.
let channel = null;
const identity = (s) => JSON.stringify([s.exists, s.publicKeyHex, s.fingerprint, s.passphraseChanged, s.autoLockMinutes, s.backup]);

async function refresh() {
  const before = identity(status);
  status = Object.freeze(await ring.status());
  if (channel && before !== identity(status)) {
    try { channel.postMessage('key-changed'); } catch { /* the channel is closed */ }
  }
  for (const fn of listeners) { try { fn(status); } catch { /* a listener's problem */ } }
  shellListeners.forEach((fn) => fn());
}

const shellListeners = new Set();

// `options` replaces the browser's storage and passkeys (tests). Activity anywhere on the page
// restarts the idle clock.
export async function startKeySession(options = {}) {
  if (ring) return ring;
  ring = createKeyring({
    // In the demo (W-39) the key lives in this page's memory: the real key store is never opened.
    storage: options.storage || (isDemo() ? memoryStorage() : indexedDbStorage(globalThis.indexedDB)),
    credentials: options.credentials ?? globalThis.navigator?.credentials ?? null,
    storageManager: options.storageManager ?? globalThis.navigator?.storage ?? null,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.iterations ? { iterations: options.iterations } : {}),
  });
  ring.subscribe(() => { refresh(); });
  await refresh();
  if (typeof globalThis.BroadcastChannel === 'function' && globalThis.document && !isDemo()) {
    channel = new BroadcastChannel('mccontrol-key');
    channel.addEventListener('message', () => { ring.reconcile().catch(() => {}); });
  }
  provideKeySource({
    state: () => shellState(status),
    subscribe: (fn) => { shellListeners.add(fn); return () => shellListeners.delete(fn); },
  });
  provideKeyring({ handle: () => ring.handle(), hold: () => ring.hold(), touch: () => ring.touch(),
    loadSecrets: () => ring.loadSecrets(), saveSecrets: (m) => ring.saveSecrets(m) });
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
