// The checks before anything is signed: the deny list, the broadcast rules, plain ASCII for old
// firmware, a region, and what the node's firmware admits. A port of the checks in
// mccontrol/actions.py's send and api/jobs.py's _vet, driven by rules.js (lib/data/).
//
// A refusal is { code, vars }: the screens say it through t(`send.why.${code}`, vars), so the
// same reason reads the same everywhere. `vars.detail` carries the deny list's own sentence.
import { isTransmit } from '../protocol/envelope.js';
import { squash } from '../protocol/text.js';

export class JobError extends Error {
  constructor(code, vars = {}, message = code) {
    super(message);
    this.code = code;
    this.vars = vars;
  }
}

const ascii = (text) => /^[\x00-\x7f]*$/.test(text);

// Why `command` cannot go to `device` (or, with `region`, to every node there), or null.
export function blocker(rules, { command, device = null, region = null }) {
  const text = squash(command);
  if (!text) return { code: 'empty', vars: {} };
  const denied = rules.refusal(text);
  if (denied) return { code: 'denied', vars: { command: text, detail: denied } };
  if (region) {
    if (isTransmit(text)) return { code: 'broadcastTransmit', vars: { command: text } };
    if (!ascii(text)) return { code: 'broadcastAscii', vars: {} };
    return null;
  }
  if (!device) return { code: 'noTarget', vars: {} };
  if (!device.region) return { code: 'noRegion', vars: { name: device.name || device.node } };
  if (!ascii(text) && !rules.admitsUtf8(device.ver)) {
    return { code: 'oldAscii', vars: { name: device.name || device.node, version: device.ver || '?' } };
  }
  return null;
}

// Everything a send screen shows before the button: the blocker, the caution, and what the
// node's firmware says about the command (admits: true | false | null when the version is not
// known; lacks: 'ar' | 'rc' | null; needs: the oldest tag that admits it), and whether it goes
// encrypted (v2: the firmware opens it and the whole key is known).
export function preflight(rules, { command, device = null, region = null }) {
  const text = squash(command);
  const block = blocker(rules, { command: text, device, region });
  const known = Boolean(device?.ver);
  return Object.freeze({
    command: text,
    block,
    caution: text ? rules.caution(text) : null,
    admits: known && text ? rules.admits(device.ver, text) : null,
    lacks: known && text ? rules.lacks(device.ver, text) : null,
    needs: text ? rules.needs(text) : null,
    v2: Boolean(!region && device?.key && rules.speaksV2(device.ver)),
    read: text ? rules.isRead(text) : false,
  });
}

// A set's steps with {arg} filled in; refuses a set that needs a value and has none.
export function fillSteps(steps, arg) {
  const value = String(arg || '').trim();
  if (steps.some((s) => s.includes('{arg}')) && !value) throw new JobError('needsArg', {}, 'this set needs a value for {arg}');
  return steps.map((s) => s.replaceAll('{arg}', value));
}
