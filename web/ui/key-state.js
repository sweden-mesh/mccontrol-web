// What the shell knows about the key: whether there is one, whether it is unlocked, and its
// public key. The shell and the screens read it here and never touch lib/key/ themselves.
//
// Until the key stream (W-5) lands this is a stub that always says "no key". W-5 plugs its store
// in with provideKeySource(source), where `source` has:
//   state()        -> { status: 'none' | 'locked' | 'unlocked', publicKeyHex: string | null }
//   subscribe(fn)  -> unsubscribe; fn() is called after every change of state()
// The raw seed and the signing handle stay in lib/key/; this interface never carries them.

const NONE = Object.freeze({ status: 'none', publicKeyHex: null });
const listeners = new Set();
let source = null;
let unsubscribeSource = null;

function notify() {
  for (const fn of listeners) fn(keyState());
}

export function provideKeySource(next) {
  if (unsubscribeSource) unsubscribeSource();
  source = next;
  unsubscribeSource = next ? next.subscribe(notify) : null;
  notify();
}

export function keyState() {
  const state = source ? source.state() : NONE;
  return Object.freeze({ status: state.status, publicKeyHex: state.publicKeyHex || null });
}

export function onKeyState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// "4AC61A7F…09E2": enough of the public key to recognise it, short enough for a phone header.
export function shortKey(hex) {
  if (!hex) return '';
  const up = String(hex).toUpperCase();
  return up.length <= 12 ? up : `${up.slice(0, 8)}…${up.slice(-4)}`;
}
