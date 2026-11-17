// What the board's tiles share (W-20c): the selected node and the tagged nodes. One store for the
// page, no DOM, so a tile can follow another without knowing it exists. Node ids are the
// 8-hex control ids the stores use ("4AC61A7F").
//
//   selected()          the selected node's id, or null
//   setSelected(id)     select a node (null for none); the board's ctx.board.select(id) also opens
//                       the node full screen on a phone
//   tagged()            the tagged ids, a new array in tagging order
//   setTagged(ids), toggleTag(id), clearTags()
//   onBoardChange(fn)   fn({ selected, tagged, what: 'selected' | 'tagged' }); returns unsubscribe

let current = null;
let tags = [];
const listeners = new Set();

const tell = (what) => {
  const state = { selected: current, tagged: [...tags], what };
  for (const fn of listeners) fn(state);
};

export const selected = () => current;
export const tagged = () => [...tags];

export function setSelected(id) {
  const next = id ? String(id).toUpperCase() : null;
  if (next === current) return;
  current = next;
  tell('selected');
}

export function setTagged(ids) {
  tags = [...new Set((ids || []).map((id) => String(id).toUpperCase()))];
  tell('tagged');
}

export function toggleTag(id) {
  const up = String(id).toUpperCase();
  setTagged(tags.includes(up) ? tags.filter((t) => t !== up) : [...tags, up]);
}

export const clearTags = () => setTagged([]);

export function onBoardChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
