// Where the screens' records live: devices, groups, command sets, history and a little
// bookkeeping (meta). Every record carries `owner`, the signing key's public key (64 hex), and
// `id`, unique within that owner: a second key (profiles, later) is a second owner in the same
// database, with no migration. The key's own record stays in lib/key/storage.js, in a database
// of its own.
//
// The interface is four async functions; the browser passes IndexedDB, the tests memoryDb():
//   get(store, owner, id) -> record | undefined     put(store, record)
//   remove(store, owner, id)                         list(store, owner) -> [record]
export const DB_NAME = 'mccontrol-data';
export const DB_VERSION = 1;
export const STORES = Object.freeze(['devices', 'groups', 'sets', 'history', 'meta']);

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

function checkStore(store) {
  if (!STORES.includes(store)) throw new Error(`no store named ${store}`);
}

function checkRecord(record) {
  if (!record || typeof record.owner !== 'string' || !record.owner || typeof record.id !== 'string' || !record.id) {
    throw new Error('a record needs an owner and an id');
  }
}

export function memoryDb() {
  const rows = new Map(STORES.map((s) => [s, new Map()]));
  const k = (owner, id) => `${owner}\u0000${id}`;
  return Object.freeze({
    async get(store, owner, id) { checkStore(store); return clone(rows.get(store).get(k(owner, id))); },
    async put(store, record) { checkStore(store); checkRecord(record); rows.get(store).set(k(record.owner, record.id), clone(record)); },
    async remove(store, owner, id) { checkStore(store); rows.get(store).delete(k(owner, id)); },
    async list(store, owner) {
      checkStore(store);
      return [...rows.get(store).values()].filter((r) => r.owner === owner).map(clone);
    },
  });
}

const done = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

// `idb` is the browser's `indexedDB`. Each store is keyed by [owner, id] with an index on owner.
export function indexedDb(idb, name = DB_NAME) {
  let opened = null;
  const db = () => {
    if (!opened) {
      const request = idb.open(name, DB_VERSION);
      request.onupgradeneeded = () => {
        for (const store of STORES) {
          if (request.result.objectStoreNames.contains(store)) continue;
          request.result.createObjectStore(store, { keyPath: ['owner', 'id'] }).createIndex('owner', 'owner');
        }
      };
      opened = done(request);
    }
    return opened;
  };
  const run = async (store, mode, act) => {
    checkStore(store);
    const tx = (await db()).transaction(store, mode);
    const result = done(act(tx.objectStore(store)));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('The browser refused to store the change.'));
    });
    return result;
  };
  return Object.freeze({
    get: (store, owner, id) => run(store, 'readonly', (s) => s.get([owner, id])),
    put: (store, record) => { checkRecord(record); return run(store, 'readwrite', (s) => s.put(record)).then(() => undefined); },
    remove: (store, owner, id) => run(store, 'readwrite', (s) => s.delete([owner, id])).then(() => undefined),
    list: (store, owner) => run(store, 'readonly', (s) => s.index('owner').getAll(owner)),
  });
}
