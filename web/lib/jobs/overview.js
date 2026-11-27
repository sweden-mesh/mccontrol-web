// What the overview dashboard says, as pure functions of the stored devices and history
// (plan §12.5): what needs attention, what came back since the last visit, and the fleet's
// counts. No I/O; the dashboard passes what it read.
import { resultKind } from '../store/index.js';
import { updateAvailable } from './releases.js';

const HOUR = 3600000;

// A battery reading (W-26j): a node without a battery, or one that reports 0 mV, has no reading.
// 0 and missing are the same; a real low reading (3.10 V) is shown as it is.
export const batteryKnown = (mv) => Number.isFinite(mv) && mv > 0;
export const NO_READING = 'NA';
// "3.98 V", or "NA" when there is no reading: never "0.00 V".
export const voltsText = (mv) => (batteryKnown(mv) ? `${(mv / 1000).toFixed(2)} V` : NO_READING);

// The newest moment the node was heard on MQTT: its last status on Beacon, its last answer to us
// (answers travel over MQTT too), or its alive message that opened under our key and says it is
// online: that is the node speaking to its owner. For a node without Wi-Fi, also when one of the
// owner's Observer nodes caught its announce (`heard`). null when none is known.
export function lastHeard(device) {
  const alive = device.alive?.state === 'online' ? device.alive.at : null;
  const times = [device.fleet?.seen, device.lastHeard, alive, device.heard?.at].filter(Boolean).map((t) => Date.parse(t)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

// The newest battery reading of a node, or null: { mv, at (ms or null), source, by, byName }.
// source 'beacon' is the node's own status (a node on Wi-Fi); 'heard' is the announce of a node
// without Wi-Fi, caught by the owner's Observer node `by`. With both, the newer.
export function batteryReading(device) {
  const ms = (t) => { const at = Date.parse(t || ''); return Number.isFinite(at) ? at : null; };
  const out = [];
  if (batteryKnown(device?.fleet?.batteryMv)) out.push({ mv: device.fleet.batteryMv, at: ms(device.fleet.seen), source: 'beacon', by: null, byName: null });
  const h = device?.heard;
  if (batteryKnown(h?.batteryMv)) out.push({ mv: h.batteryMv, at: ms(h.at), source: 'heard', by: h.by || null, byName: h.byName || null });
  out.sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
  return out[0] || null;
}

// [{ node, name, kind, vars }] in the order the plan gives: not heard on MQTT for `hours`,
// battery under `thresholdMv`, a refused (or forged) last command, outdated firmware.
// A node with no evidence either way is not reported as silent: absence of evidence is not
// a finding.
export function needsAttention(devices, { now, hours, thresholdMv, release = null, rules }) {
  const out = [];
  const name = (d) => d.name || d.node;
  for (const d of devices) {
    // A node without Wi-Fi never speaks on MQTT: its silence there is how it is, not a finding.
    if (rules?.deviceMeshOnly?.(d)) continue;
    const heard = lastHeard(d);
    if (heard !== null && now - heard > hours * HOUR) {
      out.push({ node: d.node, name: name(d), kind: 'notHeard', vars: { hours: Math.floor((now - heard) / HOUR) }, at: heard });
    }
  }
  for (const d of devices) {
    // The newest reading, whatever its age: Beacon's, or the announce of a node without Wi-Fi.
    const b = batteryReading(d);
    if (b && b.mv < thresholdMv) {
      out.push({ node: d.node, name: name(d), kind: 'battery', vars: { volts: (b.mv / 1000).toFixed(2) }, at: b.at ?? NaN });
    }
  }
  for (const d of devices) {
    const r = d.lastResult;
    // The last command got no answer, from a node that has been heard before: it may be gone, or
    // the answer was lost. (A node never heard stays "not known": there is nothing to compare with.)
    if (r && r.code === null && r.verified !== false && lastHeard(d) !== null) {
      out.push({ node: d.node, name: name(d), kind: 'noAnswer', vars: { command: r.command }, at: Date.parse(r.at) });
    } else if (r && r.verified === false) out.push({ node: d.node, name: name(d), kind: 'forged', vars: { command: r.command }, at: Date.parse(r.at) });
    else if (r && r.code !== null && r.code !== 0) {
      out.push({ node: d.node, name: name(d), kind: 'refused', vars: { command: r.command, code: r.codeName || String(r.code) }, at: Date.parse(r.at) });
    }
  }
  for (const d of devices) {
    if (updateAvailable(rules, d.ver, release)) {
      out.push({ node: d.node, name: name(d), kind: 'outdated', vars: { version: shortVersion(rules, d.ver), latest: release.tag }, at: null });
    }
  }
  return out;
}

// Events since `since` (ISO), newest first, without the region-wide count lines.
export function recentSince(events, since, limit = 20) {
  return events.filter((e) => (!since || e.at > since) && resultKind(e) !== 'summary').slice(0, limit);
}

// { total, regions: [[code, n]], heard, quiet, unknown, versions: [[label, n]], results: {ok, refused, silent, forged} }
export function fleetCounts(devices, { now, hours, rules }) {
  const regions = new Map();
  const versions = new Map();
  let heard = 0; let quiet = 0; let unknown = 0;
  const results = { ok: 0, refused: 0, silent: 0, forged: 0 };
  for (const d of devices) {
    regions.set(d.region, (regions.get(d.region) || 0) + 1);
    const v = d.ver ? shortVersion(rules, d.ver) : null;
    versions.set(v, (versions.get(v) || 0) + 1);
    const at = rules?.deviceMeshOnly?.(d) ? null : lastHeard(d);      // radio only: never heard on MQTT, so not quiet
    if (at === null) unknown += 1;
    else if (now - at > hours * HOUR) quiet += 1;
    else heard += 1;
    if (d.lastResult) results[resultKind({ ...d.lastResult, node: d.node, note: '' })] += 1;
  }
  const byCount = (a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]));
  return { total: devices.length, regions: [...regions].sort(byCount), heard, quiet, unknown, versions: [...versions].sort(byCount), results };
}

// "lou-20-arrc-observer" from a whole version line: the revision and what the image carries (ar
// auto-reply, rc remote control, arrc both, observer the Observer firmware with Wi-Fi and MQTT),
// without the board, the base version and the build hash. "lou-18" or "ar-10" when the line names
// no more; the line itself when it has no revision. The line of `ver` starts
// "esp32s3-v1.18.0-lou-20-…", the one in an alive message "lou-20-…": both shorten the same way.
// A release candidate keeps its mark ("lou-20rc").
export function shortVersion(rules, version) {
  if (!version) return null;
  const m = /(?:^|-)(lou|ar)-(\d+(?:rc\d*)?)((?:-(?:arrc|ar|rc|observer)(?=[-\s]|$))*)/i.exec(version);
  if (m) return `${m[1]}-${m[2]}${m[3]}`.toLowerCase();
  return rules.revision(version) === null ? version.slice(0, 24) : version;
}
