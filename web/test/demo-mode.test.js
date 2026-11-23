// Demo mode's switch and isolation (W-39a): what turns it on, and that a demo page's storage and
// socket reach nothing real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoAsked, demoAddress, demoStorage, installDemo, isDemo, NoSocket, SHARED_KEYS } from '../ui/demo/mode.js';
import { CHOICES, RETIRED } from '../ui/prefs.js';

test('only ?demo=1 turns the demo on, and a test run is never one', () => {
  assert.equal(demoAsked('?demo=1'), true);
  assert.equal(demoAsked('?x=2&demo=1'), true);
  for (const s of ['', '?demo', '?demo=0', '?demo=true', '?demos=1', undefined]) assert.equal(demoAsked(s), false, String(s));
  assert.equal(isDemo(), false);
});

test('the way in and the way out are addresses of the same page, hash dropped', () => {
  assert.equal(demoAddress(true, 'https://x.test/?a=1#node/AB'), '/?a=1&demo=1');
  assert.equal(demoAddress(false, 'https://x.test/app/?demo=1&a=1#setup/key'), '/app/?a=1');
  assert.equal(demoAddress(false, 'https://x.test/?demo=1'), '/');
});

const fakeReal = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };

test('the demo storage keeps everything but the display settings to itself', () => {
  const real = fakeReal();
  real.setItem('mccontrol.brokers', '{"JKG":"real.example"}');
  real.setItem('mccontrol.theme', 'green');
  const s = demoStorage(real);
  assert.equal(s.getItem('mccontrol.brokers'), null, 'the real page\'s settings are not read');
  assert.equal(s.getItem('mccontrol.theme'), 'green', 'the display settings are');
  s.setItem('mccontrol.brokers', 'demo');
  s.setItem('mccontrol.bridge', 'ws://demo');
  s.setItem('mccontrol.layout', 'retro');
  assert.equal(s.getItem('mccontrol.brokers'), 'demo');
  assert.equal(real.m.get('mccontrol.brokers'), '{"JKG":"real.example"}', 'and nothing of the demo\'s is written through');
  assert.equal(real.m.has('mccontrol.bridge'), false);
  assert.equal(real.m.get('mccontrol.layout'), 'retro');
  s.removeItem('mccontrol.brokers');
  assert.equal(s.getItem('mccontrol.brokers'), null);
  assert.equal(real.m.has('mccontrol.brokers'), true);
});

test('the shared keys are exactly the display settings of ui/prefs.js', () => {
  assert.deepEqual([...SHARED_KEYS].sort(), [...Object.keys(CHOICES), ...RETIRED].map((n) => `mccontrol.${n}`).sort());
});

test('a storage that throws is tolerated', () => {
  const s = demoStorage({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } });
  assert.equal(s.getItem('mccontrol.theme'), null);
  s.setItem('mccontrol.theme', 'dark');
  s.removeItem('mccontrol.theme');
});

test('installDemo replaces the page\'s storage and socket', () => {
  const real = fakeReal();
  const scope = { localStorage: real, WebSocket: class Real {} };
  installDemo({ scope });
  assert.equal(scope.WebSocket, NoSocket);
  scope.localStorage.setItem('mccontrol.companion', 'usb');
  assert.equal(real.m.size, 0);
});

test('the stand-in socket never opens and reports a closed connection', async () => {
  const s = new NoSocket('wss://anything.example', ['mqtt']);
  assert.equal(s.readyState, 3);
  const code = await new Promise((ok) => { s.onclose = (ev) => ok(ev.code); });
  assert.equal(code, 1006);
  s.send(new Uint8Array(2));
  s.close();
});
