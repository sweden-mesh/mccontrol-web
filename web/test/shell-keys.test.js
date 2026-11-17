import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindKey, barKeys, handleKey, matches, onKeysChange } from '../ui/keys.js';
import {
  selected, setSelected, tagged, toggleTag, setTagged, clearTags, onBoardChange,
} from '../ui/board-state.js';
import { setStatusItem, statusItems, onStatusChange, GLYPH } from '../ui/statusline.js';

const key = (k, extra = {}) => {
  const e = { key: k, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false,
    target: { closest: () => null }, ...extra };
  e.preventDefault = () => { e.defaultPrevented = true; };
  return e;
};

test('a key spec matches its key and only the modifiers it names', () => {
  assert.ok(matches(',', key(',')));
  assert.ok(!matches(',', key(',', { ctrlKey: true })));
  assert.ok(matches('ctrl+k', key('k', { ctrlKey: true })));
  assert.ok(matches('ctrl+k', key('K', { metaKey: true })));
  assert.ok(!matches('ctrl+k', key('k')));
  assert.ok(matches('?', key('?', { shiftKey: true })));
});

test('bindings run, the latest wins, the bar lists what asks to be seen', () => {
  const ran = [];
  let changes = 0;
  const off = onKeysChange(() => { changes += 1; });
  const a = bindKey(',', { label: 'Setup', run: () => ran.push('a'), bar: true, order: 80 });
  const b = bindKey('?', { label: 'Help', run: () => ran.push('b'), bar: true, order: 90 });
  const c = bindKey('Enter', { run: () => ran.push('c') });
  assert.deepEqual(barKeys().map((x) => x.label), ['Setup', 'Help']);
  assert.ok(handleKey(key(',')));
  const d = bindKey(',', { label: 'Other', run: () => ran.push('d'), bar: true, order: 10 });
  assert.ok(handleKey(key(',')));
  assert.deepEqual(barKeys().map((x) => x.label), ['Other', 'Help']);
  d();
  assert.ok(handleKey(key('Enter')));
  assert.deepEqual(ran, ['a', 'd', 'c']);
  // Not while typing, not while a modal is open, not twice.
  assert.ok(!handleKey(key(',', { target: { closest: (sel) => (sel.includes('input') ? {} : null) } })));
  assert.ok(!handleKey(key(','), { modalOpen: true }));
  assert.ok(!handleKey(key(',', { defaultPrevented: true })));
  assert.ok(!handleKey(key('x')));
  for (const u of [a, b, c]) u();
  assert.deepEqual(barKeys(), []);
  assert.equal(changes, 8);
  off();
  assert.throws(() => bindKey('x', {}), /run/);
});

test('the board state: one selection, tags in order, told to listeners', () => {
  const seen = [];
  const off = onBoardChange((s) => seen.push(s.what));
  setSelected('4ac61a7f');
  assert.equal(selected(), '4AC61A7F');
  setSelected('4AC61A7F');   // no change, no message
  toggleTag('aa');
  toggleTag('bb');
  toggleTag('aa');
  assert.deepEqual(tagged(), ['BB']);
  setTagged(['cc', 'CC', 'dd']);
  assert.deepEqual(tagged(), ['CC', 'DD']);
  clearTags();
  setSelected(null);
  assert.equal(selected(), null);
  assert.deepEqual(seen, ['selected', 'tagged', 'tagged', 'tagged', 'tagged', 'tagged', 'selected']);
  off();
});

test('the status line keeps its order and its glyphs', () => {
  let n = 0;
  const off = onStatusChange(() => { n += 1; });
  setStatusItem('clock', { word: '14:02' });
  setStatusItem('broker', { word: 'ok', state: 'ok' });
  assert.deepEqual(statusItems().map((i) => i.name), ['broker', 'clock']);
  assert.equal(statusItems()[0].shell, false);
  assert.throws(() => setStatusItem('weather', {}), /no status item/);
  assert.equal(n, 2);
  assert.deepEqual(Object.keys(GLYPH), ['ok', 'warn', 'alert', 'unknown']);
  off();
});
