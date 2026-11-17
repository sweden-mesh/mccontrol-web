// Broker registration by itself (proposal §1.4 "First key", finding 4), and broker errors in
// words with a next step (finding 8).
//
// The broker passes on commands only from keys it knows. Registering is one signed publish to
// the broker, no transmission on the air, and the broker answers the same to a key it already
// knows, so it runs by itself: when a key is unlocked that this browser has not yet registered
// with a broker, once per page load. Setup's Key tab and the STATUS tile show the state and
// offer "Register again".
//
//   createRegistrar({ register, brokersFor, storage, clock })   the logic, with fakes in tests
//       register(config, handle) -> { ok, detail }   (transport.register)
//       brokersFor() -> [{ host, config }]          every distinct broker this device sends to
//   registration()        { state: 'none'|'running'|'ok'|'failed'|'partial', hosts: [{ host, state, detail, at }] }
//   onRegistration(fn)    fn(registration()) after every change; returns unsubscribe
//   registerNow(handle)   register with every broker now (the button)
//   startAutoRegistration()   the page's: follows the key session (ui/app.js calls it once)
//   brokerProblem(t, message) -> { text, next }   a broker error in the page's words
//   brokerText(t, message)    the same as one sentence, for a line that has room for one
import { loadAll } from '../../lib/data/load.js';
import { register as transportRegister } from '../../lib/protocol/transport.js';
import { brokerConfig, brokerTable } from './settings-store.js';
import { currentHandle, keyStatus, onKeyStatus } from './key-session.js';

const MARK = 'mccontrol.registered';      // { "<public key>": { "<host>": <ms> } }

function readMarks(storage) {
  try { return JSON.parse(storage?.getItem(MARK) || '{}') || {}; } catch { return {}; }
}
function writeMarks(storage, marks) {
  try { storage?.setItem(MARK, JSON.stringify(marks)); } catch { /* storage refused: this page only */ }
}

export function createRegistrar({ register, brokersFor, storage = null, clock = () => Date.now() }) {
  const listeners = new Set();
  let hosts = [];               // [{ host, state, detail, at }] for the current key
  let key = null;
  let running = null;
  const tried = new Set();      // keys tried by themselves on this page

  const overall = () => {
    if (!key) return 'none';
    if (hosts.some((x) => x.state === 'running')) return 'running';
    if (!hosts.length) return 'none';
    const ok = hosts.filter((x) => x.state === 'ok').length;
    if (ok === hosts.length) return 'ok';
    return ok ? 'partial' : (hosts.some((x) => x.state === 'failed') ? 'failed' : 'none');
  };
  const state = () => Object.freeze({ state: overall(), key, hosts: hosts.map((x) => ({ ...x })) });
  const tell = () => { const s = state(); for (const fn of listeners) { try { fn(s); } catch { /* a listener's problem */ } } };

  // What is known for `pub` without asking: the hosts marked registered in this browser.
  async function know(pub) {
    if (key === pub && hosts.length) return;
    key = pub;
    const marks = readMarks(storage)[pub] || {};
    const list = pub ? await brokersFor() : [];
    if (key !== pub) return;
    hosts = list.map(({ host }) => (marks[host]
      ? { host, state: 'ok', detail: 'ok', at: marks[host] }
      : { host, state: 'none', detail: '', at: null }));
    tell();
  }

  async function registerNow(handle) {
    if (!handle) throw Object.assign(new Error('The key is locked.'), { code: 'locked' });
    if (running) return running;
    running = (async () => {
      const pub = handle.publicKeyHex;
      await know(pub);
      const list = await brokersFor();
      hosts = list.map(({ host }) => ({ host, state: 'running', detail: '', at: null }));
      tell();
      for (const { host, config } of list) {
        let next;
        try {
          const res = await register(config, handle);
          next = res.ok ? { state: 'ok', detail: res.detail } : { state: 'failed', detail: res.detail, refused: true };
        } catch (err) {
          next = { state: 'failed', detail: err?.message || String(err) };
        }
        const at = clock();
        hosts = hosts.map((x) => (x.host === host ? { ...x, ...next, at } : x));
        if (next.state === 'ok') {
          const marks = readMarks(storage);
          marks[pub] = { ...(marks[pub] || {}), [host]: at };
          writeMarks(storage, marks);
        }
        tell();
      }
      return state();
    })();
    try { return await running; } finally { running = null; }
  }

  // A key status from the key session: learn what is known, and register by itself once per
  // key and page when the key is unlocked and some broker has not said ok in this browser.
  async function follow(status, handle) {
    if (!status?.exists) { key = null; hosts = []; tell(); return null; }
    await know(status.publicKeyHex);
    if (status.locked || !handle || tried.has(status.publicKeyHex)) return null;
    if (hosts.length && hosts.every((x) => x.state === 'ok')) return null;
    tried.add(status.publicKeyHex);
    return registerNow(handle).catch(() => null);
  }

  return {
    registration: state,
    onRegistration(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    registerNow,
    follow,
  };
}

// Every distinct broker this device sends to: the shared one and each region's own.
export async function pageBrokers() {
  const { brokers } = await loadAll();
  const table = brokerTable(brokers);
  const out = [{ host: brokers.shared, config: brokerConfig(brokers, '') }];
  for (const region of Object.keys(table.regions || {}).sort()) {
    const config = brokerConfig(brokers, region);
    const host = config.port && Number(config.port) !== 443 ? `${config.broker}:${config.port}` : config.broker;
    if (!out.some((b) => b.host === host)) out.push({ host, config });
  }
  return out;
}

let page = null;
function pageRegistrar() {
  if (!page) {
    let storage = null;
    try { storage = globalThis.localStorage || null; } catch { storage = null; }
    page = createRegistrar({
      register: (config, handle) => transportRegister({ config, handle }),
      brokersFor: pageBrokers,
      storage,
    });
  }
  return page;
}

export const registration = () => pageRegistrar().registration();
export const onRegistration = (fn) => pageRegistrar().onRegistration(fn);
export const registerNow = (handle = currentHandle()) => pageRegistrar().registerNow(handle);

let started = false;
export function startAutoRegistration() {
  if (started) return;
  started = true;
  const r = pageRegistrar();
  const go = (s) => { r.follow(s, currentHandle()).catch(() => {}); };
  onKeyStatus(go);
  go(keyStatus());
}

// A broker error from lib/protocol (English, technical) in the page's words, with what to do.
const PROBLEMS = [
  [/this browser has no WebSocket/i, 'noSocket'],
  [/^cannot reach (\S+?):?(?:\s|$)/i, 'unreachable'],
  [/^(\S+) did not answer the connection/i, 'noAnswer'],
  [/refused the connection: (.+)$/i, 'refused'],
  [/^no acknowledgement in/i, 'noAck'],
  [/connection to the broker closed/i, 'closed'],
  [/^not connected to the broker/i, 'closed'],
];

const hostOf = (url) => String(url || '').replace(/^wss?:\/\//, '').replace(/\/.*$/, '');

export function brokerProblem(t, message) {
  const text = String(message ?? '');
  for (const [re, code] of PROBLEMS) {
    const m = text.match(re);
    if (m) {
      return {
        code,
        text: t(`setup.broker.${code}`, { host: hostOf(m[1]), why: m[1] || '' }),
        next: t(`setup.broker.${code}Next`),
      };
    }
  }
  return null;
}

// One line: the problem and the next step, or the message itself when it is not a broker error.
export function brokerText(t, message) {
  const p = brokerProblem(t, message);
  return p ? `${p.text} ${p.next}` : String(message ?? '');
}

// A failed host's line: a broker that answered "no" says so; anything else is a broker problem.
export function registrationText(t, host) {
  if (host.state === 'ok') return t('setup.reg.ok', { host: host.host });
  if (host.state === 'running') return t('setup.reg.running', { host: host.host });
  if (host.state === 'none') return t('setup.reg.notYet', { host: host.host });
  if (host.refused) {
    return /^no acknowledgement/i.test(host.detail)
      ? brokerText(t, host.detail)
      : t('setup.reg.refused', { host: host.host, detail: host.detail });
  }
  return brokerText(t, host.detail);
}
