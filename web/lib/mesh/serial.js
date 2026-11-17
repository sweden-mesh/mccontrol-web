// The companion over USB (Web Serial): the companion's framed serial protocol, '<' len payload
// out and '>' len payload in (frames.js). Thin on purpose, like ble.js.
//
//   const link = await connectSerial()             // must run in a click: the browser asks
import { SERIAL_BAUD, serialDeframer, serialFrame } from './frames.js';

export const serialAvailable = (nav = globalThis.navigator) => Boolean(nav?.serial?.requestPort);

export async function connectSerial({ serial = globalThis.navigator?.serial, baudRate = SERIAL_BAUD } = {}) {
  if (!serial?.requestPort) throw new Error('this browser has no Web Serial');
  const port = await serial.requestPort();
  await port.open({ baudRate });
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
