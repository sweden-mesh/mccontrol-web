// Setup, the command palette and the broker registration (W-20d, W-20h, W-20i, proposal findings
// 4 and 8): the logic only, no DOM. Registration runs against the in-memory fake broker; nothing
// here reaches a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMqttClient } from '../lib/protocol/mqtt-client.js';
import { configFor, register } from '../lib/protocol/transport.js';
import { registerAckTopic } from '../lib/protocol/topics.js';
import { fromUtf8 } from '../lib/bytes.js';
import { createFakeBroker } from './protocol-fake-broker.js';
import { data, ownerHandle } from './protocol-helpers.js';
import { commandOf, commandHelp, helpKey } from '../ui/modals/command-help.js';
import {
  buildEntries, commandLines, filterEntries, parseTarget, runHash, targetFor,
} from '../ui/modals/palette-entries.js';
import { TABS, ALIASES, tabFor } from '../ui/modals/setup.js';
import { brokerProblem, brokerText, createRegistrar, registrationText } from '../ui/screens/key-register.js';
import { translator } from '../i18n/i18n.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const en = json('../i18n/en.json');
const sv = json('../i18n/sv.json');
const table = json('../lib/data/commands.json').table;
const t = translator(en);

test('every command of the table says what it does, in both languages', () => {
  for (const c of table) {
    for (const [lang, strings] of [['en', en], ['sv', sv]]) {
      assert.ok(strings[helpKey(c)], `${lang}: ${helpKey(c)}`);
    }
  }
  // No words left over for a command the table no longer has.
  const known = new Set(table.map(helpKey));
  for (const k of Object.keys(en).filter((x) => x.startsWith('palette.cmd.'))) assert.ok(known.has(k), k);
});

test('a typed line is an instance of the longest command it starts with', () => {
  assert.equal(commandOf(table, 'region put se-jkp *').text, 'region put');
  assert.equal(commandOf(table, 'region').text, 'region');
  assert.equal(commandOf(table, 'get autoreply').text, 'get autoreply');
  assert.equal(commandOf(table, 'get mqtt1.server').text, 'get', 'the generic read');
  assert.equal(commandOf(table, 'set mqtt.cmd on').text, 'set', 'the generic write');
  assert.equal(commandOf(table, 'regionx'), null, 'a prefix of a word is not a match');
  assert.equal(commandOf(table, '  '), null);
  assert.equal(commandHelp(t, table, 'region save'), en['palette.cmd.region save']);
  assert.equal(commandHelp(t, table, 'nonsense'), '');
});

test('the shipped command set explains every step', () => {
  const steps = data('brokers').default_sets['add-scope'];
  for (const s of steps) assert.ok(commandHelp(t, table, s.replaceAll('{arg}', 'se-jkp')), s);
});

test('Setup: seven tabs in the order an owner meets them, old names land on one', () => {
  assert.deepEqual(Object.keys(TABS), ['key', 'node', 'area', 'groups', 'sets', 'warnings', 'display']);
  for (const tab of Object.values(TABS)) {
    assert.ok(tab.label in en && tab.label in sv, tab.label);
    assert.equal(typeof tab.render, 'function');
  }
  assert.equal(tabFor('settings'), 'area');
  assert.equal(tabFor('setup'), 'node');
  assert.equal(tabFor('groups'), 'groups');
  assert.equal(tabFor('nope'), null);
  for (const to of Object.values(ALIASES)) assert.ok(TABS[to]);
});

test('palette: the command lines, the target and its address', () => {
  const lines = commandLines(table).map((x) => x.line);
  assert.ok(lines.includes('ver'));
  assert.ok(lines.includes('set autoreply on') && lines.includes('set autoreply off'), 'each choice');
  assert.ok(lines.includes('trigger test'), 'an empty choice is the bare command');
  assert.ok(lines.includes('region put '), 'a text command leaves room for its value');
  assert.equal(new Set(commandLines(table).map((x) => x.command.text)).size, table.length, 'every command is there');

  assert.equal(targetFor({}), '-');
  assert.equal(targetFor({ selected: '4AC61A7F' }), 'n:4AC61A7F');
  assert.equal(targetFor({ selected: '4AC61A7F', tagged: ['AB', 'CD'] }), 'n:AB,CD', 'tagged wins');
  assert.deepEqual(parseTarget('n:ab,CD'), { kind: 'nodes', ids: ['AB', 'CD'] });
  assert.deepEqual(parseTarget('g:roof:2'), { kind: 'group', id: 'roof:2' });
  assert.deepEqual(parseTarget('r:jkg'), { kind: 'region', region: 'JKG' });
  assert.equal(parseTarget('-'), null);
  assert.equal(parseTarget('n:'), null);
  assert.equal(runHash('cmd', 'n:AB', 'region put se-jkp *'), '#run/cmd/n%3AAB/region%20put%20se-jkp%20*');
  assert.equal(runHash('cmd', 'r:JKG'), '#run/cmd/r%3AJKG');
  assert.equal(runHash('set', '', 'add-scope'), '#run/set/-/add-scope');
});

test('palette: the entries, and typing narrows them best first', () => {
  const entries = buildEntries({
    t, tabs: TABS, table, sets: { 'add-scope': ['region put {arg} *'] }, groups: [{ id: 'roof', members: ['AB'] }],
    regions: [{ region: 'JKG', count: 4 }], key: { status: 'unlocked' }, target: 'n:AB',
  });
  const labels = entries.map((e) => e.label);
  assert.ok(labels.includes('Setup: Key') && labels.includes('Setup: Display'));
  assert.ok(labels.includes('Lock the key'));
  assert.ok(entries.find((e) => e.label === 'Every node in region JKG').hash.startsWith('#run/cmd/r%3AJKG'));
  assert.equal(entries.find((e) => e.label === 'Run the set add-scope').hash, '#run/set/n%3AAB/add-scope');
  assert.equal(entries.find((e) => e.label === 'ver').hash, '#run/cmd/n%3AAB/ver');
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length, 'ids are unique');

  assert.equal(filterEntries(entries, '').length, entries.length);
  assert.equal(filterEntries(entries, 'ver')[0].label, 'ver', 'a label that starts with the query first');
  assert.ok(filterEntries(entries, 'flood hops').some((e) => e.label === 'get flood.max'), 'words match the help too');
  assert.equal(filterEntries(entries, 'zzzz').length, 0);
  assert.equal(filterEntries(entries, 'REGION JKG')[0].label, 'Every node in region JKG', 'case is ignored');

  const none = buildEntries({ t, tabs: TABS, table: [], key: { status: 'none' }, modals: () => false });
  assert.ok(!none.some((e) => /key/i.test(e.label) && e.hash === '#unlock'), 'no unlock entry: the gate is in front (W-28b)');
  assert.ok(!none.some((e) => e.label === 'Help'), 'only modals that exist');
  assert.ok(!none.some((e) => e.label.startsWith('Send a command')), 'no target, no "send to"');
});

test('broker errors in words, with a next step', () => {
  const unreachable = brokerProblem(t, 'cannot reach wss://mqtt-meshcore.louie.se/ (1006)');
  assert.equal(unreachable.code, 'unreachable');
  assert.equal(unreachable.text, 'Could not reach the broker mqtt-meshcore.louie.se.');
  assert.ok(unreachable.next.length > 10);
  assert.equal(brokerProblem(t, 'wss://b.se/ did not answer the connection in 10 s').code, 'noAnswer');
  assert.match(brokerProblem(t, 'the broker refused the connection: not authorized').text, /not authorized/);
  assert.equal(brokerProblem(t, 'no acknowledgement in 10 s').code, 'noAck');
  assert.equal(brokerProblem(t, 'the connection to the broker closed (1006)').code, 'closed');
  assert.equal(brokerProblem(t, 'this browser has no WebSocket').code, 'noSocket');
  assert.equal(brokerProblem(t, 'The key is locked.'), null);
  assert.equal(brokerText(t, 'The key is locked.'), 'The key is locked.', 'anything else is left as it is');
  for (const k of Object.keys(en).filter((x) => x.startsWith('setup.broker.'))) assert.ok(k in sv, k);
  // A line per broker.
  assert.match(registrationText(t, { host: 'b.se', state: 'ok' }), /b\.se knows/);
  assert.match(registrationText(t, { host: 'b.se', state: 'failed', refused: true, detail: 'denied: unknown key' }), /did not accept the key: denied/);
  assert.match(registrationText(t, { host: 'b.se', state: 'failed', detail: 'cannot reach wss://b.se/' }), /Could not reach the broker b\.se/);
});

function memoryStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

const connectVia = (broker) => (opts) => createMqttClient({ ...opts, WebSocket: broker.WebSocket });

test('registration: by itself once on unlock, through a fake broker, remembered per key and broker', async () => {
  const owner = ownerHandle();
  const config = { ...configFor(data('brokers'), ''), wait_secs: 2 };
  const published = [];
  const broker = createFakeBroker({
    chunk: 'merge',
    onPublish(b, p) {
      published.push(p.topic);
      if (p.topic === 'mccontrol/register') b.publish(registerAckTopic(fromUtf8(p.payload).split('|')[1]), 'ok');
    },
  });
  const storage = memoryStore();
  const seen = [];
  const r = createRegistrar({
    register: (cfg, handle) => register({ config: cfg, handle, waitSecs: 2, connect: connectVia(broker) }),
    brokersFor: async () => [{ host: config.broker, config }],
    storage,
    clock: () => 1000,
  });
  r.onRegistration((s) => seen.push(s.state));
  const status = { exists: true, locked: false, publicKeyHex: owner.publicKeyHex };

  assert.equal(await r.follow({ ...status, locked: true }, owner), null, 'locked: nothing is sent');
  assert.deepEqual(published, []);
  const res = await r.follow(status, owner);
  assert.equal(res.state, 'ok');
  assert.deepEqual(published, ['mccontrol/register'], 'one signed publish, nothing else');
  assert.ok(seen.includes('running') && seen.at(-1) === 'ok');
  assert.equal(await r.follow(status, owner), null, 'once per key and page');
  assert.equal(published.length, 1);

  // A new page (a new registrar) remembers it: no publish.
  const again = createRegistrar({
    register: () => { throw new Error('must not register'); }, brokersFor: async () => [{ host: config.broker, config }], storage,
  });
  assert.equal(await again.follow(status, owner), null);
  assert.equal(again.registration().state, 'ok');
  assert.equal(again.registration().hosts[0].at, 1000);
});

test('registration: a broker that is silent or unreachable is said as such, and a retry works', async () => {
  const owner = ownerHandle();
  const config = { ...configFor(data('brokers'), ''), wait_secs: 2 };
  let mode = 'silent';
  const r = createRegistrar({
    register: async (cfg, handle) => {
      if (mode === 'down') throw new Error(`cannot reach wss://${cfg.broker}/ (1006)`);
      if (mode === 'silent') return register({ config: cfg, handle, waitSecs: 0.2, connect: connectVia(createFakeBroker()) });
      return { ok: true, detail: 'ok' };
    },
    brokersFor: async () => [{ host: config.broker, config }, { host: 'b.example.se', config: { ...config, broker: 'b.example.se' } }],
    storage: memoryStore(),
  });
  let s = await r.registerNow(owner);
  assert.equal(s.state, 'failed');
  assert.match(registrationText(t, s.hosts[0]), /did not confirm the registration/);
  mode = 'down';
  s = await r.registerNow(owner);
  assert.match(registrationText(t, s.hosts[1]), /Could not reach the broker b\.example\.se/);
  mode = 'ok';
  s = await r.registerNow(owner);
  assert.equal(s.state, 'ok');
  await assert.rejects(r.registerNow(null), /locked/);
});
