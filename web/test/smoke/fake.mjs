// Fake data for the smoke test's filled board and the beta notes' screenshots: an invented key
// (stored locked; the smokes unlock it past the gate, W-28b, with noBroker in the page so nothing
// reaches a broker), eight invented nodes with their history, and Beacon's answers for them.
// Nothing here is a real key, node or person.
//
//   seedFake(page)             fill this origin's IndexedDB (call on a page of the app, then reload)
//   seedKey(page), unlockFake(page)   the key alone; unlock it in the page
//   fakeBeacon(path, now)      Beacon's answer for a path, or undefined when the path is not ours
//   noBroker                   for evaluateOnNewDocument: a WebSocket that never connects
import { createHash } from 'node:crypto';

const hex = (text) => createHash('sha256').update(text).digest('hex');
// The key's seed is a hash of a fixed phrase, as test/vectors.json's are; never a real key.
export const FAKE_SEED = hex('mccontrol smoke fake key');
export const FAKE_PASSPHRASE = 'smoke-test-only';

// name, position, battery mV, hours since heard (null: never), firmware, last result
// ('ok' | code | 'silent' | 'forged'), neighbours.
const SPECS = [
  ['Kvarnberget', 57.79, 14.12, 4120, 0.2, 'v1.18.0.4-lou-18', 'ok', 6],
  ['Vattentornet', 57.77, 14.19, 4010, 0.5, 'v1.18.0.4-lou-18', 'ok', 4],
  ['Rosenlund', 57.76, 14.17, 3350, 0.4, 'v1.18.0.4-lou-18', 'ok', 3],
  ['Torpa', 57.82, 14.24, 4190, 31, 'v1.18.0.3-lou-17', 'silent', 2],
  ['Ekbacken', 57.74, 14.08, 3980, 1.1, 'v1.18.0.4-lou-18', 14, 5],
  ['Lövåsen', 57.71, 14.21, 4060, 0.8, 'v1.18.0.4-lou-18', 'ok', 4],
  ['Granbo', 57.85, 14.05, null, null, '', null, 0],
  ['Sjöudden', 57.80, 14.30, 3890, 2.5, 'v1.18.0.1-lou-15', 'forged', 2],
];

export const FAKE_NODES = SPECS.map(([name, lat, lng, mv, heard, fw, last, nb], i) => {
  const key = hex(`fake node ${name}`).toUpperCase();
  return { i, name: `SE-JKG-${name}`, key, node: key.slice(0, 8), lat, lng, mv, heard, fw, last, nb,
    beaconId: `fake-${i}`, observerId: `fake-obs-${i}` };
});

// In the page: the key record (sealed with few iterations, then left locked), the nodes, their
// facts and a day of history. `nodes` and `now` come from here; the page's own modules do the rest.
export async function seedFake(page) {
  await page.evaluate(async ({ seed, pass, nodes }) => {
    const { sealSeed } = await import('./lib/key/backup.js');
    const { indexedDbStorage } = await import('./lib/key/storage.js');
    const { indexedDb } = await import('./lib/store/db.js');
    const { openStores } = await import('./lib/store/index.js');
    const bytes = Uint8Array.from(seed.match(/../g).map((b) => parseInt(b, 16)));
    const sealed = await sealSeed(bytes, pass, { iterations: 1000 });
    const owner = sealed.public_key.toUpperCase();
    const created = new Date(Date.now() - 20 * 86400000).toISOString();
    await indexedDbStorage(indexedDB).put({ id: sealed.public_key, created, source: 'created',
      wraps: { passphrase: sealed }, backup: { at: created, form: 'file' }, settings: { autoLockMinutes: 15 }, persist: null });
    const stores = openStores(indexedDb(indexedDB), owner);
    const now = Date.now();
    const iso = (hoursAgo) => new Date(now - hoursAgo * 3600000).toISOString();
    for (const n of nodes) {
      await stores.devices.add({ node: n.node, key: n.key, name: n.name, region: 'JKG' });
      const heard = n.heard === null ? null : iso(n.heard);
      const changes = { ver: n.fw ? `${n.fw} (2026-11-16)` : null, lastHeard: heard, lastHeardMqtt: heard };
      if (n.last !== null) {
        const code = n.last === 'ok' ? 0 : typeof n.last === 'number' ? n.last : null;
        const at = iso((n.heard ?? 3) + 0.1);
        const event = await stores.history.append({ at, node: n.node, region: 'JKG', command: n.last === 'ok' ? 'get radio' : 'set af 2',
          topic: `meshcore/JKG/${n.node}/cmd`, road: 'mqtt', code, codeName: code === 0 ? 'ok' : code === 14 ? 'not-allowed' : null,
          reply: code === 0 ? '869.618,62.5,8,8' : null, verified: n.last === 'forged' ? false : code === null ? null : true });
        changes.lastSent = at;
        changes.lastResult = { at, command: event.command, code: event.code, codeName: event.codeName, verified: event.verified };
        await stores.history.append({ at: iso((n.heard ?? 3) + 6), node: n.node, region: 'JKG', command: 'ver',
          topic: `meshcore/JKG/${n.node}/cmd`, road: 'mqtt', code: 0, codeName: 'ok', reply: `${n.fw || 'v1.18.0.4-lou-18'} (2026-11-16)`, verified: true });
      }
      await stores.devices.update(n.node, changes);
    }
    await stores.groups.create('stan', nodes.slice(0, 3).map((n) => n.node));
  }, { seed: FAKE_SEED, pass: FAKE_PASSPHRASE, nodes: FAKE_NODES });
}

// The fake key alone, stored locked (run.mjs: every modal needs a key past the unlock gate, W-28b).
export async function seedKey(page) {
  await page.evaluate(async ({ seed, pass }) => {
    const { sealSeed } = await import('./lib/key/backup.js');
    const { indexedDbStorage } = await import('./lib/key/storage.js');
    const bytes = Uint8Array.from(seed.match(/../g).map((b) => parseInt(b, 16)));
    const sealed = await sealSeed(bytes, pass, { iterations: 1000 });
    const created = new Date(Date.now() - 20 * 86400000).toISOString();
    await indexedDbStorage(indexedDB).put({ id: sealed.public_key, created, source: 'created',
      wraps: { passphrase: sealed }, backup: { at: created, form: 'file' }, settings: { autoLockMinutes: 15 }, persist: null });
  }, { seed: FAKE_SEED, pass: FAKE_PASSPHRASE });
}

// Past the unlock gate (W-28b), as the owner would be: the page's own keyring, unlocked with the
// fake passphrase. The gate then opens what the address asked for. With noBroker in the page,
// what the unlock starts (registration, the command server check) reaches no broker.
export async function unlockFake(page) {
  await page.evaluate(async (pass) => {
    const { keyring } = await import('./ui/screens/key-session.js');
    await keyring().unlock(pass);
  }, FAKE_PASSPHRASE);
  await new Promise((ok) => setTimeout(ok, 500));
}

const wave = (i, h, base, amp) => Math.round(base + amp * Math.sin((h + i * 3) / 3.8));

// Beacon's answer for a request path (after the base), for the fake nodes and their area.
export function fakeBeacon(path, now = Date.now()) {
  const url = new URL(path, 'http://x');
  const at = (hoursAgo) => now - hoursAgo * 3600000;
  const prefix = url.searchParams.get('pubkeyPrefix');
  if (url.pathname === '/nodes' && prefix) {
    const n = FAKE_NODES.find((x) => x.key.toLowerCase().startsWith(prefix.toLowerCase()));
    if (!n) return { items: [] };
    if (n.heard === null) return { items: [] };
    return { items: [item(n)] };
  }
  if (url.pathname === '/nodes' && url.searchParams.get('iatas')) {
    const others = Array.from({ length: 14 }, (_, i) => ({ id: `other-${i}`, publicKey: hex(`other ${i}`), nodeType: 2,
      nodeTypeName: 'repeater', name: `Annan-${i + 1}`, lat: 57.6 + ((i * 37) % 30) / 100, lng: 13.95 + ((i * 53) % 45) / 100,
      neighborIds: [], iatas: ['JKG'] }));
    return { items: [...FAKE_NODES.filter((n) => n.heard !== null).map(item), ...others] };
  }
  const obs = url.pathname.match(/^\/observers\/fake-obs-(\d+)(\/telemetry)?$/);
  if (obs) {
    const n = FAKE_NODES[Number(obs[1])];
    if (obs[2]) {
      const hours = url.searchParams.get('range') === '168h' ? 168 : 24;
      return { range: `${hours}h`, interval: '1h', points: Array.from({ length: hours }, (_, k) => {
        const h = hours - k;
        return { t: at(h), batteryMv: n.mv - 40 + wave(n.i, h, 0, 60), airtimeTxSecs: 10000 + (hours - h) * (30 + n.i * 4),
          airtimeRxSecs: 20000 + (hours - h) * 70, noiseFloorDb: wave(n.i, h, -92, 4), uptimeSeconds: 2000000 + (hours - h) * 3600 };
      }) };
    }
    return { id: n.observerId, displayName: n.name, publicKey: n.key.toLowerCase(), firmwareVersion: n.fw, lastStatusAt: at(n.heard),
      statusMetadata: { stats: { battery_mv: n.mv, noise_floor: -91 + n.i, rx_air_secs: 28000, tx_air_secs: 13000 + n.i * 400,
        uptime_secs: 2400000 - n.i * 86400, mqtt_slots_up: 2, mqtt_slots_total: 2 } } };
  }
  return undefined;
}

function item(n) {
  const ids = FAKE_NODES.filter((m) => m !== n && m.heard !== null && Math.abs(m.lat - n.lat) + Math.abs(m.lng - n.lng) < 0.16).map((m) => m.beaconId);
  return { id: n.beaconId, publicKey: n.key.toLowerCase(), nodeType: 2, nodeTypeName: 'repeater', name: n.name, isObserver: true,
    observerId: n.observerId, lat: n.lat, lng: n.lng, knownNeighborCount: n.nb, neighborIds: ids, iatas: ['JKG'] };
}

// No broker in a fake run: a socket that reports a closed connection, so nothing is ever published.
export function noBroker() {
  globalThis.WebSocket = class FakeSocket extends EventTarget {
    constructor() { super(); this.readyState = 3; setTimeout(() => { this.dispatchEvent(new CloseEvent('close', { code: 1006 })); this.onclose?.({ code: 1006 }); }, 50); }
    send() {}
    close() {}
  };
}

// The longest values a person meets (beta.3's overlap in STATUS): node names at the firmware's
// 31 bytes, a long companion error, and a companion with a long name. `renameLong(page)` renames
// the stored nodes (then reload); `companionLong(page, how)` sets the companion line, in the page,
// through the app's own session with a stand-in navigator.serial: 'error' fails with a long
// sentence, 'connected' answers app start with a long name. Nothing is opened or transmitted.
export const LONG_NAME = 'SE-JKG-Kvarnbergets-Vattentorn1';
export const LONG_ERROR = 'the companion did not answer after it restarted: is it running companion firmware for USB? (port 303a:1001, Heltec WiFi LoRa 32 V4, 115200 baud)';
export const LONG_COMPANION = 'SE-JKG-LouHome-Kvarnbergsvägen 🏡';

export async function renameLong(page) {
  await page.evaluate(async ({ seed, name }) => {
    const { keyFromSeed } = await import('./lib/key/handle.js');
    const { indexedDb } = await import('./lib/store/db.js');
    const { openStores } = await import('./lib/store/index.js');
    const owner = keyFromSeed(Uint8Array.from(seed.match(/../g).map((b) => parseInt(b, 16)))).publicKeyHex.toUpperCase();
    const stores = openStores(indexedDb(indexedDB), owner);
    for (const [i, d] of (await stores.devices.list()).entries()) await stores.devices.update(d.node, { name: `${name.slice(0, 29)}${i}` });
  }, { seed: FAKE_SEED, name: LONG_NAME });
}

export async function companionLong(page, how) {
  await page.evaluate(async ({ how, error, name }) => {
    const enc = new TextEncoder();
    const port = {
      open: async () => {}, setSignals: async () => {}, close: async () => {}, getInfo: () => ({}),
      writable: { getWriter: () => ({ releaseLock() {}, write: async (b) => {
        if (b[3] !== 1) return;
        const body = [5, 1, 22, 22, ...new Array(32).fill(0xab), ...new Array(22).fill(0), ...enc.encode(name)];
        feed?.({ value: Uint8Array.from([0x3e, body.length & 0xff, body.length >> 8, ...body]), done: false });
      } }) },
      readable: { getReader: () => ({ read: () => new Promise((r) => { feed = r; }), cancel: async () => feed?.({ done: true }), releaseLock() {} }) },
    };
    let feed = null;
    const serial = { requestPort: async () => { if (how === 'error') throw new Error(error); return port; } };
    Object.defineProperty(navigator, 'serial', { value: serial, configurable: true });
    const session = await import('./ui/companion-session.js');
    await session.connect('usb');
  }, { how, error: LONG_ERROR, name: LONG_COMPANION });
}
