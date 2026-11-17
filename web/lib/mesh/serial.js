// The companion over USB (Web Serial): the companion's framed serial protocol, '<' len payload
// out and '>' len payload in (frames.js). Thin on purpose, like ble.js.
//
//   const link = await connectSerial()             // must run in a click: the browser asks
//   link.onStatus(fn)                              // fn({ state: 'reconnecting' | 'open' | 'gone' })
import { SERIAL_BAUD, serialDeframer, serialFrame } from './frames.js';
import { usbLog } from './usblog.js';

export const serialAvailable = (nav = globalThis.navigator) => Boolean(nav?.serial?.requestPort);

// DTR and RTS after open (W-21). Chrome opens a port with both asserted; on an ESP32-S3's native
// USB (USB-Serial/JTAG, e.g. the Heltec V4) those are esptool's reset and boot lines: the chip
// resets while RTS is 1 and DTR is 0 (W-25b, the operator's capture). Dropping DTR first passes
// through exactly that state, so RTS is dropped first and DTR after, in two steps. Each name below
// is a list of setSignals steps. A bench override in the address,
// ?usbsignals=dtr0rts0|dtr0rts0-old|dtr1rts0|dtr0rts1|dtr1rts1|none, tries the others
// ('dtr0rts0-old': both in one call, beta.3 to beta.6; 'none' leaves the browser's defaults, which
// is what meshcore.js, the official web clients' library, does: open at 115200 and nothing else).
export const USB_SIGNALS = Object.freeze({
  dtr0rts0: [{ requestToSend: false }, { dataTerminalReady: false }],
  'dtr0rts0-old': [{ dataTerminalReady: false, requestToSend: false }],
  dtr1rts0: [{ requestToSend: false }],
  dtr0rts1: [{ dataTerminalReady: false, requestToSend: true }],
  dtr1rts1: [{ dataTerminalReady: true, requestToSend: true }],
  none: null,
});
export const DEFAULT_USB_SIGNALS = 'dtr0rts0';

// How long app start keeps asking after the port opens (or reopens): the operator's V4 answered
// 7.4 s after the reset that opening caused (W-25b), so 20 s.
export const USB_START_WITHIN_MS = 20000;
// W-25b: an ESP32-S3 on native USB that restarts leaves the USB bus and comes back as a new
// device, so the opened port dies under us. How long to wait for it to come back, how often to
// look, how long to let it settle before opening, and how many restarts to follow in one session
// (a board that restarts on every open would otherwise be chased for ever).
export const USB_REOPEN_WITHIN_MS = 15000;
export const USB_REOPEN_POLL_MS = 250;
export const USB_REOPEN_SETTLE_MS = 300;
export const USB_REOPENS = 3;

// The signals to set for an address's query string: the default when absent or unknown.
export function usbSignals(search = globalThis.location?.search || '') {
  let choice = null;
  try { choice = new URLSearchParams(search).get('usbsignals'); } catch { /* not a query */ }
  const name = Object.hasOwn(USB_SIGNALS, choice || '') ? choice : DEFAULT_USB_SIGNALS;
  return { name, signals: USB_SIGNALS[name] };
}

// Open `port` and set the chosen signals, step by step, at once. A browser without setSignals keeps its defaults.
export async function openQuiet(port, baudRate, search, log = usbLog) {
  log.add('open', `baudRate ${baudRate}`);
  await port.open({ baudRate });
  const { name, signals } = usbSignals(search);
  if (signals && typeof port.setSignals === 'function') {
    for (const step of signals) {
      const words = Object.entries(step).map(([k, v]) => `${k === 'dataTerminalReady' ? 'DTR' : 'RTS'} ${v ? 1 : 0}`).join(', ');
      try {
        await port.setSignals(step);
        log.add('signals', `${name}: ${words}`);
      } catch (e) { log.add('signals', `${name}: ${words} refused: ${e?.message || e}`); break; }
    }
  } else {
    log.add('signals', signals ? 'this browser cannot set them' : 'none: left as the browser opened them');
  }
}

const same = (a, b) => a.usbVendorId === b.usbVendorId && a.usbProductId === b.usbProductId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function connectSerial({
  serial = globalThis.navigator?.serial, baudRate = SERIAL_BAUD, search, log = usbLog,
  reopenWithinMs = USB_REOPEN_WITHIN_MS, pollMs = USB_REOPEN_POLL_MS, settleMs = USB_REOPEN_SETTLE_MS, reopens = USB_REOPENS,
} = {}) {
  if (!serial?.requestPort) throw new Error('this browser has no Web Serial');
  const first = await serial.requestPort();
  const info = first.getInfo?.() || {};
  log.add('chosen', info.usbVendorId ? `USB ${info.usbVendorId.toString(16)}:${info.usbProductId?.toString(16)}` : 'a port without USB ids');
  let port = null;
  let reader = null;
  let writer = null;
  let state = 'opening';          // 'open' | 'lost' (reconnecting) | 'closed'
  let opened = 0;                 // how many times the port was opened; a read loop belongs to one
  let followed = 0;               // restarts followed so far
  let heard = 0;                  // bytes read since the port was last opened (a boot log counts)
  const deframer = serialDeframer();
  let frameFn = () => {};
  let closeFn = () => {};
  const statusFns = new Set();
  const status = (s) => { for (const fn of statusFns) { try { fn(s); } catch { /* a listener gone */ } } };
  const finish = () => { if (state !== 'closed') { state = 'closed'; status({ state: 'gone' }); closeFn(); } };

  const onDisconnect = () => lost('the port went away (disconnect)');
  const onConnect = (e) => log.add('connect', `a port appeared ${portIds(e?.target || e?.port)}`);
  serial.addEventListener?.('connect', onConnect);

  async function attach(p) {
    await openQuiet(p, baudRate, search, log);
    port = p;
    opened += 1;
    heard = 0;
    p.addEventListener?.('disconnect', onDisconnect);
    writer = p.writable.getWriter();
    reader = p.readable.getReader();
    state = 'open';
    readLoop(reader, opened);
  }

  async function readLoop(r, mine) {
    let why = 'the read ended';
    try {
      for (;;) {
        const { value, done } = await r.read();
        if (done) break;
        log.bytes('in', value);
        heard += value.length;
        for (const f of deframer.push(value)) frameFn(f);
      }
    } catch (e) { why = `the read failed: ${e?.name || ''} ${e?.message || e}`.trim(); }
    if (mine !== opened) return;
    log.add('read', why);
    lost(why);
  }

  // The port died under us: let go of it, then wait for the same device to come back.
  function lost(why) {
    if (state !== 'open') return;
    state = 'lost';
    log.add('lost', why);
    const [r, w, p] = [reader, writer, port];
    p?.removeEventListener?.('disconnect', onDisconnect);
    (async () => {
      try { await r?.cancel(); } catch { /* already gone */ }
      try { r?.releaseLock(); } catch { /* already released */ }
      try { w?.releaseLock(); } catch { /* already released */ }
      try { await p?.close(); } catch { /* already closed */ }
    })();
    if (typeof serial.getPorts !== 'function') { log.add('give up', 'this browser cannot find the port again'); finish(); return; }
    if (followed >= reopens) { log.add('give up', `followed ${followed} restarts already`); finish(); return; }
    followed += 1;
    status({ state: 'reconnecting', attempt: followed });
    reopen(p);
  }

  // Ports this page may open again without a new click (getPorts), the one we had first.
  async function candidates(old) {
    let ports = [];
    try { ports = await serial.getPorts?.() || []; } catch { return []; }
    const want = old?.getInfo?.() || info;
    const match = ports.filter((p) => same(p.getInfo?.() || {}, want));
    return match.sort((a, b) => (b === old) - (a === old));
  }

  async function reopen(old) {
    const until = Date.now() + reopenWithinMs;
    let tries = 0;
    let looked = false;
    while (Date.now() < until && state === 'lost') {
      await sleep(looked ? pollMs : settleMs);
      looked = true;
      if (state !== 'lost') return;
      for (const p of await candidates(old)) {
        tries += 1;
        try {
          await attach(p);
          log.add('reopened', `after ${tries} ${tries === 1 ? 'try' : 'tries'} ${portIds(p)}`);
          status({ state: 'open' });
          return;
        } catch (e) {
          log.add('retry', `open failed: ${e?.name || ''} ${e?.message || e}`.trim());
        }
      }
    }
    if (state === 'lost') { log.add('give up', `the device did not come back in ${Math.round(reopenWithinMs / 1000)} s`); finish(); }
  }

  await attach(first);
  return {
    kind: 'usb',
    // Opening may have restarted the board (Chrome toggles DTR and RTS inside open()): app start
    // is asked again until it has booted, the boot log in between skipped by the deframer.
    startWithinMs: USB_START_WITHIN_MS,
    label: info.usbProductId ? `USB ${info.usbVendorId?.toString(16)}:${info.usbProductId.toString(16)}` : 'USB',
    get reconnecting() { return state === 'lost'; },
    // Bytes came in but no frame: the board talks (its boot log) but not the companion protocol.
    get heardBytes() { return heard; },
    onFrame(fn) { frameFn = fn; },
    onClose(fn) { closeFn = fn; },
    onStatus(fn) { statusFns.add(fn); return () => statusFns.delete(fn); },
    // While the port is being reopened a write goes nowhere (app start is asked again after).
    async write(bytes) {
      const frame = serialFrame(bytes);
      if (state === 'closed') throw new Error('the companion is not connected');
      if (state !== 'open') { log.add('dropped', `${frame.length} B written while reconnecting`); return; }
      log.bytes('out', frame);
      try { await writer.write(frame); } catch (e) {
        log.add('write', `failed: ${e?.name || ''} ${e?.message || e}`.trim());
        lost('a write failed');
      }
    },
    async close() {
      if (state === 'closed') return;
      const was = state;
      state = 'closing';
      log.add('close', 'by the page');
      serial.removeEventListener?.('connect', onConnect);
      port?.removeEventListener?.('disconnect', onDisconnect);
      if (was === 'open') {
        try { await reader.cancel(); } catch { /* already gone */ }
        try { reader.releaseLock(); } catch { /* already released */ }
        try { writer.releaseLock(); } catch { /* already released */ }
        try { await port.close(); } catch { /* already closed */ }
      }
      finish();
    },
  };
}

function portIds(p) {
  const i = p?.getInfo?.() || {};
  return i.usbVendorId ? `(USB ${i.usbVendorId.toString(16)}:${i.usbProductId?.toString(16)})` : '';
}
