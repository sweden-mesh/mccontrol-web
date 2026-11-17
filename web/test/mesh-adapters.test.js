// The Bluetooth and USB adapters against stand-ins for navigator.bluetooth and navigator.serial:
// the service and characteristics asked for, a write is one frame (framed on USB), a
// notification or a read is a frame, a disconnect closes. No radio is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bluetoothAvailable, connectBluetooth } from '../lib/mesh/ble.js';
import { connectSerial, serialAvailable } from '../lib/mesh/serial.js';
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
