// The demo's world (W-39): an invented owner key and an invented fleet, the same on every start.
// Nothing here is a real key, node, name or position. The seeds are SHA-256 of fixed phrases (as
// test/vectors.json's are), so the keys are real Ed25519 keys that nobody else holds a use for; the
// names carry DEMO; the positions are points in the countryside of Jönköpings län picked by hand,
// not copied from any map of nodes.
//
//   demoWorld(now)      { owner: { seedHex, passphrase }, nodes: [...], groups, history(now) }
//   seedDemo(stores, world, now)   fill one key's stores (lib/store/index.js) with it
//
// No DOM. The node seeds are the simulated nodes' own (lib/demo/nodes.js signs with them); the owner's
// seed goes through the page's ordinary keyring, sealed, like any key.
import { sha256 } from '../../vendor/noble-hashes/sha2.js';
import { toHex, utf8 } from '../bytes.js';
import { keyFromSeed } from '../key/handle.js';
import { ALIVE_FLAG_RELAY } from '../protocol/mcc3.js';

const seedOf = (phrase) => sha256(utf8(phrase));
export const DEMO_OWNER_PHRASE = 'mccontrol demo owner key';
// Not a secret: the demo unlocks its own key with it, in memory, and it protects nothing.
export const DEMO_PASSPHRASE = 'demo-not-a-secret';
export const DEMO_REGION = 'se-jkp';

const OBSERVER = 'v1.18.0-lou-20-arrc-observer-0';
const MESH_ONLY = 'v1.18.0-lou-20-arrc-0';
const OLDER = 'v1.18.0-lou-18-arrc-observer-0';
const UPLINK = 0x02;

// name, lat, lng, battery mV (null: mains), heard hours ago (null: never), firmware, kind.
// kind: wifi (a lou-20 Observer), relay (one that relays for its owner), mesh (no Wi-Fi, reached
// over the mesh or through the relay), offline (its alive is the will), old (lou-18, the old plane),
// never (added by hand, never heard).
const SPECS = [
  ['DEMO-Kvarnberget', 57.962, 14.871, null, 0.1, OBSERVER, 'relay'],
  ['DEMO-Vattentornet', 57.931, 14.942, null, 0.2, OBSERVER, 'wifi'],
  ['DEMO-Rosenlund', 57.905, 14.853, 3380, 0.2, OBSERVER, 'wifi'],
  ['DEMO-Ekbacken', 57.987, 14.951, 4050, 0.3, OBSERVER, 'wifi'],
  ['DEMO-Granbo', 58.014, 14.862, 3990, 0.4, MESH_ONLY, 'mesh'],
  ['DEMO-Sjöudden', 57.948, 15.021, 4110, 0.1, OBSERVER, 'wifi'],
  ['DEMO-Torpa', 57.884, 14.985, 3720, 31, OBSERVER, 'offline'],
  ['DEMO-Lövåsen', 57.921, 14.782, 4020, 0.6, OLDER, 'old'],
  ['DEMO-Hagen', 58.002, 15.043, null, null, '', 'never'],
];

export function demoWorld() {
  const ownerSeed = seedOf(DEMO_OWNER_PHRASE);
  const ownerKey = keyFromSeed(ownerSeed).publicKeyHex.toUpperCase();
  const nodes = SPECS.map(([name, lat, lng, mv, heard, fw, kind], i) => {
    const seed = seedOf(`mccontrol demo node ${name}`);
    const key = keyFromSeed(seed).publicKeyHex.toUpperCase();
    return Object.freeze({ i, name, key, node: key.slice(0, 8), seedHex: toHex(seed), lat, lng, mv, heard, fw, kind,
      beaconId: `demo-${i}`, observerId: kind === 'mesh' || kind === 'never' ? null : `demo-obs-${i}` });
  });
  return Object.freeze({
    owner: Object.freeze({ seedHex: toHex(ownerSeed), key: ownerKey, passphrase: DEMO_PASSPHRASE }),
    nodes: Object.freeze(nodes),
    groups: Object.freeze({ tornen: ['DEMO-Kvarnberget', 'DEMO-Vattentornet'], sol: ['DEMO-Rosenlund', 'DEMO-Ekbacken', 'DEMO-Granbo'] }),
  });
}

// Who is near whom: the demo's radio links, from distance alone.
export const near = (a, b) => a !== b && Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 59) < 9;
export const neighboursOf = (world, n) => world.nodes.filter((m) => near(n, m) && m.heard !== null && m.kind !== 'offline');

// What a node's alive says, as the page keeps it on the device (jobs.js aliveRecord).
export function aliveOf(world, n, now) {
  if (n.kind === 'old' || n.kind === 'never') return null;
  const at = new Date(now - (n.kind === 'offline' ? 31 * 3600000 : (n.i % 4 + 1) * 120000)).toISOString();
  if (n.kind === 'offline') return { state: 'offline', at };
  const uptime = (9 + n.i * 3) * 86400 + n.i * 977;
  const flags = (n.kind === 'mesh' ? 0 : UPLINK) | (n.kind === 'relay' ? ALIVE_FLAG_RELAY : 0);
  return { state: 'online', at, boot: 40 + n.i, sequence: Math.floor(uptime / 900), uptime, clock: Math.floor(now / 1000), last_counter: 100 + n.i * 7,
    interval: 900, flags, mesh: 1, fingerprint: world.owner.key.slice(0, 8), version: n.fw, region: DEMO_REGION, name: n.name,
    relay: n.kind === 'relay', old_scheme: false };
}

// A week of history: [{ node, hoursAgo, command, code, reply, verified, road, note }], oldest first.
export function demoHistory(world) {
  const by = (name) => world.nodes.find((n) => n.name === name);
  const out = [];
  const add = (name, hoursAgo, command, code, reply, extra = {}) => out.push({ node: by(name), hoursAgo, command, code, reply, verified: code === null ? null : true, road: 'mqtt', ...extra });
  for (const n of world.nodes.filter((x) => x.heard !== null && x.kind !== 'old')) {
    add(n.name, 150 - n.i * 4, 'ver', 0, n.fw);
    add(n.name, 149 - n.i * 4, 'get name', 0, n.name);
  }
  add('DEMO-Kvarnberget', 96, 'get radio', 0, '869.618,62.5,8,8');
  add('DEMO-Kvarnberget', 72, 'neighbors', 0, neighboursOf(world, by('DEMO-Kvarnberget')).map((m, k) => `${m.key.slice(0, 8)}:${90 + k * 240}:${-18 + k * 11}`).join('\n'));
  add('DEMO-Vattentornet', 70, 'get txdelay', 0, '0.5');
  add('DEMO-Rosenlund', 52, 'set af 2', 0, 'OK');
  add('DEMO-Rosenlund', 51, 'get af', 0, '2.0');
  add('DEMO-Ekbacken', 49, 'set radio 869.618,62.5,8,5', 14, null);              // the deny list: the radio stays the cable's
  add('DEMO-Sjöudden', 30, 'get radio', 17, null);                                 // more than ten commands that hour
  add('DEMO-Torpa', 29, 'ver', null, null);                                        // silence: it had gone offline
  add('DEMO-Granbo', 26, 'ver', 0, by('DEMO-Granbo').fw, { road: 'mesh', note: 'through DEMO-Kvarnberget' });
  add('DEMO-Lövåsen', 20, 'ver', 0, by('DEMO-Lövåsen').fw);
  add('DEMO-Vattentornet', 6, 'get autoreply', 0, 'on');
  add('DEMO-Kvarnberget', 2, 'get mqtt.relay', 0, 'own');
  add('DEMO-Sjöudden', 1, 'clock', 0, '12:00 - 1/1/2026 UTC');
  return out.sort((a, b) => b.hoursAgo - a.hoursAgo);
}

export async function seedDemo(stores, world, { now = Date.now(), results = null } = {}) {
  const iso = (hoursAgo) => new Date(now - hoursAgo * 3600000).toISOString();
  const codeName = (code) => (code === null ? null : results?.codes?.[String(code)] ?? (code === 0 ? 'ok' : null));
  for (const n of world.nodes) {
    const old = n.kind === 'old';
    await stores.devices.add({ node: n.node, key: n.key, name: n.name, region: old ? 'JKG' : '' });
    const heard = n.heard === null ? null : iso(n.heard);
    const alive = aliveOf(world, n, now);
    await stores.devices.update(n.node, { ver: n.fw || null, lastHeard: heard,
      ...(n.kind === 'mesh' ? { lastHeardMesh: heard, meshOnly: true } : { lastHeardMqtt: heard }), ...(alive ? { alive } : {}) });
  }
  const last = new Map();
  for (const e of demoHistory(world)) {
    const at = iso(e.hoursAgo);
    const reply = e.command === 'clock' && e.code === 0 ? new Date(now - e.hoursAgo * 3600000).toISOString().replace(/^(\d+)-(\d+)-(\d+)T(\d+:\d+).*/, (_, y, m, d, t) => `${t} - ${Number(d)}/${Number(m)}/${y} UTC`) : e.reply;
    const event = await stores.history.append({ at, node: e.node.node, region: e.node.kind === 'old' ? 'JKG' : '', command: e.command,
      topic: e.node.kind === 'old' ? `meshcore/JKG/${e.node.node}/cmd` : `mcc/cmd/${e.node.key}`, road: e.road, code: e.code, codeName: codeName(e.code),
      reply, verified: e.verified, ...(e.note ? { note: e.note } : {}) });
    last.set(e.node.node, { lastSent: at, lastResult: { at, command: event.command, code: event.code, codeName: event.codeName, verified: event.verified } });
  }
  for (const [node, changes] of last) await stores.devices.update(node, changes);
  for (const [name, members] of Object.entries(world.groups)) {
    await stores.groups.create(name, members.map((m) => world.nodes.find((n) => n.name === m).node));
  }
}
