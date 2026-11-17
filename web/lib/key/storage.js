// Where key records live: one record per key, keyed by its public key (`id`), so a second key
// (profiles, later) needs no migration. The interface is four async functions; the browser
// passes IndexedDB, the tests the in-memory one.
//
//   get(id) -> record | undefined     put(record)     remove(id)     list() -> [record]
//
// A record holds only ciphertext and bookkeeping, never a seed:
//   { id, created, source: 'created' | 'imported',
//     wraps: { passphrase: <sealed backup record>, prf?: { credentialId, salt, nonce, ciphertext } },
//     backup: null | { at, form: 'file' | 'confirmed' },
//     settings: { autoLockMinutes: 5 | 15 | 60 | null },
//     persist: null | { at, granted } }

export const DB_NAME = 'mccontrol-key';
const STORE = 'keys';

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

export function memoryStorage() {
  const rows = new Map();
  return Object.freeze({
    async get(id) { return clone(rows.get(id)); },
    async put(record) { rows.set(record.id, clone(record)); },
    async remove(id) { rows.delete(id); },
    async list() { return [...rows.values()].map(clone); },
  });
}

const done = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

// `idb` is the browser's `indexedDB`. A database of its own, so the key's schema version never
// collides with the history's or the devices'.
export function indexedDbStorage(idb, name = DB_NAME) {
  let opened = null;
  const db = () => {
    if (!opened) {
      const request = idb.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
      opened = done(request);
    }
    return opened;
  };
  const run = async (mode, act) => {
    const tx = (await db()).transaction(STORE, mode);
    const result = done(act(tx.objectStore(STORE)));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('The key store refused the change.'));
    });
    return result;
  };
  return Object.freeze({
    get: (id) => run('readonly', (s) => s.get(id)),
    put: (record) => run('readwrite', (s) => s.put(record)).then(() => undefined),
    remove: (id) => run('readwrite', (s) => s.delete(id)).then(() => undefined),
    list: () => run('readonly', (s) => s.getAll()),
  });
}
