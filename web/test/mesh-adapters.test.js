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
  // W-25b: the chip resets while RTS is 1 and DTR 0, so the default drops RTS first, then DTR.
  const off = [['signals', { requestToSend: false }], ['signals', { dataTerminalReady: false }]];
  for (const [search, want] of [['', off], ['?x=1', off], ['?usbsignals=bogus', off], ['?usbsignals=dtr0rts0', off],
    ['?usbsignals=dtr0rts0-old', [['signals', { dataTerminalReady: false, requestToSend: false }]]],
    ['?usbsignals=dtr1rts0', [['signals', { requestToSend: false }]]],
    ['?usbsignals=dtr0rts1', [['signals', { dataTerminalReady: false, requestToSend: true }]]],
    ['?usbsignals=dtr1rts1', [['signals', { dataTerminalReady: true, requestToSend: true }]]]]) {
    const { port, calls } = fakePort();
    await openQuiet(port, 115200, search);
    assert.deepEqual(calls, [['open', { baudRate: 115200 }], ...want], search);
  }
  // never DTR 0 with RTS 1 on the way down from the browser's DTR 1 RTS 1
  let lines = { dataTerminalReady: true, requestToSend: true };
  const { port: p2 } = fakePort();
  p2.setSignals = async (s) => { lines = { ...lines, ...s }; assert.ok(!(lines.requestToSend && !lines.dataTerminalReady), 'passed through DTR 0, RTS 1'); };
  await openQuiet(p2, 115200, '');
  assert.deepEqual(lines, { dataTerminalReady: false, requestToSend: false });
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
  assert.deepEqual(Object.keys(USB_SIGNALS), ['dtr0rts0', 'dtr0rts0-old', 'dtr1rts0', 'dtr0rts1', 'dtr1rts1', 'none']);
  // connectSerial applies it too.
  const calls = [];
  const port = { open: async () => calls.push('open'), setSignals: async (s) => calls.push(s),
    writable: { getWriter: () => ({ releaseLock() {} }) },
    readable: { getReader: () => ({ read: () => new Promise(() => {}), releaseLock() {} }) } };
  await connectSerial({ serial: { requestPort: async () => port }, search: '?usbsignals=dtr1rts0' });
  assert.deepEqual(calls, ['open', { requestToSend: false }]);
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
  assert.equal(link.startWithinMs, 20000);
  const began = Date.now();
  const c = await openCompanion(link);
  assert.equal(c.self.name, 'Heltec V4');
  const took = Date.now() - began;
  assert.ok(took >= 1900 && took < 4000, `answered after ${took} ms`);
  const starts = port.written.filter((b) => b[3] === 1).length;
  assert.ok(starts >= 2 && starts <= 3, `${starts} app starts`);   // 0, 1.5 s, then every 2 s once the boot log is heard
  await c.close();
});

// The operator's V4 (capture 2026-11-17): it prints its ROM boot log, then never frames an answer,
// because it runs the Bluetooth companion build (one interface per build). Said as that.
test('USB: a board that prints its boot log but never answers runs another link\'s firmware', async () => {
  const { openCompanion, CompanionError } = await import('../lib/mesh/companion.js');
  const port = bootingPort({ bootMs: 300, answers: false });
  const link = await connectSerial({ serial: { requestPort: async () => port } });
  const began = Date.now();
  await assert.rejects(openCompanion(link, { startWithinMs: 1200, startFirstMs: 400, startEveryMs: 200 }), (e) => {
    assert.ok(e instanceof CompanionError);
    assert.equal(e.code, 'otherFirmware');
    assert.match(e.message, /restarted but doesn't answer over USB\. It probably runs the Bluetooth \(or Wi-Fi\) companion firmware/);
    return true;
  });
  assert.ok(Date.now() - began >= 1150);
  assert.equal(port.written.filter((b) => b[3] === 1).length, 2);   // 0, 400 ms, then quiet: the boot log was heard
  await link.close();
});

test('USB: a board that sends nothing at all keeps the plain reason', async () => {
  const { openCompanion } = await import('../lib/mesh/companion.js');
  const port = bootingPort({ bootMs: 0, answers: false });
  const link = await connectSerial({ serial: { requestPort: async () => port } });
  await assert.rejects(openCompanion(link, { startWithinMs: 600, startFirstMs: 200, startEveryMs: 100 }), (e) => {
    assert.equal(e.code, 'timeout');
    assert.match(e.message, /didn't answer after it restarted: is it running companion firmware for USB\?/);
    return true;
  });
  await link.close();
});

// W-25b: an ESP32-S3 on native USB that restarts leaves the bus and comes back as a new device; the
// opened port dies (its read fails, 'disconnect' fires). Fakes for that: a port whose read can be
// killed, and a navigator.serial whose getPorts() shows what is plugged in now.
const selfFrame = (name) => {
  const text = new TextEncoder().encode(name);
  const body = new Uint8Array([5, 1, 22, 22, ...new Array(32).fill(0xab), ...new Array(22).fill(0), ...text]);
  return new Uint8Array([0x3e, body.length & 0xff, body.length >> 8, ...body]);
};
function deadPort({ answers = true, failOpens = 0, name = 'Heltec V4' } = {}) {
  const listeners = {};
  const port = {
    written: [], opens: 0, closed: false,
    getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    removeEventListener: (type) => { delete listeners[type]; },
    async open() { port.opens += 1; if (failOpens-- > 0) { const e = new Error('Failed to open serial port.'); e.name = 'NetworkError'; throw e; } },
    setSignals: async () => {},
    close: async () => { port.closed = true; },
    writable: { getWriter: () => ({ write: async (b) => {
      if (port.dead) throw new Error('The device has been lost.');
      port.written.push([...b]);
      if (answers && b[3] === 1) setTimeout(() => push(selfFrame(name)), 10);
    }, releaseLock() {} }) },
    readable: { getReader: () => ({
      read: () => (pending.length ? Promise.resolve({ value: pending.shift(), done: false }) : new Promise((r, j) => { feed = r; fail = j; })),
      cancel: async () => feed?.({ done: true }), releaseLock() {},
    }) },
    // The board restarts: the read fails and the port says it is gone.
    restart() {
      port.dead = true;
      const e = new Error('The device has been lost.'); e.name = 'NetworkError';
      fail?.(e); feed = null; fail = null;
      listeners.disconnect?.({ target: port });
    },
  };
  let feed = null;
  let fail = null;
  const pending = [];
  const push = (bytes) => { if (feed) { const f = feed; feed = null; f({ value: bytes, done: false }); } else pending.push(bytes); };
  return port;
}
const fastReopen = { reopenWithinMs: 1500, pollMs: 50, settleMs: 50 };
const fastStart = { startWithinMs: 1500, startFirstMs: 200, startEveryMs: 100 };

test('USB: the board restarts after open, the port comes back as a new one, app start follows it', async () => {
  const { openCompanion } = await import('../lib/mesh/companion.js');
  const { createUsbLog } = await import('../lib/mesh/usblog.js');
  const log = createUsbLog({ enabled: true });
  const first = deadPort({ answers: false });       // restarts before it answers
  const second = deadPort();
  let plugged = [first];
  const serial = { requestPort: async () => first, getPorts: async () => plugged };
  const link = await connectSerial({ serial, log, ...fastReopen });
  const seen = [];
  link.onStatus((s) => seen.push(s.state));
  setTimeout(() => { plugged = []; first.restart(); }, 100);
  setTimeout(() => { plugged = [second]; }, 400);
  const c = await openCompanion(link, fastStart);
  assert.equal(c.self.name, 'Heltec V4');
  assert.deepEqual(seen, ['reconnecting', 'open']);
  assert.equal(first.closed, true, 'the dead port is let go');
  assert.equal(second.opens, 1);
  assert.ok(second.written.some((b) => b[3] === 1), 'app start asked on the new port');
  const text = log.text();
  for (const want of ['chosen', 'open', 'signals', 'out', 'lost', 'NetworkError', 'reopened', ' in ']) assert.ok(text.includes(want), `${want} in the capture`);
  assert.match(text, /3c [0-9a-f]{2} 00 01/);   // app start in hex
  await c.close();
});

test('USB: the same port object comes back; an open that fails while it settles is retried', async () => {
  const { openCompanion } = await import('../lib/mesh/companion.js');
  const port = deadPort();
  let plugged = [port];
  const serial = { requestPort: async () => port, getPorts: async () => plugged };
  const link = await connectSerial({ serial, ...fastReopen });
  const c = await openCompanion(link, fastStart);
  // a restart once connected: the link follows it, the companion stays usable
  plugged = [];
  port.restart();
  assert.equal(link.reconnecting, true);
  await link.write(Uint8Array.of(1));   // dropped, not thrown, while it reconnects
  port.dead = false;
  let failOnce = true;
  const open = port.open;
  port.open = async (o) => { if (failOnce) { failOnce = false; throw new Error('InvalidStateError'); } return open(o); };
  setTimeout(() => { plugged = [port]; }, 200);
  await new Promise((r) => { link.onStatus((s) => { if (s.state === 'open') r(); }); });
  assert.equal(link.reconnecting, false);
  assert.equal(c.closed, false);
  await c.close();
});

test('USB: a board that does not come back fails with the reason, after the wait', async () => {
  const { openCompanion, CompanionError } = await import('../lib/mesh/companion.js');
  const port = deadPort({ answers: false });
  const serial = { requestPort: async () => port, getPorts: async () => [] };
  const link = await connectSerial({ serial, ...fastReopen, reopenWithinMs: 400 });
  let closed = false;
  link.onStatus((s) => { if (s.state === 'gone') closed = true; });
  setTimeout(() => port.restart(), 50);
  const began = Date.now();
  await assert.rejects(openCompanion(link, fastStart), (e) => {
    assert.ok(e instanceof CompanionError);
    assert.equal(e.code, 'closed');
    assert.match(e.message, /restarted and did not come back/);
    return true;
  });
  assert.ok(Date.now() - began >= 400);
  assert.equal(closed, true);
});

test('USB: a board that restarts on every open is followed only a few times', async () => {
  const port = deadPort({ answers: false });
  const serial = { requestPort: async () => port, getPorts: async () => [port] };
  const link = await connectSerial({ serial, ...fastReopen, reopens: 2 });
  let reopened = 0;
  let gone = false;
  link.onStatus((s) => { if (s.state === 'open') { reopened += 1; setTimeout(() => port.restart(), 20); } if (s.state === 'gone') gone = true; });
  port.restart();
  await new Promise((r) => { const t = setInterval(() => { if (gone) { clearInterval(t); r(); } }, 20); });
  assert.equal(reopened, 2);
});

test('USB debug capture: off by default, hex and text, the header, ?usbdebug=1', async () => {
  const { createUsbLog, hexAscii, usbDebugOn } = await import('../lib/mesh/usblog.js');
  assert.equal(hexAscii(Uint8Array.of(0x3e, 0x41, 0x0a)), '3e 41 0a | >A.');
  const off = createUsbLog();
  off.add('open', 'x');
  assert.equal(off.lines.length, 0);
  let t = 1000;
  const on = createUsbLog({ enabled: true, now: () => t });
  on.add('open', 'baudRate 115200');
  t = 1250;
  on.bytes('in', Uint8Array.of(0x3e));
  assert.deepEqual(on.lines, ['      0 ms  open      baudRate 115200', '    250 ms  in        1 B  3e | >']);
  assert.match(on.text(), /^mccontrol USB capture/);
  assert.equal(usbDebugOn('?usbdebug=1'), true);
  assert.equal(usbDebugOn('?usbsignals=none'), false);
});

// The operator's V4 (second capture, 2026-11-17): every app start queued during its 7.4 s boot was
// answered at once, 15 SELF_INFO in a row. The first is the answer; the rest must not be taken as
// the answer to the next command.
test('USB: duplicate SELF_INFO after the first are dropped, the next command gets its own answer', async () => {
  const { openCompanion } = await import('../lib/mesh/companion.js');
  let frameFn = () => {};
  const writes = [];
  const link = {
    kind: 'usb', label: 'USB', heardBytes: 100,
    onFrame(fn) { frameFn = fn; }, onClose() {},
    async write(b) {
      writes.push([...b]);
      if (writes.length === 3) {        // the board is up: all three queued app starts answered at once
        const body = selfFrame('SE-JKG-LouMob3').slice(3);
        setTimeout(() => { frameFn(body); frameFn(body); frameFn(body); }, 5);
        setTimeout(() => { frameFn(body); }, 30);   // a straggler, after app start resolved
      }
      if (b[0] === 0x1e) setTimeout(() => frameFn(Uint8Array.of(0x01, 0x02)), 60);   // ERR NOT_FOUND to the lookup
    },
    async close() {},
  };
  const c = await openCompanion(link, { startWithinMs: 9000, startFirstMs: 20, startEveryMs: 20, startBootingEveryMs: 20 });
  assert.equal(c.self.name, 'SE-JKG-LouMob3');
  assert.equal(await c.contact('AB'.repeat(32)), null);    // not a SELF_INFO taken as its answer
});
