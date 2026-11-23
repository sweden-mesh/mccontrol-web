// The page's one connection to the owner's companion radio (W-16), kept open from "Connect" to
// "Disconnect" or until the radio goes away, so a send does not ask the browser again. The jobs
// read it through current(); the screens draw its state and listen for changes.
//
//   support()        { bluetooth, usb, network, ios }: what this browser can reach
//   connect(kind, { address, token })   'bluetooth' | 'usb' | 'network'; must run in a click (the
//                    browser shows its chooser, or for 'network' its local-network prompt). 'network'
//                    goes through mccontrol-bridge at `address` (W-31d); the token is not kept
//   state()          { status: 'none' | 'connecting' | 'connected' | 'error', kind, name, error, phase }
//                    phase 'reconnecting': a USB companion restarted and its port is being reopened (W-25b)
import { openCompanion } from '../lib/mesh/companion.js';
import { isDemo } from './demo/mode.js';
import { bluetoothAvailable, connectBluetooth } from '../lib/mesh/ble.js';
import { connectSerial, serialAvailable } from '../lib/mesh/serial.js';
import { connectNetwork, networkAvailable } from '../lib/mesh/tcp.js';
import { setBridgeAddress, setCompanionKind } from './screens/settings-store.js';

let radio = null;
let current = { status: 'none', kind: '', name: '', error: '', errorKey: '', phase: '' };
const listeners = new Set();

function set(next) {
  current = Object.freeze({ ...current, ...next });
  for (const fn of listeners) { try { fn(current); } catch { /* a screen gone */ } }
}

export function support(nav = globalThis.navigator) {
  const ua = nav?.userAgent || '';
  // iPadOS reports itself as a Mac; touch points tell it apart
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints || 0) > 1);
  return Object.freeze({ bluetooth: bluetoothAvailable(nav), usb: serialAvailable(nav), network: networkAvailable(), ios,
    secure: globalThis.isSecureContext !== false });
}

export const state = () => current;
export const companion = () => (radio && !radio.closed ? radio : null);

export function onCompanion(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function connect(kind, { address = '', token = '' } = {}) {
  if (isDemo()) throw new Error('A companion radio is not in the demo.');
  if (current.status === 'connecting') return current;
  await disconnect();
  set({ status: 'connecting', kind, name: '', error: '', errorKey: '', phase: '' });
  let link = null;
  let name = '';
  try {
    link = kind === 'bluetooth' ? await connectBluetooth()
      : kind === 'network' ? await connectNetwork(address, { token }) : await connectSerial();
    // A USB companion that restarts drops its port; serial.js reopens it (W-25b). Said here while
    // it does, before app start and after.
    link.onStatus?.((st) => {
      if (st.state === 'reconnecting') set({ status: 'connecting', phase: 'reconnecting' });
      else if (st.state === 'open' && name) set({ status: 'connected', name, phase: '' });
      else if (st.state === 'open') set({ phase: '' });
    });
    const opened = await openCompanion(link);
    radio = opened;
    link.onClose((why) => {
      if (radio !== opened) return;
      radio = null;
      // the bridge said why it closed (the companion went away): said, not a quiet "not connected"
      if (why?.name === 'NetworkError') set({ status: 'error', name: '', error: why.message, errorKey: `companion.net.${why.code}`, phase: '' });
      else set({ status: 'none', name: '', error: '', phase: '' });
    });
    try { setCompanionKind(kind); if (kind === 'network') setBridgeAddress(address.trim()); } catch { /* remembered for this page only */ }
    name = opened.self.name || link.label || '';
    set({ status: 'connected', name, error: '', phase: '' });
  } catch (e) {
    try { await link?.close(); } catch { /* nothing to close */ }
    // the person closed the browser's chooser: not an error worth a sentence
    const cancelled = e?.name === 'NotFoundError' || e?.name === 'AbortError';
    // errorKey: a reason the page says in its own language (the message stays English for a log).
    const errorKey = e?.code === 'otherFirmware' ? 'companion.otherFirmware'
      : e?.name === 'NetworkError' ? `companion.net.${e.code}` : '';
    set({ status: cancelled ? 'none' : 'error', name: '', error: cancelled ? '' : (e?.message || String(e)), errorKey, phase: '' });
  }
  return current;
}

export async function disconnect() {
  const r = radio;
  radio = null;
  if (r) { try { await r.close(); } catch { /* already gone */ } }
  if (current.status !== 'none') set({ status: 'none', name: '', error: '', phase: '' });
}
