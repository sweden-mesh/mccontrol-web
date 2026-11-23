// The relay road: a node of the owner's that is on MQTT (the relay) transmits a mesh request to
// another node (the target) and hands the answer back over MQTT (mccontrol-spec's
// docs/wire-format-mcc3.md, "A forward through a relay"). Here: which nodes can relay, the routes
// a relay can be asked for, what auto may pick, and the two replies read to help choose. No
// DOM, nothing sent.
//
//   route        what the relay sends                               on the wire
//   neighbour    once, with no hops; a 0xC2 target answers the      direct, path length 0, the
//                same way (the zero-hop flag)                        request's flags 0x02
//   path         along the path a result taught, kept per relay      direct, that path
//   flood        a flood in the relay's region home                  flood
//   flood-wide   a flood in the relay's default scope                flood-wide
//
// A flood costs every node in reach airtime and the relay admits one a minute at most, so it is the
// owner's word each time (`confirmed`), never auto's and never part of a send to several nodes.
import { ALIVE_FLAG_RELAY, ROUTES } from '../protocol/mcc3.js';

export const RELAY_ROUTES = Object.freeze(['neighbour', 'path', 'flood', 'flood-wide']);
export const WIRE_ROUTE = Object.freeze({ neighbour: ROUTES.direct, path: ROUTES.direct, flood: ROUTES.flood, 'flood-wide': ROUTES['flood-wide'] });
export const isFlood = (route) => route === 'flood' || route === 'flood-wide';

// The relay judges `expiry <= its clock + 300`; half of that leaves room for a clock that is behind.
export const FORWARD_TTL_SECS = 150;
// The relay answers within 120 s; the rest is the way there and back.
export const RELAY_WAIT_SECS = 135;
// `neighbors` lists the 8 most recent adverts: a full list that lacks a node proves nothing.
export const NEIGHBOURS_SHOWN = 8;

const ALIVE_UPLINK = 0x02;

// An alive is fresh for two of the node's own intervals (it publishes every 15 min) and a minute.
function aliveFresh(alive, now) {
  const at = Date.parse(alive?.at);
  const every = Number(alive?.interval) > 0 ? Number(alive.interval) : 900;
  return Number.isFinite(at) && now - at <= (2 * every + 60) * 1000;
}

// Does the node say it relays? Its alive's flag, or its own OK to `set mqtt.relay` since (jobs.js
// keeps that as `relay`); null when its alive is not ours or says neither.
export function relaying(alive) {
  if (!alive || alive.state === 'not-yours') return null;
  if (typeof alive.relay === 'boolean') return alive.relay;
  return Number.isInteger(alive.flags) ? Boolean(alive.flags & ALIVE_FLAG_RELAY) : null;
}

// Why `relay` cannot carry a command to `target` now ({ code, vars }), or null: it is the
// owner's (its alive opened), fresh, an Observer image of lou-20 or later, relaying, with its
// whole key, and not the target itself.
export function relayRefusal(rules, relay, target, now = Date.now()) {
  if (!relay) return { code: 'relayMissing', vars: {} };
  const vars = { name: relay.name || relay.node };
  if (target && relay.node === target.node) return { code: 'relaySelf', vars };
  const a = relay.alive;
  if (!relay.key || !a || a.state !== 'online' || !aliveFresh(a, now)) return { code: 'relayNotHeard', vars };
  if (!(a.flags & ALIVE_UPLINK) || rules.canRelay(a.version || relay.ver) !== true) return { code: 'relayCannot', vars };
  if (relaying(a) !== true) return { code: 'relayOff', vars };
  return null;
}

// The owner's nodes that can relay to `target` now, each with what is known of the way:
// [{ device, hears: true | false | null, heardAt, path: { pathLen, path, at } | null }],
// those known to hear the target first, then those with a path, by name.
export function relayCandidates(rules, devices, target, now = Date.now()) {
  const rank = (c) => (c.hears === true ? 0 : c.path ? 1 : c.hears === null ? 2 : 3);
  return devices.filter((d) => relayRefusal(rules, d, target, now) === null).map((device) => {
    const finding = target?.relayHears?.[device.node] || null;
    return { device, hears: finding ? finding.hears : null, heardAt: finding?.at || null, path: target?.relayPaths?.[device.node] || null };
  }).sort((a, b) => rank(a) - rank(b) || String(a.device.name || a.device.node).localeCompare(String(b.device.name || b.device.node)));
}

// Why no node of the owner's can relay to `target` ({ code, vars }), or null when one can: the
// most telling reason among the others (switched off, before not heard, before none that could).
export function noRelayWhy(rules, devices, target, now = Date.now()) {
  const why = devices.filter((d) => d.node !== target?.node).map((d) => relayRefusal(rules, d, target, now));
  if (why.some((w) => w === null)) return null;
  for (const code of ['relayOff', 'relayNotHeard']) {
    const hit = why.find((w) => w.code === code);
    if (hit) return { code: `none.${code}`, vars: hit.vars };
  }
  return { code: 'none.relayCannot', vars: {} };
}

// The routes to offer through one candidate, the cheapest first.
export const routesFor = (candidate) => [candidate.hears === false ? null : 'neighbour', candidate.path ? 'path' : null, 'flood', 'flood-wide']
  .filter(Boolean);

// What auto may take: a relay known to hear the target directly, else one with a stored path;
// { relay, route } or null. Never a flood, and never a guess.
export function autoRelay(rules, devices, target, now = Date.now()) {
  const all = relayCandidates(rules, devices, target, now);
  const near = all.find((c) => c.hears === true);
  if (near) return { relay: near.device, route: 'neighbour' };
  const known = all.find((c) => c.path);
  return known ? { relay: known.device, route: 'path' } : null;
}

// One `neighbors` reply -> [{ prefix, secsAgo, snr }]; [] for "-none-" or anything else. A line
// is "<8 hex of the key>:<seconds since>:<SNR x 4>" (simple_repeater MyMesh::formatNeighborsReply).
export function parseNeighbors(reply) {
  const out = [];
  for (const line of String(reply || '').replace(/^>\s*/, '').split(/[\n,]+/)) {
    const m = line.trim().match(/^([0-9A-Fa-f]{8}):(-?\d+):(-?\d+)$/);
    if (m) out.push({ prefix: m[1].toUpperCase(), secsAgo: Number(m[2]), snr: Number(m[3]) / 4 });
  }
  return out;
}

// Does a relay's `neighbors` reply name the target? { hears: true, snr } when its key prefix is
// there; { hears: false } when the list is whole (shorter than the firmware shows, or "-none-")
// and lacks it; null when the reply is not such a list, or is full: the target may have been
// pushed out of it.
export function hearsTarget(reply, targetKey) {
  const text = String(reply || '').replace(/^>\s*/, '').trim();
  const rows = parseNeighbors(text);
  const prefix = String(targetKey || '').slice(0, 8).toUpperCase();
  if (!/^[0-9A-F]{8}$/.test(prefix)) return null;
  const hit = rows.find((r) => r.prefix === prefix);
  if (hit) return { hears: true, snr: hit.snr };
  const lines = text.split(/[\n,]+/).map((l) => l.trim()).filter(Boolean);
  const whole = text === '-none-' || (rows.length > 0 && rows.length === lines.length && rows.length < NEIGHBOURS_SHOWN);
  return whole ? { hears: false, snr: null } : null;
}

// `get mqtt.relay`: { on: true, phase, left, floods } from "> own, forwarded 3, answered 2, refused 0,
// burst, 39.9 s airtime left, floods today 1 of 100" (left in seconds of airtime, floods sent today),
// { on: false } from "> off", null for anything else.
export function parseRelayState(reply) {
  const text = String(reply || '').replace(/^>\s*/, '').trim();
  if (/^off\b/i.test(text)) return { on: false };
  if (!/^own\b/i.test(text)) return null;
  const m = text.match(/\b(idle|burst|cooldown),\s*(\d+(?:\.\d+)?)\s*s\s+airtime\s+left,\s*floods\s+today\s+(\d+)\s+of\s+\d+/i);
  return m ? { on: true, phase: m[1].toLowerCase(), left: Number(m[2]), floods: Number(m[3]) }
    : { on: true, phase: null, left: null, floods: null };
}

// "direct, N hops" of a stored path: the hash count of MeshCore's path length byte.
export const pathHops = (stored) => (stored ? stored.pathLen & 63 : null);
