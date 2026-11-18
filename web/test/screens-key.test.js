// The logic of the unlock, key, set-up, settings and help screens, and the key session that
// gives the page one keyring: no DOM, the browser's storage replaced by fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importKind, passProblem, stepFor, unlockTarget } from '../ui/screens/unlock.js';
import { asksReboot, consoleBytes, consoleLog, setupLines, showsKey, serialAvailable, BAUD } from '../ui/screens/setup.js';
import { autoLockText, revealer, REVEAL_MS } from '../ui/screens/key.js';
import { helpRuns, resultRows } from '../ui/screens/help.js';
import {
  brokerConfig, lowBatteryVolts, notHeardHours, regionBrokers, removeRegionBroker, setLowBatteryVolts,
  setNotHeardHours, setRegionBroker, validHost,
} from '../ui/screens/settings-store.js';
import {
  currentHandle, holdKey, keyStatus, onKeyStatus, shellState, startKeySession, unlockHash,
} from '../ui/screens/key-session.js';
import { keyState } from '../ui/key-state.js';
import { memoryStorage } from '../lib/key/storage.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const brokers = json('../lib/data/brokers.json');
const results = json('../lib/data/results.json');
const help = json('../lib/data/help.json');
const KEY = '736EA54AAE6E1C7652E247B8997DC9B99946F4B41DF64DC0BA6DF148D9029CE4';

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

test('unlock: where the address leads, and which step a status calls for', () => {
  assert.deepEqual(unlockTarget([]), { replace: false, next: null });
  assert.deepEqual(unlockTarget(['replace']), { replace: true, next: '#/key' });
  assert.deepEqual(unlockTarget(['to', 'node', '4AC61A7F']), { replace: false, next: '#/node/4AC61A7F' });
  assert.deepEqual(unlockTarget(['to', 'groups', 'my group']), { replace: false, next: '#/groups/my%20group' });
  assert.deepEqual(unlockTarget(['to', 'unlock']), { replace: false, next: '#/' }, 'never back to itself');
  const s = (o) => ({ exists: true, locked: false, backup: null, ...o });
  assert.equal(stepFor({ exists: false }), 'start');
  assert.equal(stepFor(s({ locked: true })), 'unlock');
  assert.equal(stepFor(s()), 'done', 'no backup step: keeping a copy is the owner\'s job');
  assert.equal(stepFor(s({ source: 'imported' })), 'done', 'no "is it saved?" step');
  assert.equal(stepFor(s(), { replace: true }), 'start');
});

test('unlock: passphrases and what an import holds', () => {
  assert.equal(passProblem('short'), 'short');
  assert.equal(passProblem('åäöåäöåä'), null, 'eight characters, not bytes');
  assert.equal(passProblem('long enough', 'long enougH'), 'mismatch');
  assert.equal(passProblem('long enough', 'long enough'), null);
  assert.equal(importKind(` ${'ab'.repeat(32)}\n`), 'seed');
  assert.equal(importKind('ab'.repeat(31)), null);
  const backup = json('./key-backup-vectors.json');
  const file = JSON.stringify(Object.values(backup).find((v) => v?.format === 'mccontrol-key-backup')
    || { format: 'mccontrol-key-backup' });
  assert.equal(importKind(file), 'backup');
  assert.equal(importKind('{"format":"other"}'), null);
  assert.equal(importKind('{not json'), null);
});

test('set-up: the console lines, the line ending, and when the node asks for a reboot', () => {
  assert.equal(BAUD, 115200);
  assert.deepEqual(setupLines(KEY.toLowerCase()), [`set mqtt.cmd.pubkey ${KEY}`, 'set mqtt.cmd on']);
  assert.deepEqual([...consoleBytes('ver')], [118, 101, 114, 13], 'the firmware reads a line up to \\r');
  assert.equal(asksReboot('> set mqtt.cmd on\nOK - reboot to apply\n'), true);
  assert.equal(asksReboot('OK\n'), false);
  assert.equal(showsKey(`> ${KEY.toLowerCase()}`, KEY), true);
  assert.equal(showsKey('> (none)', KEY), false);
  assert.equal(serialAvailable({ serial: {} }), true);
  assert.equal(serialAvailable({}), false);
});

test('settings store: thresholds with defaults and limits, brokers per region', () => {
  const st = fakeStorage();
  assert.equal(lowBatteryVolts(st), 3.5);
  assert.equal(notHeardHours(st), 24);
  setLowBatteryVolts('3.65', st);
  setNotHeardHours(48, st);
  assert.equal(lowBatteryVolts(st), 3.65);
  assert.equal(notHeardHours(st), 48);
  assert.throws(() => setLowBatteryVolts(9, st), RangeError);
  assert.throws(() => setNotHeardHours('x', st), RangeError);
  setNotHeardHours(24, st);
  assert.equal(st.map.has('mccontrol.notHeardHours'), false, 'the default is not stored');
  st.setItem('mccontrol.lowBatteryV', 'garbage');
  assert.equal(lowBatteryVolts(st), 3.5);

  assert.equal(validHost('mqtt.meshcore-vgr.se'), true);
  assert.equal(validHost('wss://mqtt.meshcore-vgr.se/'), true);
  assert.equal(validHost('mqtt.example.se:8443'), true);
  assert.equal(validHost('mqtt.example.se:99999'), false);
  assert.equal(validHost('localhost'), false);
  assert.equal(validHost('http://x.se/path'), false);
  assert.deepEqual(setRegionBroker('vgr', 'MQTT.meshcore-vgr.se', st), ['VGR', 'mqtt.meshcore-vgr.se']);
  setRegionBroker('SKN', 'mqtt.example.se:8443', st);
  assert.throws(() => setRegionBroker('V', 'x.se', st), RangeError);
  assert.deepEqual(regionBrokers(st), { VGR: 'mqtt.meshcore-vgr.se', SKN: 'mqtt.example.se:8443' });

  const shared = brokerConfig(brokers, 'jkg', st);
  assert.deepEqual([shared.broker, shared.port, shared.path, shared.region], ['mqtt-meshcore.louie.se', 443, '/', 'JKG']);
  assert.equal(brokerConfig(brokers, 'VGR', st).broker, 'mqtt.meshcore-vgr.se');
  const skn = brokerConfig(brokers, 'SKN', st);
  assert.deepEqual([skn.broker, skn.port], ['mqtt.example.se', 8443]);
  removeRegionBroker('vgr', st);
  assert.equal(brokerConfig(brokers, 'VGR', st).broker, 'mqtt-meshcore.louie.se');
  st.setItem('mccontrol.brokers', '{"JKG":"not a host"}');
  assert.deepEqual(regionBrokers(st), {}, 'a hand-edited bad entry is ignored');
});

test('key screen: auto-lock words', () => {
  const t = (k) => k;
  assert.equal(autoLockText(t, null), 'key.autolock.tab');
  assert.equal(autoLockText(t, 15), 'key.autolock.15');
});

test('key screen: the shown private key hides itself after a minute, and on hide() once', () => {
  let now = 0;
  const due = new Map();
  let next = 1;
  const timers = {
    setTimeout(fn, ms) { const id = next++; due.set(id, [now + ms, fn]); return id; },
    clearTimeout(id) { due.delete(id); },
  };
  const advance = (ms) => {
    now += ms;
    for (const [id, [at, fn]] of [...due]) if (at <= now) { due.delete(id); fn(); }
  };
  let hidden = 0;
  const r = revealer(() => { hidden += 1; }, { timers });
  assert.equal(REVEAL_MS, 60000);
  assert.equal(r.value(), null);
  r.show('ab'.repeat(32));
  assert.equal(r.value(), 'ab'.repeat(32));
  advance(REVEAL_MS - 1);
  assert.equal(r.value(), 'ab'.repeat(32), 'still shown just before the minute');
  advance(1);
  assert.deepEqual([r.value(), hidden, due.size], [null, 1, 0], 'hidden after 60 s');
  r.show('cd'.repeat(32));
  r.hide();                                         // a lock, a redraw or leaving the screen
  r.hide();
  assert.deepEqual([r.value(), hidden, due.size], [null, 2, 0], 'hidden once, its timer cleared');
  r.show('ef'.repeat(32));
  r.show('01'.repeat(32));                           // shown again: one timer, the new value
  assert.deepEqual([r.value(), hidden, due.size], ['01'.repeat(32), 3, 1]);

  // W-12: a copied key is cleared from the clipboard when it hides; an uncopied one leaves it.
  const writes = [];
  const c = revealer(() => {}, { timers, clipboard: () => ({ writeText: async (x) => { writes.push(x); } }) });
  c.show('ab'.repeat(32));
  c.hide();
  assert.deepEqual(writes, []);
  c.show('cd'.repeat(32));
  assert.equal(c.copy(), 'cd'.repeat(32));
  advance(REVEAL_MS);
  assert.deepEqual(writes, ['']);
  c.hide();
  assert.deepEqual(writes, [''], 'cleared once');
  assert.equal(c.copy(), '', 'nothing to copy once hidden');
});

test('help: links between topics, and every result code with mesh-closed', () => {
  const runs = helpRuns('see [[signing]] and [[nope]].', help.topics, help.link_pattern);
  assert.deepEqual(runs, [{ text: 'see ' }, { topic: 'signing' }, { text: ' and ' }, { text: '[[nope]]' }, { text: '.' }]);
  const rows = resultRows(results);
  assert.deepEqual(rows.map((r) => r.code), [...Array(20).keys()]);
  const closed = rows.find((r) => r.code === 19);
  assert.equal(closed.name, 'mesh-closed');
  assert.match(closed.help, /Send over MQTT/);
  assert.equal(rows.find((r) => r.code === 1).help, '');
  // W-35g: a code the shared table leaves without words has the page's own, in every language.
  for (const lang of ['en', 'sv']) {
    const strings = JSON.parse(readFileSync(new URL(`../i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const r of rows.filter((x) => !x.help)) assert.ok(strings[`help.code.${r.name}`], `${lang}: help.code.${r.name}`);
  }
  for (const name of Object.values(help.topics.index.body.match(/\[\[([a-z0-9_-]+)\]\]/g)).map((m) => m.slice(2, -2))) {
    assert.ok(help.topics[name], `the contents link to ${name}`);
  }
});

test('key session: one keyring for the page, the header state, holds and unlock links', async () => {
  const ring = await startKeySession({ storage: memoryStorage(), iterations: 1000 });
  assert.equal(await startKeySession(), ring, 'started once');
  assert.deepEqual(keyState(), { status: 'none', publicKeyHex: null });
  assert.equal(currentHandle(), null);
  assert.throws(() => holdKey(), /locked/);
  const seen = [];
  const stop = onKeyStatus((s) => seen.push(s.locked));
  const handle = await ring.create('correct horse battery');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(currentHandle(), handle);
  assert.deepEqual(keyState(), { status: 'unlocked', publicKeyHex: handle.publicKeyHex });
  assert.equal(keyStatus().publicKeyHex, handle.publicKeyHex, 'the public key at once, no backup gate');
  const release = holdKey();
  ring.lock();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(keyState().status, 'locked');
  assert.equal(currentHandle(), null);
  release();
  stop();
  assert.ok(seen.includes(true) && seen.includes(false));
  assert.deepEqual(shellState({ exists: false }), { status: 'none', publicKeyHex: null });
  assert.equal(unlockHash('node/4AC61A7F'), '#/unlock/to/node/4AC61A7F');
  assert.equal(unlockHash(''), '#/unlock');
});

test('every string the new screens use exists in both languages', () => {
  const sv = json('../i18n/sv.json');
  const en = json('../i18n/en.json');
  const files = ['unlock', 'key', 'setup', 'settings', 'help', 'key-kit'];
  const literal = new Set();
  for (const f of files) {
    const src = readFileSync(new URL(`../ui/screens/${f}.js`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) literal.add(m[1]);
  }
  const templated = ['unlock.h.start', 'unlock.h.replace', 'unlock.h.unlock', 'unlock.h.done',
    'unlock.problem.short', 'unlock.problem.mismatch', 'unlock.kind.backup', 'unlock.kind.seed', 'unlock.kind.unknown',
    'key.autolock.5', 'key.autolock.15', 'key.autolock.60', 'key.autolock.tab', 'keyscreen.cost3',
    'keyscreen.qrShow', 'keyscreen.qrHide', 'setup.connected'];
  for (const k of [...literal, ...templated]) {
    assert.ok(k in sv, `sv ${k}`);
    assert.ok(k in en, `en ${k}`);
  }
});

test('the key check reads only what the console said after the check line, not our echo (W-12)', () => {
  const pub = 'AB'.repeat(32);
  const said = consoleLog(200);
  said.append(`> set mqtt.cmd.pubkey ${pub}\nOK - reboot to apply\n`);
  said.append('> get mqtt.cmd.pubkey\n');
  said.mark();
  said.append('> (not set)\n');
  assert.equal(showsKey(said.sinceMark(), pub), false);
  assert.equal(showsKey(said.text(), pub), true);
  said.append(`> ${pub}\n`);
  assert.equal(showsKey(said.sinceMark(), pub), true);
  assert.ok(said.text().length <= 200);
});
