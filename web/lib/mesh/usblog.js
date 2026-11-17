// The USB debug capture (W-25b): with ?usbdebug=1 in the address, everything the USB link does is
// recorded (open, signals, every byte in and out as hex and text, disconnect and connect, the
// reopen attempts), with the time since the capture began, so the owner can copy it and send it.
// Off by default: then add() and bytes() do nothing. No DOM here (ui/usb-debug.js draws it).
//
//   usbLog.enabled                  true when the address asked for it
//   usbLog.add(kind, text)          one line: "   812 ms  open      baudRate 115200"
//   usbLog.bytes(dir, u8)           'in' | 'out': the bytes as hex, then as text
//   usbLog.text()                   the whole capture, for "Copy"
//   usbLog.onChange(fn)             fn() after each line; returns unsubscribe

export function usbDebugOn(search = globalThis.location?.search || '') {
  try { return ['1', 'on', 'true'].includes(new URLSearchParams(search).get('usbdebug')); } catch { return false; }
}

// "3c 03 00 01 | <...": printable ASCII as itself, everything else as a dot.
export function hexAscii(u8) {
  const b = [...u8];
  return `${b.map((x) => x.toString(16).padStart(2, '0')).join(' ')} | ${b.map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('')}`;
}

export function createUsbLog({ enabled = false, now = () => Date.now(), max = 5000 } = {}) {
  const lines = [];
  const listeners = new Set();
  let began = null;
  const log = {
    enabled,
    lines,
    add(kind, text = '') {
      if (!log.enabled) return;
      const t = now();
      if (began === null) began = t;
      lines.push(`${String(Math.round(t - began)).padStart(7)} ms  ${kind.padEnd(10)}${text}`);
      if (lines.length > max) lines.splice(0, lines.length - max);
      for (const fn of listeners) { try { fn(); } catch { /* a panel gone */ } }
    },
    bytes(dir, u8) {
      if (log.enabled) log.add(dir === 'in' ? 'in' : 'out', `${u8.length} B  ${hexAscii(u8)}`);
    },
    text() {
      const head = [`mccontrol USB capture, ${new Date().toISOString()}`,
        `browser: ${globalThis.navigator?.userAgent || '?'}`, `address: ${globalThis.location?.search || ''}`, ''];
      return head.concat(lines).join('\n');
    },
    clear() { lines.length = 0; began = null; for (const fn of listeners) fn(); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  return log;
}

export const usbLog = createUsbLog({ enabled: usbDebugOn() });
