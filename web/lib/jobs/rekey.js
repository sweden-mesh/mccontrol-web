// Replacing the command key on the owner's nodes without a visit (`rekey`, lou-20 and later): the
// round as pure functions, and the one step that sends. A port of mccontrol/rekey.py; the wire is
// the firmware's (docs/mqtt-control.md, "Replacing the command key without a visit").
//
// A node takes `rekey <new public key>` signed by the key in use. The new key then waits there, in
// RAM, for 60 minutes or until the node restarts; it takes over the moment a command arrives that
// the new key signed. So per node: offer the new key with the old one, then prove with the new one.
// Until the owner finishes, this browser holds both keys (lib/key/keyring.js, `rekey*`).
//
//   start({ inUse, next, now })          a round: { v, from, next, started, nodes: {} }; nothing is sent
//   view(round, rules, device, now)      { state, why, left, expired, note } for one node
//   rotate({ load, save, rules, device, send, now, proveOnly })   offer and prove on ONE node
//   summary(round, rules, devices, now)  { proved, pending, sent, cannot }
//   finishRefusal(summary, leaveBehind)  why the round cannot finish ({ code, names }), or null
//   abortRefusal(summary)                why it cannot be aborted, or null
//
// A node's state: waiting (on the key in use), sent (offered, not proved), proved (on the new
// key), failed (the offer was refused or met with silence; it keeps the key in use), cannot (older
// firmware, or not enough known of it: never sent anything). The names in mccontrol/rekey.py are
// old, offered, new and cannot; failed is `old` with the last attempt remembered.
//
// Where this differs from the terminal tool, on purpose:
//   - an offer counts only when the node says OK (the firmware answers a malformed key, and the key
//     in use, with code 0 and "Err - ...");
//   - any answer that opens under the new key proves the node took it, a refusal too: only a node
//     that holds the new key can seal to it, and abort must not strand such a node;
//   - a node that was offered the key can be proved again without a new offer while its 60 minutes
//     run (one transmission, not two); `proveOnly: false` offers again, as the terminal tool does.
//
// No DOM. `send(signer, command, device)` is the caller's: 'old' signs with the key in use, 'new'
// with the next key; it resolves to a job outcome ({ result, ... }) and is called for one node,
// one command at a time, never again by itself.

export const WINDOW_MS = 60 * 60 * 1000;
export const REKEY_FROM = 20;
export const PROOF_COMMAND = 'ver';
export const META_ID = 'rekey';
export const STATES = Object.freeze({ waiting: 'waiting', sent: 'sent', proved: 'proved', failed: 'failed', cannot: 'cannot' });
// Why a node cannot be rotated from here.
export const WHY = Object.freeze({ noKey: 'noKey', noVersion: 'noVersion', usb: 'usb' });

const KEY = /^[0-9A-F]{64}$/;

export class RekeyError extends Error {
  constructor(code, vars = {}, message = code) {
    super(message);
    this.code = code;
    this.vars = vars;
  }
}

// A public key as `rekey` takes it: 32 bytes as 43 base64url characters, no padding.
export function keyText(publicHex) {
  const hex = String(publicHex || '').toUpperCase();
  if (!KEY.test(hex)) throw new RekeyError('badKey', {}, 'a public key is 64 hex characters');
  const bytes = hex.match(/../g).map((b) => parseInt(b, 16));
  const text = btoa(String.fromCharCode(...bytes));
  return text.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export const offerCommand = (publicHex) => `rekey ${keyText(publicHex)}`;

// Why this node cannot be rotated from here (WHY), or null. A port of rekey.why_not.
export function whyNot(rules, device) {
  if (!KEY.test(String(device?.key || '').toUpperCase())) return WHY.noKey;
  const rev = rules.revision(device.ver);
  if (rev === null || rev === undefined) return WHY.noVersion;
  if (rev < REKEY_FROM || !rules.has(device.ver, 'rc')) return WHY.usb;
  return null;
}

// A round. Nothing is sent; the caller has made the next key already.
export function start({ inUse, next, now }) {
  const from = String(inUse || '').toUpperCase();
  const to = String(next || '').toUpperCase();
  if (!KEY.test(from) || !KEY.test(to)) throw new RekeyError('badKey', {}, 'a public key is 64 hex characters');
  if (from === to) throw new RekeyError('sameKey', {}, 'that is the key in use');
  return Object.freeze({ v: 1, from, next: to, started: now, nodes: Object.freeze({}) });
}

// One node as the round sees it now. `left`: milliseconds the offered key still waits on the node
// (state sent only); `expired`: it was offered and its 60 minutes are over, so the node has
// forgotten it and is on the key in use again.
export function view(round, rules, device, now) {
  const why = whyNot(rules, device);
  if (why) return { state: STATES.cannot, why, left: null, expired: false, note: null };
  const e = round?.nodes?.[device.node] || null;
  const out = { state: STATES.waiting, why: null, left: null, expired: false, note: e?.note ?? null };
  if (!e) return out;
  if (e.state === STATES.proved) return { ...out, state: STATES.proved };
  if (e.state === STATES.failed) return { ...out, state: STATES.failed };
  if (e.state === STATES.sent) {
    const left = e.at + WINDOW_MS - now;
    return left > 0 ? { ...out, state: STATES.sent, left } : { ...out, expired: true };
  }
  return out;
}

// What is sent to a node in that state, in order: 'offer' (signed by the key in use), 'prove'
// (signed by the next key). A node on the next key is only proved again.
export function stepsFor(v, proveOnly = false) {
  if (v.state === STATES.cannot) return [];
  if (v.state === STATES.proved || (v.state === STATES.sent && proveOnly)) return ['prove'];
  return ['offer', 'prove'];
}

// Did the node take the offer? Only its own OK: "OK - the new key waits 60 min: ...".
export const offerAccepted = (result) => Boolean(result && result.ok && result.verified !== false
  && /^OK\b/i.test(String(result.reply || '').replace(/^>\s*/, '').trim()));

// Did an answer to a command the next key signed open under the next key? Then the node holds it.
export const proofAccepted = (result) => Boolean(result && result.verified === true);

// The round after one step to `node` went `ok` or not.
export function apply(round, node, step, ok, now) {
  const before = round.nodes[node] || null;
  const live = before?.state === STATES.sent && before.at + WINDOW_MS - now > 0;
  let next;
  if (step === 'offer') {
    if (before?.state === STATES.proved) next = before;
    else if (ok) next = { state: STATES.sent, at: now, note: null };
    // An earlier offer that still waits is not undone by a later one that did not arrive.
    else next = live ? { ...before, note: 'offer' } : { state: STATES.failed, at: now, note: 'offer' };
  } else if (step === 'prove') {
    if (ok) next = { state: STATES.proved, at: now, note: null };
    else next = before ? { ...before, note: 'prove' } : { state: STATES.failed, at: now, note: 'prove' };
  } else {
    throw new RekeyError('badStep', {}, `no step named ${step}`);
  }
  return Object.freeze({ ...round, nodes: Object.freeze({ ...round.nodes, [node]: Object.freeze(next) }) });
}

// Offer the next key to `device` with the key it has, then prove with the next key. One node, at
// most two sends, each once. Resolves to { state, steps: [{ step, ok, outcome }], round }.
// A node that cannot take it is refused before anything is signed.
export async function rotate({ load, save, rules, device, send, now = () => Date.now(), proveOnly = false }) {
  let round = await load();
  if (!round) throw new RekeyError('notStarted', {}, 'no key replacement is under way');
  const why = whyNot(rules, device);
  if (why) throw new RekeyError(why, { name: device?.name || device?.node }, 'this node cannot take a new key from here');
  const steps = [];
  for (const step of stepsFor(view(round, rules, device, now()), proveOnly)) {
    const outcome = await send(step === 'offer' ? 'old' : 'new', step === 'offer' ? offerCommand(round.next) : PROOF_COMMAND, device);
    const ok = step === 'offer' ? offerAccepted(outcome?.result) : proofAccepted(outcome?.result);
    round = apply(round, device.node, step, ok, now());
    await save(round);
    steps.push({ step, ok, outcome });
    if (!ok) break;
  }
  return { state: view(round, rules, device, now()).state, steps, round };
}

// The round over the owner's nodes: who is on the next key (proved), who could be and is not
// (pending; `sent` is those of them an offer still waits on, who may have taken it unseen), and
// who cannot be reached from here (cannot: [{ device, why }]).
export function summary(round, rules, devices, now) {
  const out = { proved: [], pending: [], sent: [], cannot: [] };
  for (const device of devices) {
    const v = view(round, rules, device, now);
    if (v.state === STATES.cannot) out.cannot.push({ device, why: v.why });
    else if (v.state === STATES.proved) out.proved.push(device);
    else {
      out.pending.push(device);
      if (v.state === STATES.sent) out.sent.push(device);
    }
  }
  return out;
}

const names = (devices) => devices.map((d) => d.name || d.node);

// rekey.finish: every node that can must be on the next key, unless the owner leaves them behind;
// and with no node on it there is nothing to finish.
export function finishRefusal(sum, leaveBehind = false) {
  if (leaveBehind) return null;
  if (sum.pending.length) return { code: 'left', names: names(sum.pending) };
  if (!sum.proved.length) return { code: 'none', names: [] };
  return null;
}

// rekey.abort: only while no node has taken the next key.
export function abortRefusal(sum) {
  return sum.proved.length ? { code: 'taken', names: names(sum.proved) } : null;
}

// The nodes proved on the next key: whoever signs for them, and seals a relay hop to them, uses it.
export const provedNodes = (round) => new Set(Object.entries(round?.nodes || {})
  .filter(([, e]) => e.state === STATES.proved).map(([node]) => node));
