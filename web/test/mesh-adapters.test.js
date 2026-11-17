// The Bluetooth and USB adapters against stand-ins for navigator.bluetooth and navigator.serial:
// the service and characteristics asked for, a write is one frame (framed on USB), a
// notification or a read is a frame, a disconnect closes. No radio is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bluetoothAvailable, connectBluetooth } from '../lib/mesh/ble.js';
import { connectSerial, serialAvailable, usbSignals, openQuiet, USB_SIGNALS } from '../lib/mesh/serial.js';
import { NUS } from '../lib/mesh/frames.js';

test('Bluetooth: the Nordic UART service, writes with response, notifications are frames', async () => {
  const writes = [];
  const asked = [];
  const listeners = {};
  const tx = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    startNotifications: async () => { asked.push('notify'); },
  };
  const rx = { writeValueWithResponse: async (b) => { writes.push([...b]); } };
  const device = {
    name: 'MeshCore-Lou', gatt: {
      connected: true,
      connect: async () => ({ getPrimaryService: async (uuid) => { asked.push(uuid); return { getCharacteristic: async (u) => (u === NUS.rx ? rx : tx) }; } }),
      disconnect() { this.connected = false; listeners.gone?.(); },
    },
    addEventListener: (type, fn) => { listeners.gone = fn; },
  };
  let filters = null;
  const link = await connectBluetooth({ bluetooth: { requestDevice: async (o) => { filters = o; return device; } } });
  assert.deepEqual(filters.optionalServices, [NUS.service]);
  assert.equal(link.label, 'MeshCore-Lou');
  assert.deepEqual(asked, [NUS.service, 'notify']);
  const got = [];
  link.onFrame((f) => got.push([...f]));
  let closed = false;
  link.onClose(() => { closed = true; });
  await link.write(Uint8Array.of(1, 2));
  assert.deepEqual(writes, [[1, 2]]);
  const buf = new Uint8Array([9, 5, 6, 7]).buffer;
  listeners.characteristicvaluechanged({ target: { value: new DataView(buf, 1, 2) } });
  assert.deepEqual(got, [[5, 6]]);
  await link.close();
  assert.equal(closed, true);
  assert.equal(bluetoothAvailable({}), false);
});

test('USB: opened at 115200, writes framed, reads deframed, unplugging closes', async () => {
  const written = [];
  let feed;
  const chunks = [];
  const port = {
    opened: null,
    open: async (o) => { port.opened = o; },
    close: async () => {},
    writable: { getWriter: () => ({ write: async (b) => { written.push([...b]); }, releaseLock() {} }) },
    readable: { getReader: () => ({
      read: () => (chunks.length ? Promise.resolve(chunks.shift()) : new Promise((r) => { feed = r; })),
      cancel: async () => feed?.({ done: true }), releaseLock() {},
    }) },
  };
  const link = await connectSerial({ serial: { requestPort: async () => port } });
  assert.deepEqual(port.opened, { baudRate: 115200 });
  const got = [];
  let closed = false;
  link.onFrame((f) => got.push([...f]));
  link.onClose(() => { closed = true; });
  await link.write(Uint8Array.of(1, 3));
  assert.deepEqual(written, [[0x3c, 2, 0, 1, 3]]);
  feed({ value: Uint8Array.of(0x3e, 1, 0, 5), done: false });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(got, [[5]]);
  feed({ done: true });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(closed, true);
  assert.equal(serialAvailable({}), false);
});

// W-21: Chrome opens with DTR and RTS asserted, which reset an ESP32-S3 on native USB into a boot
// loop. Both are dropped right after open; ?usbsignals= picks another combination on the bench.
test('USB: DTR and RTS dropped right after open, a bench override from the address', async () => {
  const fakePort = (withSignals = true) => {
    const calls = [];
    const port = { open: async (o) => calls.push(['open', o]) };
    if (withSignals) port.setSignals = async (s) => calls.push(['signals', s]);
    return { port, calls };
  };
  const off = { dataTerminalReady: false, requestToSend: false };
  for (const [search, want] of [['', off], ['?x=1', off], ['?usbsignals=bogus', off], ['?usbsignals=dtr0rts0', off],
    ['?usbsignals=dtr1rts0', { dataTerminalReady: true, requestToSend: false }],
    ['?usbsignals=dtr0rts1', { dataTerminalReady: false, requestToSend: true }],
    ['?usbsignals=dtr1rts1', { dataTerminalReady: true, requestToSend: true }]]) {
    const { port, calls } = fakePort();
    await openQuiet(port, 115200, search);
    assert.deepEqual(calls, [['open', { baudRate: 115200 }], ['signals', want]], search);
  }
  // 'none' keeps the browser's defaults; a browser without setSignals or a refusing port still opens.
  let f = fakePort();
  await openQuiet(f.port, 115200, '?usbsignals=none');
  assert.deepEqual(f.calls, [['open', { baudRate: 115200 }]]);
  f = fakePort(false);
  await openQuiet(f.port, 115200, '');
  assert.deepEqual(f.calls, [['open', { baudRate: 115200 }]]);
  f = fakePort();
  f.port.setSignals = async () => { throw new Error('refused'); };
  await openQuiet(f.port, 115200, '');
  assert.equal(usbSignals('?usbsignals=none').signals, null);
  assert.deepEqual(Object.keys(USB_SIGNALS), ['dtr0rts0', 'dtr1rts0', 'dtr0rts1', 'dtr1rts1', 'none']);
  // connectSerial applies it too.
  const calls = [];
  const port = { open: async () => calls.push('open'), setSignals: async (s) => calls.push(s),
    writable: { getWriter: () => ({ releaseLock() {} }) },
    readable: { getReader: () => ({ read: () => new Promise(() => {}), releaseLock() {} }) } };
  await connectSerial({ serial: { requestPort: async () => port }, search: '?usbsignals=dtr1rts0' });
  assert.deepEqual(calls, ['open', { dataTerminalReady: true, requestToSend: false }]);
});

// Beta.4: opening the port restarted a Heltec V4 once, and app start went unanswered while it
// booted. A fake port that prints a boot log for 2 s (text with '>' in it, split across chunks)
// and only then answers: app start is asked again until it does, and the log is never a frame.
function bootingPort({ bootMs = 2000, answers = true } = {}) {
  const opened = Date.now();
  const written = [];
  const pending = [];
  let feed = null;
  const push = (bytes) => { if (feed) { const f = feed; feed = null; f({ value: bytes, done: false }); } else pending.push(bytes); };
  const text = (s) => new TextEncoder().encode(s);
  const log = setInterval(() => push(text('ESP-ROM:esp32s3-20210327\r\nrst:0x15 (USB_UART_CHIP_RESET) -> boot:0x2b\r\nI (42) boot: > loading app\r\n')), 150);
  setTimeout(() => clearInterval(log), bootMs);
  const self = (name) => {
    const body = new Uint8Array([5, 1, 22, 22, ...new Array(32).fill(0xab), ...new Array(22).fill(0), ...text(name)]);
    return new Uint8Array([0x3e, body.length & 0xff, body.length >> 8, ...body]);
  };
  const port = {
    written,
    open: async () => {},
    setSignals: async () => {},
    close: async () => { clearInterval(log); },
    writable: { getWriter: () => ({ write: async (b) => {
      written.push([...b]);
      if (answers && b[3] === 1 && Date.now() - opened >= bootMs) {
        const f = self('Heltec V4');
        setTimeout(() => { push(f.slice(0, 5)); push(f.slice(5)); }, 20);
      }
    }, releaseLock() {} }) },
    readable: { getReader: () => ({
      read: () => (pending.length ? Promise.resolve({ value: pending.shift(), done: false }) : new Promise((r) => { feed = r; })),
      cancel: async () => { clearInterval(log); feed?.({ done: true }); }, releaseLock() {},
    }) },
  };
  return port;
}

test('USB: a board that restarted on open boots for 2 s, app start is asked again until it answers', async () => {
  const { openCompanion } = await import('../lib/mesh/companion.js');
  const port = bootingPort();
  const link = await connectSerial({ serial: { requestPort: async () => port } });
  assert.equal(link.startWithinMs, 8000);
  const began = Date.now();
  const c = await openCompanion(link);
  assert.equal(c.self.name, 'Heltec V4');
  const took = Date.now() - began;
  assert.ok(took >= 1900 && took < 4000, `answered after ${took} ms`);
  const starts = port.written.filter((b) => b[3] === 1).length;
  assert.ok(starts >= 2 && starts <= 6, `${starts} app starts`);   // 0, 1.5 s, then every 0.5 s
  await c.close();
});

test('USB: a board that never answers is reported after the wait, with the reason', async () => {
  const { openCompanion, CompanionError } = await import('../lib/mesh/companion.js');
  const port = bootingPort({ bootMs: 300, answers: false });
  const link = await connectSerial({ serial: { requestPort: async () => port } });
  const began = Date.now();
  await assert.rejects(openCompanion(link, { startWithinMs: 1200, startFirstMs: 400, startEveryMs: 200 }), (e) => {
    assert.ok(e instanceof CompanionError);
    assert.equal(e.code, 'timeout');
    assert.match(e.message, /didn't answer after it restarted: is it running companion firmware for USB\?/);
    return true;
  });
  assert.ok(Date.now() - began >= 1150);
  assert.equal(port.written.filter((b) => b[3] === 1).length, 5);   // 0, 400, 600, 800, 1000 ms
  await link.close();
});
