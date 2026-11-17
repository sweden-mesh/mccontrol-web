// The companion over Bluetooth (Web Bluetooth): the Nordic UART service MeshCore companions
// expose. One write or notification is one frame (frames.js). Thin on purpose: everything
// that can be tested without a radio is in frames.js and companion.js.
//
//   const link = await connectBluetooth()          // must run in a click: the browser asks
//   const companion = await openCompanion(link)
import { NUS } from './frames.js';

export const bluetoothAvailable = (nav = globalThis.navigator) => Boolean(nav?.bluetooth?.requestDevice);

export async function connectBluetooth({ bluetooth = globalThis.navigator?.bluetooth } = {}) {
  if (!bluetooth?.requestDevice) throw new Error('this browser has no Web Bluetooth');
  // A companion advertises its name ("MeshCore-...") and not always the service, so either.
  const device = await bluetooth.requestDevice({
    filters: [{ services: [NUS.service] }, { namePrefix: 'MeshCore' }], optionalServices: [NUS.service],
  });
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(NUS.service);
  const rx = await service.getCharacteristic(NUS.rx);
  const tx = await service.getCharacteristic(NUS.tx);
  let frameFn = () => {};
  let closeFn = () => {};
  tx.addEventListener('characteristicvaluechanged', (e) => {
    const v = e.target.value;
    frameFn(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
  });
  device.addEventListener('gattserverdisconnected', () => closeFn(), { once: true });
  await tx.startNotifications();
  return {
    kind: 'bluetooth',
    label: device.name || 'Bluetooth',
    onFrame(fn) { frameFn = fn; },
    onClose(fn) { closeFn = fn; },
    write: (bytes) => rx.writeValueWithResponse(bytes),
    async close() { if (device.gatt.connected) device.gatt.disconnect(); },
  };
}
