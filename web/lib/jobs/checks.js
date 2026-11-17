// The checks before anything is signed: the deny list, the broadcast rules, plain ASCII for old
// firmware, a region, and what the node's firmware admits. A port of the checks in
// mccontrol/actions.py's send and api/jobs.py's _vet, driven by rules.js (lib/data/).
//
// A refusal is { code, vars }: the screens say it through t(`send.why.${code}`, vars), so the
// same reason reads the same everywhere. `vars.detail` carries the deny list's own sentence.
import { isTransmit } from '../protocol/envelope.js';
import { squash } from '../protocol/text.js';
import { MESH } from '../protocol/constants.js';
import { MESH_AFTER_MINS, chooseRoad } from './road.js';

export class JobError extends Error {
  constructor(code, vars = {}, message = code) {
    super(message);
    this.code = code;
    this.vars = vars;
  }
}

const ascii = (text) => /^[\x00-\x7f]*$/.test(text);
const bytes = (text) => new TextEncoder().encode(text).length;

// Why every road `road` may take would refuse `text` to `device` (api/jobs.py's _refusal): over
// the mesh the repair allowance travels and a mesh-only node refuses what needs an uplink; auto
// refuses only what both roads refuse.
function roadRefusal(rules, text, device, road) {
  if (road === 'mqtt' || !device) return rules.refusal(text);
  const only = rules.deviceMeshOnly(device);
  let onMesh = rules.meshRefusal(text, only);
  if (onMesh === null && bytes(text) > MESH.max_command) onMesh = `over the mesh a command is 1..${MESH.max_command} bytes`;
  return road === 'mesh' || only ? onMesh : (onMesh && rules.refusal(text));
}

// What the mesh road needs of the node before anything is signed (actions.send_mesh): a
// command of at most 59 bytes, the node's whole key, firmware that speaks it.
export function meshBlocker(rules, text, device) {
  const name = device.name || device.node;
  if (bytes(text) > MESH.max_command) return { code: 'meshTooLong', vars: { bytes: bytes(text), max: MESH.max_command } };
  if (!device.key || !/^[0-9A-Fa-f]{64}$/.test(device.key)) return { code: 'meshNoKey', vars: { name } };
  if (rules.speaksMesh(device.ver) === false) return { code: 'meshOldFirmware', vars: { name, version: device.ver } };
  return null;
}

// Why `command` cannot go to `device` (or, with `region`, to every node there) by `road`
// ('mqtt', 'mesh' or 'auto'), or null.
export function blocker(rules, { command, device = null, region = null, road = 'mqtt' }) {
  const text = squash(command);
  if (!text) return { code: 'empty', vars: {} };
  if (region && road === 'mesh') return { code: 'meshBroadcast', vars: {} };
  const denied = roadRefusal(rules, text, region ? null : device, region ? 'mqtt' : road);
  if (denied) return { code: 'denied', vars: { command: text, detail: denied } };
  if (region) {
    if (isTransmit(text)) return { code: 'broadcastTransmit', vars: { command: text } };
    if (rules.broadcastRefusal(text)) return { code: 'broadcastUpdate', vars: { command: text } };
    if (!ascii(text)) return { code: 'broadcastAscii', vars: {} };
    return null;
  }
  if (!device) return { code: 'noTarget', vars: {} };
  if (!device.region) return { code: 'noRegion', vars: { name: device.name || device.node } };
  const only = rules.deviceMeshOnly(device);
  if (only && road === 'mqtt') return { code: 'meshOnlyNode', vars: { name: device.name || device.node } };
  if (road === 'mesh' || only) {
    const mesh = meshBlocker(rules, text, device);
    if (mesh) return mesh;
  }
  if (!ascii(text) && !rules.admitsUtf8(device.ver)) {
    return { code: 'oldAscii', vars: { name: device.name || device.node, version: device.ver || '?' } };
  }
  return null;
}

// Everything a send screen shows before the button: the blocker, the caution, the table entry the
// command stops short of a value for (incomplete), and what the
// node's firmware says about the command (admits: true | false | null when the version is not
// known; lacks: 'ar' | 'rc' | null; needs: the oldest tag that admits it), whether it goes
// encrypted (v2: the firmware opens it and the whole key is known), and for one node the road
// it would take now ({ road, why } from road.js, with what the device itself remembers).
export function preflight(rules, { command, device = null, region = null, road = 'mqtt', meshAfterMins = MESH_AFTER_MINS, now = Date.now() }) {
  const text = squash(command);
  const block = blocker(rules, { command: text, device, region, road });
  const known = Boolean(device?.ver);
  let choice = null;
  if (!region && device && text) {
    try { choice = chooseRoad(rules, { device, command: text, via: road, meshAfterMins, now }); } catch { choice = null; }
  }
  const onMesh = choice?.road === 'mesh';
  return Object.freeze({
    command: text,
    block,
    caution: text ? rules.caution(text) : null,
    incomplete: text ? rules.missingValue(text) : null,
    admits: known && text && !onMesh ? rules.admits(device.ver, text) : null,
    lacks: known && text && !onMesh ? rules.lacks(device.ver, text) : null,
    needs: text ? rules.needs(text) : null,
    v2: Boolean(!region && !onMesh && device?.key && rules.speaksV2(device.ver)),
    read: text ? rules.isRead(text) : false,
    road: choice,
  });
}

// A set's steps with {arg} filled in; refuses a set that needs a value and has none.
export function fillSteps(steps, arg) {
  const value = String(arg || '').trim();
  if (steps.some((s) => s.includes('{arg}')) && !value) throw new JobError('needsArg', {}, 'this set needs a value for {arg}');
  return steps.map((s) => s.replaceAll('{arg}', value));
}
