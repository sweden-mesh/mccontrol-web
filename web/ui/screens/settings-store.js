// The settings that are not display settings: when the overview warns about a node (low battery,
// not heard), and which broker a region uses. They belong to this device, like the display
// settings, so they live in localStorage ("mccontrol.<name>"); auto-lock belongs to the key and
// is kept by the keyring. Storage may be blocked: every read falls back to the default, and a
// write that storage refuses lasts for this page only.
//
//   lowBatteryVolts()   3.5 unless set      notHeardHours()   24 unless set
//   regionBrokers()     { JKG: 'host[:port]' }  the regions this device sends elsewhere
//   brokerConfig(brokers, region)   the connection config for a region (transport.configFor's
//                       shape): the region's own broker when this device names one, else the
//                       exported table's, else the shared broker; wss on 443, path "/"
//   meshAfterMins()     15 unless set: the auto road takes the mesh for a node not heard over
//                       MQTT this long (W-16)
//   companionKind()     'bluetooth' | 'usb' | '': how this device reaches the companion radio
//   onSettingsChange(fn)  fn() after a change here or in another tab
import { configFor } from '../../lib/protocol/transport.js';

export const DEFAULTS = Object.freeze({ lowBatteryVolts: 3.5, notHeardHours: 24, meshAfterMins: 15 });
export const LIMITS = Object.freeze({ lowBatteryVolts: [2.8, 4.4], notHeardHours: [1, 720], meshAfterMins: [1, 1440] });
const KEYS = { lowBatteryVolts: 'mccontrol.lowBatteryV', notHeardHours: 'mccontrol.notHeardHours', brokers: 'mccontrol.brokers',
  meshAfterMins: 'mccontrol.meshAfterMins', companionKind: 'mccontrol.companion' };
export const COMPANION_KINDS = Object.freeze(['bluetooth', 'usb']);
const EVENT = 'mccontrol:settings';
const REGION = /^[A-Z0-9]{2,8}$/;
const HOST = /^(?=.{1,253}(:|$))[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:\d{1,5})?$/;

const memory = new Map();       // what storage refused, for this page

function storage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

function read(name, store = storage()) {
  if (memory.has(name)) return memory.get(name);
  try { return store ? store.getItem(KEYS[name]) : null; } catch { return null; }
}

function write(name, value, store = storage()) {
  memory.delete(name);
  try {
    if (value === null) store?.removeItem(KEYS[name]); else store?.setItem(KEYS[name], value);
    if (!store) memory.set(name, value);
  } catch {
    memory.set(name, value);
  }
  globalThis.document?.dispatchEvent(new CustomEvent(EVENT));
}

function number(name, store) {
  const raw = read(name, store);
  const n = raw === null ? NaN : Number(raw);
  const [lo, hi] = LIMITS[name];
  return Number.isFinite(n) && n >= lo && n <= hi ? n : DEFAULTS[name];
}

function setNumber(name, value, store) {
  const n = Number(value);
  const [lo, hi] = LIMITS[name];
  if (!Number.isFinite(n) || n < lo || n > hi) throw new RangeError(`${name} is ${lo} to ${hi}`);
  write(name, n === DEFAULTS[name] ? null : String(n), store);
  return n;
}

export const lowBatteryVolts = (store) => number('lowBatteryVolts', store);
export const notHeardHours = (store) => number('notHeardHours', store);
export const setLowBatteryVolts = (v, store) => setNumber('lowBatteryVolts', v, store);
export const setNotHeardHours = (h, store) => setNumber('notHeardHours', h, store);

export const meshAfterMins = (store) => number('meshAfterMins', store);
export const setMeshAfterMins = (m, store) => setNumber('meshAfterMins', m, store);

export function companionKind(store) {
  const v = read('companionKind', store);
  return COMPANION_KINDS.includes(v) ? v : '';
}
export function setCompanionKind(kind, store) {
  if (kind && !COMPANION_KINDS.includes(kind)) throw new RangeError('companion');
  write('companionKind', kind || null, store);
  return kind || '';
}

export function regionBrokers(store) {
  try {
    const parsed = JSON.parse(read('brokers', store) || '{}');
    return Object.fromEntries(Object.entries(parsed).filter(([r, host]) => REGION.test(r) && HOST.test(String(host))));
  } catch {
    return {};
  }
}

// "2 to 8 letters or digits" (the exported region rule); upper case.
export const normalRegion = (region) => String(region || '').trim().toUpperCase();
export const validRegion = (region) => REGION.test(normalRegion(region));
// A host name with an optional port; no scheme, no path: the page speaks wss only.
export const normalHost = (host) => String(host || '').trim().toLowerCase().replace(/^wss:\/\//, '').replace(/\/+$/, '');
export const validHost = (host) => {
  const h = normalHost(host);
  const port = h.includes(':') ? Number(h.split(':')[1]) : 443;
  return HOST.test(h) && port >= 1 && port <= 65535;
};

export function setRegionBroker(region, host, store) {
  const r = normalRegion(region);
  const h = normalHost(host);
  if (!validRegion(r)) throw new RangeError('region');
  if (!validHost(h)) throw new RangeError('host');
  write('brokers', JSON.stringify({ ...regionBrokers(store), [r]: h }), store);
  return [r, h];
}

export function removeRegionBroker(region, store) {
  const { [normalRegion(region)]: gone, ...rest } = regionBrokers(store);
  write('brokers', Object.keys(rest).length ? JSON.stringify(rest) : null, store);
}

// The exported table with this device's regions on top.
export function brokerTable(brokers, store) {
  return { ...brokers, regions: { ...(brokers.regions || {}), ...regionBrokers(store) } };
}

export function brokerConfig(brokers, region, store) {
  const r = normalRegion(region);
  const own = regionBrokers(store)[r];
  const config = configFor(brokerTable(brokers, store), r);
  if (own && own.includes(':')) {
    const [host, port] = own.split(':');
    return { ...config, broker: host, port: Number(port) };
  }
  return config;
}

export function onSettingsChange(fn) {
  const local = () => fn();
  const other = (e) => { if (e.key === null || Object.values(KEYS).includes(e.key)) { memory.clear(); fn(); } };
  document.addEventListener(EVENT, local);
  addEventListener('storage', other);
  return () => { document.removeEventListener(EVENT, local); removeEventListener('storage', other); };
}
