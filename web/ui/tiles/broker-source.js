// The command server line (W-28a): "broker" is the MQTT command server the page talks to
// (mqtt-meshcore.louie.se and any region's own). When a key is unlocked the page connects to each
// of them once, signs in with the key's token and closes again: no publish, nothing on the air.
// Until it knows, the line says "connecting…"; then "connected", or "unreachable" with why, never
// "not known yet". A later send or Test (reportBroker) moves the line on. No DOM.
//
//   createBrokerCheck({ connect, brokersFor, clock })   the logic, with fakes in tests
//       connect(config, handle) -> Promise              resolves when signed in (and closed again)
//       brokersFor() -> [{ host, config }]              every command server this device sends to
//     .state()   { state: 'unknown'|'running'|'ok'|'alert', hosts: [host], at, detail }
//     .follow(status, handle)   the key session's status: checks once per key and page
//     .checkNow(handle)         check again
//     .report({ ok, detail, at })   what a send or Test found
//     .on(fn)    fn() after every change; returns unsubscribe
//   useBrokerCheck()   the page's: provides the STATUS 'broker' source (ui/app.js through tiles/index.js)
import { openClient } from '../../lib/protocol/transport.js';
import { currentHandle, keyStatus, onKeyStatus } from '../screens/key-session.js';
import { pageBrokers } from '../screens/key-register.js';
import { brokerReport, onSources, provideSource } from './sources.js';
import { isDemo, demoReadOnly } from '../demo/mode.js';

export function createBrokerCheck({ connect, brokersFor, clock = () => Date.now() }) {
  const listeners = new Set();
  let st = { state: 'unknown', hosts: [], at: null, detail: null };
  let key = null;
  let turn = 0;
  const tried = new Set();
  const set = (next) => {
    st = Object.freeze({ ...st, ...next });
    for (const fn of listeners) { try { fn(); } catch { /* a listener's problem */ } }
  };

  async function checkNow(handle) {
    if (!handle) return st;
    const mine = turn += 1;
    const list = await brokersFor().catch(() => []);
    if (mine !== turn) return st;
    set({ state: 'running', hosts: list.map((b) => b.host), detail: null });
    const failed = [];
    for (const b of list) {
      try { await connect(b.config, handle); } catch (e) { failed.push(`${b.host}: ${e.message}`); }
    }
    if (mine !== turn) return st;
    set({ state: failed.length ? 'alert' : 'ok', at: clock(), detail: failed.join('; ') || null });
    return st;
  }

  return {
    state: () => st,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    checkNow,
    follow(status, handle) {
      const pub = status?.exists && !status.locked ? status.publicKeyHex : null;
      if (pub !== key) {
        key = pub;
        turn += 1;
        set({ state: 'unknown', at: null, detail: null });
      }
      if (!pub || !handle || tried.has(pub)) return null;
      tried.add(pub);
      return checkNow(handle).catch(() => null);
    },
    report({ ok, detail = null, at = clock() }) {
      if (st.at && at <= st.at) return;
      turn += 1;
      set({ state: ok ? 'ok' : 'alert', at, detail: ok ? null : detail });
    },
  };
}

// Signed in and closed again: whether the server takes this key's login, nothing more.
async function signIn(config, handle) {
  const client = await openClient(config, handle);
  await client.close();
}

let page = null;
export function useBrokerCheck() {
  if (page) return page;
  if (isDemo()) {   // the demo's command server is in the page (W-39h), or, read-only, there is none: say so, test nothing
    const still = Object.freeze({ state: demoReadOnly() ? 'unknown' : 'ok', word: demoReadOnly() ? 'demo.noServer' : 'demo.simServer', hosts: [], at: null, detail: null });
    page = { state: () => still, on: () => () => {}, checkNow: async () => still, follow: () => null, report() {} };
    provideSource('broker', { state: page.state, on: page.on });
    return page;
  }
  page = createBrokerCheck({ connect: signIn, brokersFor: pageBrokers });
  const follow = () => page.follow(keyStatus(), currentHandle());
  onKeyStatus(follow);
  let seen = null;
  onSources(() => {
    const r = brokerReport();
    if (r && r !== seen) { seen = r; page.report(r); }
  });
  provideSource('broker', { state: page.state, on: page.on, run: () => page.checkNow(currentHandle()) });
  follow();
  return page;
}
