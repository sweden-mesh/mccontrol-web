// Which road a command to one node takes: MQTT, the mesh through the owner's companion, or
// auto. A port of mccontrol/actions.py's road and mqtt_heard_at.
//
//   auto takes the mesh for a mesh-only node, for a command only the mesh admits, and for a
//   node not heard over MQTT for `meshAfterMins` (a setting, 15 by default: the firmware's own
//   auto opens its road after 15); otherwise MQTT. The send itself takes the mesh after all when
//   the broker cannot be reached, and resends over MQTT after a mesh-closed answer (jobs.js).
//
// A choice is { road: 'mqtt' | 'mesh', why: { code, vars } | null }; the screens say `why`
// through t(`road.why.${code}`, vars).
import { squash } from '../protocol/text.js';
import { JobError } from './checks.js';

export const ROADS = Object.freeze(['auto', 'mqtt', 'mesh']);
export const MESH_AFTER_MINS = 15;

const ms = (iso) => {
  if (iso === null || iso === undefined || iso === '') return null;
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

// When the node was last heard over MQTT, in ms, or null: its status on Beacon (`seen`, asked
// just now), else its last answer over MQTT, else the fleet's last-seen; an answer from before
// roads were recorded counts as MQTT.
export function mqttHeardAt(device, seen = null) {
  if (ms(seen) !== null) return ms(seen);
  const all = [ms(device?.lastHeardMqtt), ms(device?.fleet?.seen)];
  if (!device?.lastHeardMesh) all.push(ms(device?.lastHeard));
  const known = all.filter((t) => t !== null);
  return known.length ? Math.max(...known) : null;
}

// The road the node view's selector starts on: the node's own last choice (W-26c), else MQTT for a
// node that has it, else (a node without MQTT) the mesh while a companion is connected and auto
// otherwise (W-26b, operator 2026-11-18: an MQTT node would only answer mesh-closed).
export function startRoad({ remembered = null, companion = false, meshOnly = false } = {}) {
  if (ROADS.includes(remembered) && !(meshOnly && remembered === 'mqtt')) return remembered;
  if (!meshOnly) return 'mqtt';
  return companion ? 'mesh' : 'auto';
}

export function chooseRoad(rules, { device = null, command = '', via = 'mqtt', meshAfterMins = MESH_AFTER_MINS, heardAt = null, now = Date.now() } = {}) {
  const want = String(via || 'mqtt').toLowerCase();
  if (!ROADS.includes(want)) throw new JobError('badRoad', {}, `the road is one of ${ROADS.join(', ')}`);
  if (!device) {
    if (want === 'mesh') throw new JobError('meshBroadcast', {}, 'the mesh road goes to one node at a time');
    return { road: 'mqtt', why: null };
  }
  if (rules.deviceMeshOnly(device)) {
    if (want === 'mqtt') throw new JobError('meshOnlyNode', { name: device.name || device.node }, 'mesh only: no Wi-Fi, no MQTT');
    return { road: 'mesh', why: { code: 'meshOnly', vars: {} } };
  }
  if (want !== 'auto') return { road: want, why: null };
  const text = squash(command);
  if (rules.refusal(text) && rules.meshRefusal(text) === null) return { road: 'mesh', why: { code: 'meshCommand', vars: {} } };
  const heard = heardAt ?? mqttHeardAt(device);
  if (heard !== null && now - heard >= meshAfterMins * 60000) {
    return { road: 'mesh', why: { code: 'notHeard', vars: { mins: Math.floor((now - heard) / 60000) } } };
  }
  return { road: 'mqtt', why: null };
}
