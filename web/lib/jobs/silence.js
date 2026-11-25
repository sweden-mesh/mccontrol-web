// Why a command over the mesh got no answer, and what to try: the decision, as pure functions
// (a port of mccontrol/silence.py). No DOM, nothing sent.
//
// Silence over the mesh is one of two things the app usually cannot tell apart: the node was
// out of answer airtime (it then says nothing, and counts the request under `refused` in
// `get cmd`), or a packet was lost. It can tell when a `get cmd` read before the silence and
// one after it show `refused` rising. Only what was already read is used.
//
// Per device the store keeps `silence: { direct, base, refused }`: direct sends in a row
// without an answer; the `refused` count of a `get cmd` read with no mesh send after it; and
// that count carried across a silence, to compare with the next read. A node counts a request
// it answered with a refusal under `refused` too, so such an answer drops the count carried.

export const MESH_ROADS = Object.freeze(['mesh', 'relay']);
export const ADVICE = Object.freeze(['refused', 'flood']);
export const FLOOD_AFTER = 2;
const READS = ['get cmd', 'get mqtt.cmd'];       // lou-20, and the name on lou-19

// The `refused` count in a `get cmd` reply (", mesh <mode> ok <n> refused <m>"), or null.
export function refusedCount(command, reply) {
  if (!READS.includes(String(command || '').split(/\s+/).filter(Boolean).join(' ').toLowerCase())) return null;
  const m = /\bmesh \S+ ok \d+ refused (\d+)/.exec(String(reply || ''));
  return m ? Number(m[1]) : null;
}

// { state, before, after } after one send. `outcome` is 'ok', 'refused' (the node answered with
// a refusal), 'silent' (sent, no answer) or 'unknown' (not known whether it was sent); `direct`
// says a mesh-road send followed a stored path; `read` is the `refused` count when this answer
// was a `get cmd`. before and after are the two counts around a silence, null unless both are known.
export function step(state, road, outcome, direct = false, read = null) {
  const s = { direct: 0, base: null, refused: null, ...(state || {}) };
  let before = null; let after = null;
  if (MESH_ROADS.includes(road)) {
    if (outcome === 'silent') {
      if (s.refused === null) s.refused = s.base;
      s.direct = direct ? s.direct + 1 : 0;
    } else {
      if (outcome !== 'unknown') s.direct = 0;
      if (outcome !== 'ok') s.refused = null;
    }
    s.base = null;
  }
  if (read !== null) {
    if (s.refused !== null) { before = s.refused; after = read; }
    s.refused = null;
    s.base = read;
  }
  return { state: s, before, after };
}

// What to say beside a result, as words from ADVICE: 'refused' when the two counts show the
// node refused for lack of airtime; 'flood' after two direct sends in a row without an answer
// (a suggestion only). What a silence over the mesh can mean is said for every such silence
// (ui/screens/node-kit.js) and needs no word here.
export function advice(road, outcome, losses = 0, before = null, after = null) {
  const out = [];
  if (before !== null && after !== null && after > before) out.push('refused');
  if (MESH_ROADS.includes(road) && outcome === 'silent' && losses >= FLOOD_AFTER) out.push('flood');
  return out;
}
