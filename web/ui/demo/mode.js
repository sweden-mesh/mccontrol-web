// Demo mode (W-39): the real app run against a simulated world, for someone with no flashed node and
// no key. `?demo=1` in the address turns it on; it is decided once, when the page starts, and a page
// never changes mode: the way in and the way out are both a new page load.
//
// What a demo page must never do: open the real key store or the real data (IndexedDB), reach a
// command server or any other host with what it holds, or leave anything behind for the real page on
// this origin. installDemo() makes that so for the whole page before anything else runs:
//
//   - WebSocket is replaced, so no module can open a socket to a real host (jobs, Setup's connection
//     test, registration, the bridge road): it leads to the in-page command server and its simulated
//     nodes, or, read-only, never connects.
//   - localStorage is replaced by a stand-in that keeps everything in memory, except the display
//     settings (theme, layout, colours, language), which are this device's and are shared on purpose.
//   - fetch answers Beacon and the release list from the demo's world and refuses every other host
//     but the page's own and the basemap's.
//   - The key session and the services take memory stores (key-session.js, node-services.js ask isDemo()).
//
// No DOM here beyond `location` and the globals it replaces, so the tests run it with fakes.
import { demoAnswer } from '../../lib/demo/beacon.js';

export const DEMO_PARAM = 'demo';
// The display settings: ui/prefs.js CHOICES and what it retired (ui/boot.js reads them before paint).
export const SHARED_KEYS = Object.freeze(['theme', 'lang', 'layout', 'scheme', 'colorblind', 'phosphor', 'cvd', 'motion']
  .map((name) => `mccontrol.${name}`));

export function demoAsked(search) {
  try { return new URLSearchParams(search || '').get(DEMO_PARAM) === '1'; } catch { return false; }
}

const demo = demoAsked(globalThis.location?.search);
export const isDemo = () => demo;
// v1 (W-39e): the demo was read-only. v2 (W-39l): the simulated nodes answer, so sending is on; set
// this to false and the demo is read-only again, with both of v1's gates.
export const DEMO_SENDS = true;
export const demoReadOnly = () => demo && !DEMO_SENDS;

// The address of this page in the other mode, hash dropped: a new start either way.
export function demoAddress(on, href = globalThis.location?.href) {
  const url = new URL(href);
  if (on) url.searchParams.set(DEMO_PARAM, '1'); else url.searchParams.delete(DEMO_PARAM);
  url.hash = '';
  return url.pathname + url.search;
}

// A localStorage that forgets: reads and writes of the display settings go to the real one, the rest
// stays in this page.
export function demoStorage(real) {
  const rows = new Map();
  const shared = (key) => SHARED_KEYS.includes(key);
  const safe = (fn, fallback = null) => { try { return real ? fn() : fallback; } catch { return fallback; } };
  return Object.freeze({
    getItem: (key) => (shared(key) ? safe(() => real.getItem(key)) : rows.has(key) ? rows.get(key) : null),
    setItem: (key, value) => { if (shared(key)) safe(() => real.setItem(key, String(value))); else rows.set(key, String(value)); },
    removeItem: (key) => { if (shared(key)) safe(() => real.removeItem(key)); else rows.delete(key); },
    key: (i) => [...rows.keys()][i] ?? null,
    get length() { return rows.size; },
    clear: () => rows.clear(),
  });
}

// A socket that never connects: the client sees a closed connection and nothing is ever written.
export class NoSocket extends EventTarget {
  constructor() {
    super();
    this.readyState = 3;
    setTimeout(() => {
      const ev = new Event('close');
      Object.defineProperty(ev, 'code', { value: 1006 });
      this.dispatchEvent(ev);
      this.onclose?.(ev);
    }, 50);
  }
  send() {}
  close() {}
}

// The page's fetch in the demo: its own files and the basemap go through; Beacon and the release list
// are answered from the demo's world (lib/demo/beacon.js); a request to any other host is refused.
export function demoFetch(real, answer, origin) {
  return async (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const a = answer(url, { origin });
    if (a === 'pass') return real(input, init);
    if (!a) throw new TypeError(`The demo reaches no other host (${url.slice(0, 80)})`);
    return new Response(JSON.stringify(a.json), { status: a.status, headers: { 'Content-Type': 'application/json' } });
  };
}

// The demo's command server (W-39h): a socket to the in-page broker (lib/demo/broker.js) with the
// simulated nodes behind it (lib/demo/nodes.js). The broker needs the rules, which load after this
// module has replaced the page's doors, so the socket waits for it: ui/demo/start.js hands it over
// with provideDemoPlane(). Nothing here is a network socket.
let planeReady = null;
let givePlane = null;
const plane = () => (planeReady ||= new Promise((ok) => { givePlane = ok; }));
export function provideDemoPlane(p) { plane(); givePlane(p); }

export class DemoSocket {
  #inner = null;
  #binaryType = 'blob';
  #closed = false;
  constructor(url, protocols) {
    this.url = url;
    this.readyState = 0;
    plane().then((p) => {
      if (this.#closed) return;
      const inner = this.#inner = new p.broker.WebSocket(url, protocols);
      inner.binaryType = this.#binaryType;
      inner.onopen = (ev) => { this.readyState = 1; this.onopen?.(ev); };
      inner.onmessage = (ev) => this.onmessage?.(ev);
      inner.onclose = (ev) => { this.readyState = 3; this.onclose?.(ev); };
    });
  }
  get binaryType() { return this.#binaryType; }
  set binaryType(v) { this.#binaryType = v; if (this.#inner) this.#inner.binaryType = v; }
  send(bytes) { if (!this.#inner) throw new Error('socket not open'); this.#inner.send(bytes); }
  close() {
    if (this.#inner) { this.#inner.close(); return; }
    this.#closed = true;
    this.readyState = 3;
    setTimeout(() => this.onclose?.({ code: 1000 }), 0);
  }
}

// Replace the page's doors. `scope` is globalThis; `Socket` what stands in for WebSocket.
export function installDemo({ scope = globalThis, Socket = DEMO_SENDS ? DemoSocket : NoSocket, answer = demoAnswer } = {}) {
  let real = null;
  try { real = scope.localStorage || null; } catch { real = null; }
  Object.defineProperty(scope, 'localStorage', { value: demoStorage(real), configurable: true });
  Object.defineProperty(scope, 'WebSocket', { value: Socket, configurable: true, writable: true });
  if (typeof scope.fetch === 'function') {
    const real = scope.fetch.bind(scope);
    Object.defineProperty(scope, 'fetch', { value: demoFetch(real, answer, scope.location?.origin), configurable: true, writable: true });
  }
  return scope;
}

// On a demo page this happens when the module is first evaluated, and ui/app.js imports it before
// anything else, so no other module ever sees the real doors.
if (demo && globalThis.document) installDemo();
