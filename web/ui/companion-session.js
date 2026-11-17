// The page's one connection to the owner's companion radio (W-16), kept open from "Connect" to
// "Disconnect" or until the radio goes away, so a send does not ask the browser again. The jobs
// read it through current(); the screens draw its state and listen for changes.
//
//   support()        { bluetooth, usb, ios }: what this browser can reach
//   connect(kind)    'bluetooth' | 'usb'; must run in a click (the browser shows its chooser)
//   state()          { status: 'none' | 'connecting' | 'connected' | 'error', kind, name, error }
import { openCompanion } from '../lib/mesh/companion.js';
import { bluetoothAvailable, connectBluetooth } from '../lib/mesh/ble.js';
import { connectSerial, serialAvailable } from '../lib/mesh/serial.js';
import { setCompanionKind } from './screens/settings-store.js';

let radio = null;
let current = { status: 'none', kind: '', name: '', error: '' };
const listeners = new Set();

function set(next) {
  current = Object.freeze({ ...current, ...next });
  for (const fn of listeners) { try { fn(current); } catch { /* a screen gone */ } }
}

export function support(nav = globalThis.navigator) {
  const ua = nav?.userAgent || '';
  // iPadOS reports itself as a Mac; touch points tell it apart
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints || 0) > 1);
  return Object.freeze({ bluetooth: bluetoothAvailable(nav), usb: serialAvailable(nav), ios, secure: globalThis.isSecureContext !== false });
}

export const state = () => current;
export const companion = () => (radio && !radio.closed ? radio : null);

export function onCompanion(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function connect(kind) {
  if (current.status === 'connecting') return current;
  await disconnect();
  set({ status: 'connecting', kind, name: '', error: '' });
  let link = null;
  try {
    link = kind === 'bluetooth' ? await connectBluetooth() : await connectSerial();
    const opened = await openCompanion(link);
    radio = opened;
    link.onClose(() => {
      if (radio === opened) { radio = null; set({ status: 'none', name: '', error: '' }); }
    });
    try { setCompanionKind(kind); } catch { /* remembered for this page only */ }
    set({ status: 'connected', name: opened.self.name || link.label || '', error: '' });
  } catch (e) {
    try { await link?.close(); } catch { /* nothing to close */ }
    // the person closed the browser's chooser: not an error worth a sentence
    const cancelled = e?.name === 'NotFoundError' || e?.name === 'AbortError';
    set({ status: cancelled ? 'none' : 'error', name: '', error: cancelled ? '' : (e?.message || String(e)) });
  }
  return current;
}

export async function disconnect() {
  const r = radio;
  radio = null;
  if (r) { try { await r.close(); } catch { /* already gone */ } }
  if (current.status !== 'none') set({ status: 'none', name: '', error: '' });
}
