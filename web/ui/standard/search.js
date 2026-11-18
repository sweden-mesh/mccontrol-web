// The node list's live search (W-29g): a substring of the name, case and diacritics ignored
// ("vaster" finds "Väster", "OXNE" finds "Öxnehaga"), or a hex prefix of the public key (or of
// the 8-hex control id). No DOM.
export const fold = (text) => String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function nodeMatches(device, query) {
  const q = fold(query).trim();
  if (!q) return true;
  if (fold(device.name || device.node).includes(q)) return true;
  if (/^[0-9a-f]+$/.test(q)) return [device.key, device.node].some((k) => k && k.toLowerCase().startsWith(q));
  return false;
}
