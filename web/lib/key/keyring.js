// The key as the app sees it: create, import, unlock, lock, back up. The only module outside
// lib/key the app imports for the key; it hands out handles (handle.js), never a seed.
//
//   const ring = createKeyring({ storage: indexedDbStorage(indexedDB),
//                                credentials: navigator.credentials, storageManager: navigator.storage });
//   await ring.status()          what the screens show; no secret in it
//   await ring.create(pass)      a new key; the backup gate is then 'backup-required'
//   await ring.importKey(text, pass)   a backup file (opened with pass) or a bare seed
//   await ring.unlock(pass)  /  await ring.unlockWithFingerprint()   -> handle
//   ring.handle()                the unlocked handle, or null
//   ring.lock()                  drop it (a job holding it finishes first)
//   ring.touch()                 the owner did something: restart the idle clock
//   const release = ring.hold()  a running job keeps the key until release()
//   await ring.exportBackup(pass)    -> { filename, text }; satisfies the backup gate
//   await ring.confirmSaved()    an imported key: "yes, I have it saved"
//   await ring.setAutoLock(min)  5, 15, 60 or null (until the tab closes)
//   await ring.enableFingerprint(pass) / disableFingerprint()
//   await ring.requestPersistence()
//   ring.subscribe(fn)           fn() after every lock, unlock or record change
import { keyFromSeed } from './handle.js';
import { ITERATIONS, MIN_PASSPHRASE, openSealed, randomBytes, readKeyFile, sealSeed } from './backup.js';
import { createPrfWrap, openPrfWrap } from './prf.js';

export { MIN_PASSPHRASE } from './backup.js';
export const AUTO_LOCK_CHOICES = Object.freeze([5, 15, 60, null]);
export const DEFAULT_AUTO_LOCK = 15;

const realClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
});

// What the UI may do with the public key: show it for the first node only when 'ok'.
export function backupGate(record) {
  if (!record) return 'no-key';
  if (record.backup) return 'ok';
  return record.source === 'created' ? 'backup-required' : 'confirm-saved';
}

const nowIso = (clock) => new Date(clock.now()).toISOString();

export function createKeyring({
  storage, clock = realClock, credentials = null, storageManager = null, iterations = ITERATIONS,
} = {}) {
  if (!storage) throw new TypeError('a keyring needs a storage');
  let current = null;          // the unlocked handle
  let lastActive = 0;
  let timer = null;
  let holds = 0;
  const waiting = [];          // handles locked while a job held them: forgotten at release
  const listeners = new Set();

  const notify = () => { for (const fn of listeners) { try { fn(); } catch { /* a listener's problem */ } } };
  const active = async () => (await storage.list())[0];

  async function settings() {
    const record = await active();
    return record?.settings?.autoLockMinutes === undefined ? DEFAULT_AUTO_LOCK : record.settings.autoLockMinutes;
  }

  function stopTimer() {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  }

  let limitMs = null;
  function arm() {
    stopTimer();
    if (!current || limitMs === null) return;
    const left = lastActive + limitMs - clock.now();
    if (left <= 0) { lock(); return; }
    timer = clock.setTimeout(arm, left);
  }

  function lock() {
    stopTimer();
    if (!current) return;
    const handle = current;
    current = null;
    if (holds > 0) waiting.push(handle); else handle.forget();
    notify();
  }

  async function open(seed) {
    lock();
    try {
      current = keyFromSeed(seed);
    } finally {
      seed.fill(0);
    }
    const minutes = await settings();
    limitMs = minutes === null ? null : minutes * 60000;
    lastActive = clock.now();
    arm();
    notify();
    return current;
  }

  function checkPassphrase(passphrase) {
    if (typeof passphrase !== 'string' || [...passphrase].length < MIN_PASSPHRASE) {
      throw new Error(`The passphrase needs at least ${MIN_PASSPHRASE} characters.`);
    }
  }

  async function persist() {
    if (!storageManager?.persist) return { at: nowIso(clock), granted: null };
    let granted = null;
    try { granted = Boolean(await storageManager.persist()); } catch { granted = false; }
    return { at: nowIso(clock), granted };
  }

  async function store(seed, passphrase, source, replace) {
    const existing = await storage.list();
    if (existing.length && !replace) {
      throw new Error('This browser already holds a key. Replacing it silences every node set up with it.');
    }
    const sealed = await sealSeed(seed, passphrase, { iterations });
    const record = {
      id: sealed.public_key, created: nowIso(clock), source,
      wraps: { passphrase: sealed }, backup: null,
      settings: { autoLockMinutes: DEFAULT_AUTO_LOCK }, persist: null,
    };
    record.persist = await persist();
    await storage.put(record);
    for (const old of existing) if (old.id !== record.id) await storage.remove(old.id);
    return open(seed);
  }

  async function update(change) {
    const record = await active();
    if (!record) throw new Error('There is no key in this browser.');
    change(record);
    await storage.put(record);
    notify();
    return record;
  }

  return Object.freeze({
    async status() {
      const record = await active();
      return {
        exists: Boolean(record),
        publicKeyHex: record?.id ?? null,
        locked: !current,
        source: record?.source ?? null,
        gate: backupGate(record),
        backup: record?.backup ?? null,
        autoLockMinutes: record ? await settings() : DEFAULT_AUTO_LOCK,
        fingerprint: Boolean(record?.wraps?.prf),
        persist: record?.persist ?? null,
      };
    },

    async create(passphrase, { replace = false } = {}) {
      checkPassphrase(passphrase);
      return store(randomBytes(32), passphrase, 'created', replace);
    },

    // `text` is a file's contents: a backup (opened with `passphrase`, which then also
    // protects it here) or the bare seed hex the terminal tool keeps.
    async importKey(text, passphrase, { replace = false } = {}) {
      checkPassphrase(passphrase);
      const file = readKeyFile(text);
      const seed = file.kind === 'seed' ? file.seed : await openSealed(file.data, passphrase);
      try {
        return await store(seed, passphrase, 'imported', replace);
      } finally {
        seed.fill(0);
      }
    },

    async unlock(passphrase) {
      const record = await active();
      if (!record) throw new Error('There is no key in this browser.');
      return open(await openSealed(record.wraps.passphrase, passphrase));
    },

    async unlockWithFingerprint() {
      const record = await active();
      if (!record?.wraps?.prf) throw new Error('Fingerprint or face unlock is not set up.');
      return open(await openPrfWrap(credentials, record.wraps.prf, record.id));
    },

    handle: () => current,
    lock,

    touch() {
      if (!current) return;
      if (limitMs !== null && clock.now() - lastActive >= limitMs) { lock(); return; }
      lastActive = clock.now();
      arm();
    },

    hold() {
      if (!current) throw new Error('The key is locked.');
      holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        if (holds === 0) for (const h of waiting.splice(0)) h.forget();
      };
    },

    async setAutoLock(minutes) {
      if (!AUTO_LOCK_CHOICES.includes(minutes)) throw new Error('Auto-lock is 5, 15 or 60 minutes, or when the tab closes.');
      await update((r) => { r.settings = { ...r.settings, autoLockMinutes: minutes }; });
      limitMs = minutes === null ? null : minutes * 60000;
      if (current) { lastActive = clock.now(); arm(); }
    },

    // The backup file: the stored encrypted copy, released only to the right passphrase so the
    // owner proves they know what the file will ask for.
    async exportBackup(passphrase) {
      const record = await active();
      if (!record) throw new Error('There is no key in this browser.');
      (await openSealed(record.wraps.passphrase, passphrase)).fill(0);
      await update((r) => { r.backup = { at: nowIso(clock), form: 'file' }; });
      return {
        filename: `mccontrol-key-${record.id.slice(0, 8)}.json`,
        text: `${JSON.stringify(record.wraps.passphrase, null, 2)}\n`,
      };
    },

    async confirmSaved() {
      await update((r) => { if (!r.backup) r.backup = { at: nowIso(clock), form: 'confirmed' }; });
    },

    async enableFingerprint(passphrase, options = {}) {
      const record = await active();
      if (!record) throw new Error('There is no key in this browser.');
      const seed = await openSealed(record.wraps.passphrase, passphrase);
      try {
        const wrap = await createPrfWrap(credentials, seed, record.id, options);
        await update((r) => { r.wraps = { ...r.wraps, prf: wrap }; });
      } finally {
        seed.fill(0);
      }
    },

    async disableFingerprint() {
      await update((r) => { const { prf, ...rest } = r.wraps; r.wraps = rest; });
    },

    async requestPersistence() {
      const result = await persist();
      await update((r) => { r.persist = result; });
      return result.granted;
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
}
