// What the address names (W-20c, W-20d). The board is the page and is never navigated away from;
// a hash names a modal in front of it: "#node/4AC61A7F", "#setup/key", "#help/codes". An empty
// hash (or "#") is the board alone. No DOM here, so the tests can run it.
//
// The old screens had routes ("#/nodes", "#/node/<id>", "#/key"...). Links to them, bookmarks and
// the screens' own navigate() calls still work: legacyHash() maps each onto the board or a modal.
// A hash that is neither (an in-page anchor such as the skip link's "#main") is left alone.

// Old routes whose content now lives in Setup's tabs (proposal §2.5).
export const INTO_SETUP = Object.freeze({ key: 'key', setup: 'node', settings: 'settings', groups: 'groups', sets: 'sets' });

const split = (path) => path.split('/').filter((p, i) => i === 0 || p !== '');

export function modalHash(name, args = []) {
  return `#${[name, ...args.map((a) => encodeURIComponent(String(a)))].join('/')}`;
}

// "#/node/AB" -> "#node/AB"; "#/key" -> "#setup/key"; "#/" -> "" (the board); an old route that
// no longer exists -> "#notfound".
export function legacyHash(hash, isModal = () => true) {
  const [name, ...args] = split(String(hash).replace(/^#\/?/, ''));
  if (!name) return '';
  if (INTO_SETUP[name]) return modalHash('setup', [INTO_SETUP[name], ...args].map(decodeURIComponent));
  if (!isModal(name)) return '#notfound';
  return modalHash(name, args.map(decodeURIComponent));
}

// { kind: 'board' } | { kind: 'legacy', hash } | { kind: 'modal', name, args } | { kind: 'other' }
export function parseHash(hash, isModal) {
  const text = String(hash || '');
  if (text === '' || text === '#') return { kind: 'board' };
  if (text.startsWith('#/')) return { kind: 'legacy', hash: legacyHash(text, isModal) };
  const [name, ...args] = split(text.slice(1));
  if (isModal(name)) return { kind: 'modal', name, args: args.map(decodeURIComponent) };
  return { kind: 'other' };
}

// A hash a screen asks to go to (old or new form), as the hash to set.
export function targetHash(hash, isModal) {
  const p = parseHash(hash, isModal);
  return p.kind === 'legacy' ? p.hash : p.kind === 'board' ? '' : String(hash);
}
