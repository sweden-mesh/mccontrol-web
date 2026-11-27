// The key as the app sees it: create, import, unlock, lock, back up. The only module outside
// lib/key the app imports for the key; it hands out handles (handle.js), and the seed only to
// revealSeed, which the key screen calls when the owner asks to see it.
//
//   const ring = createKeyring({ storage: indexedDbStorage(indexedDB),
//                                credentials: navigator.credentials, storageManager: navigator.storage });
//   await ring.status()          what the screens show; no secret in it
//   await ring.create(pass)      a new key, unlocked; keeping a copy is the owner's job
//   await ring.importKey(text, pass)   a backup file (opened with pass) or a bare seed
//   await ring.unlock(pass)  /  await ring.unlockWithFingerprint()   -> handle
//   ring.handle()                the unlocked handle, or null
//   ring.lock()                  drop it (a job holding it finishes first)
//   ring.touch()                 the owner did something: restart the idle clock
//   const release = ring.hold()  a running job keeps the key until release()
//   await ring.exportBackup(pass)    -> { filename, text }, the encrypted backup file
//   await ring.revealSeed(pass)  -> the private key (seed) as 64 hex, for a password manager
//   await ring.changePassphrase(old, new)   re-encrypt the stored key; old backup files keep the old one
//   await ring.setAutoLock(min)  5, 15, 60 or null (until the tab closes)
//   await ring.enableFingerprint(pass) / disableFingerprint()
//   await ring.requestPersistence()
//   ring.subscribe(fn)           fn() after every lock, unlock or record change
//   await ring.loadSecrets()     { node KEY: S hex }: the mcc3 shared secret with every node an alive
//                                scan has seen (IATA-2), kept sealed beside the key in its record
//   await ring.saveSecrets(map)  store that map again, sealed (sealLocal) under the unlocked key
//   await ring.reconcile()       another tab changed the stored key: re-read it, and lock a handle
//                                that is no longer the stored key
//
// Replacing the key on the nodes (`rekey`, lib/jobs/rekey.js): a second key, the next one, is kept
// in the same record until the owner finishes or aborts. It is stored twice, both sealed: under the
// passphrase (what its backup file is, and what becomes the stored key at finish) and under the
// key in use (sealLocal), so it signs whenever that key is unlocked, by whatever way.
//   await ring.rekeyStart(pass)  make the next key; -> its public key. Nothing is sent
//   ring.rekeyHandle()           the next key's handle while unlocked, or null
//   await ring.rekeyBackup(pass) -> { filename, text }, the next key's backup file
//   await ring.rekeyAbort()      forget the next key
//   await ring.rekeyFinish()     the next key becomes the key; the replaced one stays in the record,
//                                sealed, until forgetReplaced(id). -> the new handle
//   await ring.replacedBackup(id, pass)   -> { filename, text }, a replaced key's backup file
//   await ring.forgetReplaced(id)         drop a replaced key for good
import { keyFromSeed } from './handle.js';
import { ITERATIONS, MIN_PASSPHRASE, openSealed, randomBytes, readKeyFile, sealSeed } from './backup.js';
import { createPrfWrap, openPrfWrap } from './prf.js';
import { fromHex, fromUtf8, toHex, utf8 } from '../bytes.js';

export { MIN_PASSPHRASE } from './backup.js';
export const AUTO_LOCK_CHOICES = Object.freeze([5, 15, 60, null]);
// Until the tab closes (operator 2026-11-25): a timed lock is the owner's choice in Setup.
export const DEFAULT_AUTO_LOCK = null;
// How long making or replacing a key waits for the browser's answer about keeping its storage.
export const PERSIST_WAIT_MS = 1500;

const realClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
});

const nowIso = (clock) => new Date(clock.now()).toISOString();

export function createKeyring({
  storage, clock = realClock, credentials = null, storageManager = null, iterations = ITERATIONS,
} = {}) {
  if (!storage) throw new TypeError('a keyring needs a storage');
  let current = null;          // the unlocked handle
  let next = null;             // the next key's handle while a replacement is under way (rekey)
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
    dropNext();
    if (holds > 0) waiting.push(handle); else handle.forget();
    notify();
  }

  function dropNext() {
    if (!next) return;
    if (holds > 0) waiting.push(next); else next.forget();
    next = null;
  }

  // The next key's handle, from the copy sealed under the key in use; null when there is none or
  // it does not open (the record is another key's).
  function openNext(record) {
    dropNext();
    if (!current || !record?.next?.local || record.id !== current.publicKeyHex) return;
    let seed = null;
    try {
      seed = current.openLocal(fromHex(record.next.local));
      next = keyFromSeed(seed);
    } catch { next = null; } finally { seed?.fill(0); }
  }

  async function open(seed) {
    lock();
    try {
      current = keyFromSeed(seed);
    } finally {
      seed.fill(0);
    }
    const minutes = await settings();
    openNext(await active());
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
    // The next key lives in the record this would remove.
    if (existing.some((r) => r.next)) throw new Error('A key replacement is under way. Finish or abort it first.');
    const sealed = await sealSeed(seed, passphrase, { iterations });
    const record = {
      id: sealed.public_key, created: nowIso(clock), source,
      wraps: { passphrase: sealed }, backup: null,
      settings: { autoLockMinutes: DEFAULT_AUTO_LOCK }, persist: null,
    };
    // The browser may answer the request to keep the storage with a prompt, and Firefox leaves
    // the request unanswered until the owner answers the prompt, which may be never. The key is
    // stored after a short wait all the same; an answer that comes later is written then.
    const asked = persist();
    let timer = null;
    const answer = await Promise.race([asked, new Promise((r) => { timer = clock.setTimeout(() => r(null), PERSIST_WAIT_MS); })]);
    clock.clearTimeout(timer);
    record.persist = answer ?? { at: nowIso(clock), granted: null };
    await storage.put(record);
    for (const old of existing) if (old.id !== record.id) await storage.remove(old.id);
    if (!answer) {
      asked.then(async (late) => {
        const now = await active();
        if (now?.id === record.id) await update((r) => { r.persist = late; });
      }).catch(() => {});
    }
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
        backup: record?.backup ?? null,
        autoLockMinutes: record ? await settings() : DEFAULT_AUTO_LOCK,
        fingerprint: Boolean(record?.wraps?.prf),
        persist: record?.persist ?? null,
        passphraseChanged: record?.passphraseChanged ?? null,
        rekey: record?.next ? { publicKeyHex: record.next.id, created: record.next.created, backup: record.next.backup ?? null } : null,
        replaced: (record?.replaced || []).map((r) => ({ publicKeyHex: r.id, at: r.at })),
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

    // The raw seed, on the owner's request, behind the passphrase (operator 2026-11-17: keeping
    // a copy is the owner's job, in a password manager or as the backup file). Only the key
    // screen calls this; a test keeps it that way.
    async revealSeed(passphrase) {
      const record = await active();
      if (!record) throw new Error('There is no key in this browser.');
      const seed = await openSealed(record.wraps.passphrase, passphrase);
      try {
        return toHex(seed);
      } finally {
        seed.fill(0);
      }
    },

    // The stored copy re-encrypted under `next`. A backup file saved before keeps opening with
    // the old passphrase only, so the record says when the change was made; the fingerprint
    // copy is unaffected (it is wrapped by the passkey, not the passphrase).
    async changePassphrase(passphrase, fresh) {
      checkPassphrase(fresh);
      const record = await active();
      if (!record) throw new Error('There is no key in this browser.');
      const seed = await openSealed(record.wraps.passphrase, passphrase);
      try {
        const sealed = await sealSeed(seed, fresh, { iterations });
        // The next key and the replaced ones follow: one passphrase opens everything kept here.
        const reseal = async (wrap) => {
          const s = await openSealed(wrap, passphrase);
          try { return await sealSeed(s, fresh, { iterations }); } finally { s.fill(0); }
        };
        const nextWrap = record.next ? await reseal(record.next.wrap) : null;
        const replaced = [];
        for (const r of record.replaced || []) replaced.push({ ...r, wrap: await reseal(r.wrap) });
        await update((r) => {
          r.wraps = { ...r.wraps, passphrase: sealed };
          r.passphraseChanged = nowIso(clock);
          if (r.next && nextWrap) r.next = { ...r.next, wrap: nextWrap, passphraseChanged: r.passphraseChanged };
          if (replaced.length) r.replaced = replaced;
        });
      } finally {
        seed.fill(0);
      }
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

    // Another tab of this origin replaced, removed or re-set the stored key (key-session.js hears
    // it over a BroadcastChannel). A handle for a key that is no longer stored must not sign on
    // (W-12); the auto-lock time is re-read, since that tab may have changed it.
    async reconcile() {
      const record = await active();
      if (current && (!record || record.id !== current.publicKeyHex)) { lock(); return; }
      if ((record?.next?.id ?? null) !== (next?.publicKeyHex ?? null)) openNext(record);
      const minutes = await settings();
      limitMs = minutes === null ? null : minutes * 60000;
      if (current) arm();
      notify();
    },

    // The shared secrets of an unlocked key ({} when locked, never stored, or another key's):
    // opened with the key itself, so they have the key's own protection at rest.
    async loadSecrets() {
      const record = await active();
      if (!current || !record?.secrets || record.id !== current.publicKeyHex) return {};
      try { return JSON.parse(fromUtf8(current.openLocal(fromHex(record.secrets)))); } catch { return {}; }
    },

    // Written straight to the record: no listener needs to hear of it.
    async saveSecrets(map) {
      const record = await active();
      if (!current || !record || record.id !== current.publicKeyHex) return;
      record.secrets = toHex(current.sealLocal(utf8(JSON.stringify(map))));
      await storage.put(record);
    },

    // -- replacing the key on the nodes (rekey) ---------------------------------------------------

    // Make the next key. The passphrase is the stored key's: the next key is sealed under it as
    // the stored one is. `seedHex` takes a key instead of making one (the demo's invented one).
    async rekeyStart(passphrase, { seedHex = null } = {}) {
      const record = await active();
      if (!record) throw new Error('There is no key in this browser.');
      if (!current || record.id !== current.publicKeyHex) throw new Error('The key is locked.');
      if (record.next) throw new Error('A key replacement is already under way.');
      (await openSealed(record.wraps.passphrase, passphrase)).fill(0);
      const seed = seedHex ? fromHex(seedHex) : randomBytes(32);
      try {
        const sealed = await sealSeed(seed, passphrase, { iterations });
        if (sealed.public_key.toUpperCase() === record.id.toUpperCase()) throw new Error('That is the key in use.');
        const local = toHex(current.sealLocal(seed));
        await update((r) => { r.next = { id: sealed.public_key, created: nowIso(clock), wrap: sealed, local, backup: null }; });
        openNext(await active());
        notify();
        return sealed.public_key;
      } finally {
        seed.fill(0);
      }
    },

    rekeyHandle: () => next,

    async rekeyBackup(passphrase) {
      const record = await active();
      if (!record?.next) throw new Error('No key replacement is under way.');
      (await openSealed(record.next.wrap, passphrase)).fill(0);
      await update((r) => { r.next = { ...r.next, backup: { at: nowIso(clock), form: 'file' } }; });
      return {
        filename: `mccontrol-key-${record.next.id.slice(0, 8)}.json`,
        text: `${JSON.stringify(record.next.wrap, null, 2)}\n`,
      };
    },

    async rekeyAbort() {
      const record = await active();
      if (!record?.next) throw new Error('No key replacement is under way.');
      dropNext();
      await update((r) => { delete r.next; });
    },

    // The next key becomes the stored key. The replaced one is kept in the new record, sealed
    // under the passphrase as it was, because a node that did not follow answers only to it.
    // Fingerprint unlock wrapped the replaced key and is dropped; the shared secrets were that
    // key's too.
    async rekeyFinish() {
      const record = await active();
      if (!record?.next) throw new Error('No key replacement is under way.');
      if (!current || !next || record.id !== current.publicKeyHex || next.publicKeyHex !== record.next.id) throw new Error('The key is locked.');
      const at = nowIso(clock);
      const fresh = {
        id: record.next.id, created: record.next.created, source: 'created',
        wraps: { passphrase: record.next.wrap }, backup: record.next.backup ?? null,
        settings: record.settings, persist: record.persist ?? null,
        passphraseChanged: record.next.passphraseChanged ?? null,
        replaced: [...(record.replaced || []), { id: record.id, at, wrap: record.wraps.passphrase }],
      };
      await storage.put(fresh);
      await storage.remove(record.id);
      const old = current;
      current = next;
      next = null;
      if (holds > 0) waiting.push(old); else old.forget();
      notify();
      return current;
    },

    async replacedBackup(id, passphrase) {
      const record = await active();
      const kept = (record?.replaced || []).find((r) => r.id === id);
      if (!kept) throw new Error('No such replaced key is kept here.');
      (await openSealed(kept.wrap, passphrase)).fill(0);
      return { filename: `mccontrol-key-${kept.id.slice(0, 8)}.json`, text: `${JSON.stringify(kept.wrap, null, 2)}\n` };
    },

    async forgetReplaced(id) {
      await update((r) => { r.replaced = (r.replaced || []).filter((x) => x.id !== id); });
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
}
