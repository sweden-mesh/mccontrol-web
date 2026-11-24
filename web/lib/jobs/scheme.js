// Which plane a node speaks (IATA-2 §7), a port of mccontrol-cli's actions.scheme: mcc3 when its
// alive opened under our key (and it has not since been rekeyed away) or its version is lou-20 or
// later; else 'old', the per-node IATA scheme of lou-19 and older. lou-20 takes both.
//
// An area act (a county, from the nodes' own `region home` in their alive) is one sealed command
// per node, in random order, spaced so the fleet does not reboot and re-announce at one instant:
// 10-90 s, a command that restarts the node 5-30 min (actions.act_spacing).

export const MCC3_FROM = 20;
export const ACT_SPACING = Object.freeze([10, 90]);
export const ACT_SPACING_RESTART = Object.freeze([300, 1800]);

export function speaksMcc3(rules, version) {
  const rev = version ? rules.revision(version) : null;
  return rev !== null && rev !== undefined && rev >= MCC3_FROM;
}

export function scheme(rules, device) {
  const alive = device?.alive;
  if (alive && alive.state !== 'not-yours') return 'mcc3';
  if (speaksMcc3(rules, device?.ver)) return 'mcc3';
  // Added by its key, nothing read from it yet (a node without MQTT cannot say its version before
  // the first command reaches it) and no IATA code to address the old scheme by: the old scheme
  // cannot be tried at all, so the first command goes the new way.
  if (!alive && !device?.ver && /^[0-9A-Fa-f]{64}$/.test(device?.key || '') && !oldRegion(device)) return 'mcc3';
  return 'old';
}

// The IATA code the old scheme addresses the node by: its stored one, else the one Beacon's
// fleet read names for it. Never shown or chosen in the page; null when neither is known.
export function oldRegion(device) {
  const r = String(device?.region || device?.fleet?.iatas?.[0] || '').trim().toUpperCase();
  return /^[A-Z0-9]{2,8}$/.test(r) ? r : null;
}

// A node's area: its own `region home` from its alive, folded to lower case, or null.
export const areaOf = (device) => (device?.alive?.state !== 'not-yours' && device?.alive?.region
  ? String(device.alive.region).trim().toLowerCase() : null);

// Seconds between two nodes of an area act.
export const actSpacing = (rules, command) => (rules.broadcastRefusal(command) ? ACT_SPACING_RESTART : ACT_SPACING);

// A copy in random order (Fisher-Yates; `random` for the tests).
export function shuffled(list, random = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
