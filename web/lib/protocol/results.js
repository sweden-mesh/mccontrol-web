// What a node publishes on its /res topic: r1 (plain), r2 (signed by the node, ar-11) and r3
// (sealed to us, ar-13). A port of envelope.parse_result and envelope.parse_r3.
//
// A Result is a frozen { node, counter, code, command, reply, verified, ok }. `verified` is
// true for an r2 whose signature checked, or an r3 whose tag did; null for an r1, or an r2
// with no key to check it against; false for a forged or altered line, which is a finding,
// not a result. Silence is the absence of a Result, never an empty one.
import { ed25519 } from '../../vendor/noble-curves/ed25519.js';
import { fromHex, utf8 } from '../bytes.js';
import { DIR_RESULT, FIELD_SEP, R1, R2, R3, SIG_HEX_LEN } from './constants.js';
import { openSealed, signedMessage, v2Key } from './envelope.js';
import { codePoints, pyInt, unb64url } from './text.js';

const RESULT_FIELDS = 5;
const lenient = new TextDecoder('utf-8');                 // "replace", as Python decodes r3
const strict = new TextDecoder('utf-8', { fatal: true });

export function makeResult(node, counter, code, command, reply, verified = null) {
  return Object.freeze({
    node, counter, code, command, reply, verified,
    // Ran, and -- when signed -- said so in the node's own voice. A forged ok is not ok.
    ok: code === 0 && verified !== false,
  });
}

// The name of a result code ("not-allowed"), from lib/data/results.json.
export function codeName(results, code) {
  return results.codes[String(code)] ?? results.unknown.replace('{code}', String(code));
}

// What a result code means to a person, or ''.
export const codeHelp = (results, code) => results.help[String(code)] ?? '';

function asText(payload, decoder) {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === 'string') return payload;
  try {
    return decoder.decode(payload);
  } catch {
    return null;
  }
}

function verifyNode(keyHex, topic, line, sigHex) {
  try {
    return ed25519.verify(fromHex(sigHex), signedMessage(topic, line), fromHex(keyHex));
  } catch {
    return false;
  }
}

// One /res line (string or bytes) as a Result, or null for anything that is not one. With
// `topic` and the node's whole `keyHex` an r2 is checked; without, it is reported unverified.
export function parseResult(payload, node = null, { topic = null, keyHex = null } = {}) {
  const text = asText(payload, strict);
  if (text === null) return null;
  let verified = null;
  let line = text;
  if (text.startsWith(R2 + FIELD_SEP)) {
    const split = text.lastIndexOf(FIELD_SEP);
    if (split < 0 || codePoints(text.slice(split + 1)) !== SIG_HEX_LEN) return null;
    line = text.slice(0, split);
    if (topic && keyHex) verified = verifyNode(keyHex, topic, line, text.slice(split + 1));
  }
  const head = line.split(FIELD_SEP);
  if (head.length < RESULT_FIELDS) return null;
  const parts = [...head.slice(0, RESULT_FIELDS - 1), head.slice(RESULT_FIELDS - 1).join(FIELD_SEP)];
  if (parts[0] !== R1 && parts[0] !== R2) return null;
  const counter = pyInt(parts[1]);
  const code = pyInt(parts[2]);
  if (Number.isNaN(counter) || Number.isNaN(code) || counter < 0 || code < 0) return null;
  return makeResult(node, counter, code, parts[3], parts[4], verified);
}

// An r3 line opened with the key for command topic `topic`: verified true when the tag holds,
// a forged Result (verified false, code null) when it does not, a Result with verified null
// when there is no node key to open it with, and null for anything that is not an r3.
export function parseR3(payload, node, handle, nodeKeyHex, topic) {
  const text = asText(payload, strict);
  if (text === null) return null;
  const parts = text.split(FIELD_SEP);
  if (parts.length !== 3 || parts[0] !== R3 || !/^[0-9]+$/.test(parts[1])) return null;
  const counter = Number(parts[1]);
  if (counter > 0xffffffff) return null;
  const forged = makeResult(node, counter, null, '', '', false);
  let sealed;
  try {
    sealed = unb64url(parts[2]);
  } catch {
    return forged;
  }
  let key;
  try {
    key = v2Key(handle, nodeKeyHex, topic);
  } catch {
    return makeResult(node, counter, null, '', '', null);
  }
  let plain;
  try {
    plain = openSealed(key, DIR_RESULT, counter, utf8(`${R3}${FIELD_SEP}${counter}`), sealed);
  } catch {
    return forged;
  }
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  const fields = lenient.decode(plain.subarray(0, end)).split(FIELD_SEP);
  if (fields.length < 3 || !/^[0-9]+$/.test(fields[0])) return forged;
  return makeResult(node, counter, Number(fields[0]), fields[1], fields.slice(2).join(FIELD_SEP), true);
}

// Either kind, by its tag: what transport hands every message on a result topic.
export function parseAny(payload, node, { handle, topic, keyHex, commandTopic }) {
  const text = asText(payload, strict);
  if (text !== null && text.startsWith(R3 + FIELD_SEP)) return parseR3(text, node, handle, keyHex, commandTopic);
  return parseResult(text, node, { topic, keyHex });
}
