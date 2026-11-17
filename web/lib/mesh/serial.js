// The companion over USB (Web Serial): the companion's framed serial protocol, '<' len payload
// out and '>' len payload in (frames.js). Thin on purpose, like ble.js.
//
//   const link = await connectSerial()             // must run in a click: the browser asks
import { SERIAL_BAUD, serialDeframer, serialFrame } from './frames.js';

export const serialAvailable = (nav = globalThis.navigator) => Boolean(nav?.serial?.requestPort);

// DTR and RTS after open (W-21). Chrome opens a port with both asserted; on an ESP32-S3's native
// USB (USB-Serial/JTAG, e.g. the Heltec V4) those are esptool's reset and boot lines, and the
// board boot-loops until its reset button is pressed. Both are dropped right after open. A bench
// override in the address, ?usbsignals=dtr0rts0|dtr1rts0|dtr0rts1|dtr1rts1|none, tries the other
// combinations ('none' leaves the browser's defaults). Chrome still toggles the lines inside
// open(), before they can be dropped, so the board may restart once (bench 2026-11-17): app start
// is asked again until it has booted (USB_START_WITHIN_MS, companion.js).
export const USB_SIGNALS = Object.freeze({
  dtr0rts0: { dataTerminalReady: false, requestToSend: false },
  dtr1rts0: { dataTerminalReady: true, requestToSend: false },
  dtr0rts1: { dataTerminalReady: false, requestToSend: true },
  dtr1rts1: { dataTerminalReady: true, requestToSend: true },
  none: null,
});
export const DEFAULT_USB_SIGNALS = 'dtr0rts0';

// How long app start keeps asking after the port opens: a board that restarted boots in 1 to 3 s.
export const USB_START_WITHIN_MS = 8000;

// The signals to set for an address's query string: the default when absent or unknown.
export function usbSignals(search = globalThis.location?.search || '') {
  let choice = null;
  try { choice = new URLSearchParams(search).get('usbsignals'); } catch { /* not a query */ }
  const name = Object.hasOwn(USB_SIGNALS, choice || '') ? choice : DEFAULT_USB_SIGNALS;
  return { name, signals: USB_SIGNALS[name] };
}

// Open `port` and set the chosen signals at once. A browser without setSignals keeps its defaults.
export async function openQuiet(port, baudRate, search) {
  await port.open({ baudRate });
  const { signals } = usbSignals(search);
  if (signals && typeof port.setSignals === 'function') {
    try { await port.setSignals(signals); } catch { /* the port refused: keep going with its defaults */ }
  }
}

export async function connectSerial({ serial = globalThis.navigator?.serial, baudRate = SERIAL_BAUD, search } = {}) {
  if (!serial?.requestPort) throw new Error('this browser has no Web Serial');
  const port = await serial.requestPort();
  await openQuiet(port, baudRate, search);
  const writer = port.writable.getWriter();
  const reader = port.readable.getReader();
  const deframer = serialDeframer();
  let frameFn = () => {};
  let closeFn = () => {};
  let closed = false;
  const finish = () => { if (!closed) { closed = true; closeFn(); } };
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const f of deframer.push(value)) frameFn(f);
      }
    } catch { /* unplugged */ }
    finish();
  })();
  const info = port.getInfo?.() || {};
  return {
    kind: 'usb',
    // Opening may have restarted the board (Chrome toggles DTR and RTS inside open()): app start
    // is asked again until it has booted, the boot log in between skipped by the deframer.
    startWithinMs: USB_START_WITHIN_MS,
    label: info.usbProductId ? `USB ${info.usbVendorId?.toString(16)}:${info.usbProductId.toString(16)}` : 'USB',
    onFrame(fn) { frameFn = fn; },
    onClose(fn) { closeFn = fn; },
    write: (bytes) => writer.write(serialFrame(bytes)),
    async close() {
      try { await reader.cancel(); } catch { /* already gone */ }
      reader.releaseLock();
      writer.releaseLock();
      try { await port.close(); } catch { /* already closed */ }
      finish();
    },
  };
}
