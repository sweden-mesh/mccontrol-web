// The command server line (W-28a): connecting, then connected or unreachable, never "not known
// yet"; once per key and page; a later send's report moves it on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerCheck } from '../ui/tiles/broker-source.js';

const HOSTS = [{ host: 'a.example', config: { broker: 'a.example' } }, { host: 'b.example', config: { broker: 'b.example' } }];
const unlocked = { exists: true, locked: false, publicKeyHex: 'AB' };

test('signs in once per key, says running, then ok', async () => {
  const seen = [];
  let calls = 0;
  const c = createBrokerCheck({ connect: async () => { calls += 1; }, brokersFor: async () => HOSTS, clock: () => 1000 });
  c.on(() => seen.push(c.state().state));
  await c.follow(unlocked, {});
  await c.follow(unlocked, {});
  assert.equal(calls, 2);
  assert.equal(c.state().state, 'ok');
  assert.deepEqual(c.state().hosts, ['a.example', 'b.example']);
  assert.ok(seen.includes('running'));
});

test('one host failing makes it unreachable, with the host and why', async () => {
  const c = createBrokerCheck({ connect: async (cfg) => { if (cfg.broker === 'b.example') throw new Error('cannot reach wss://b.example (1006)'); }, brokersFor: async () => HOSTS });
  await c.follow(unlocked, {});
  assert.equal(c.state().state, 'alert');
  assert.match(c.state().detail, /^b\.example: cannot reach/);
});

test('locked or no key: nothing is tried; a later report wins', async () => {
  let calls = 0;
  let now = 1000;
  const c = createBrokerCheck({ connect: async () => { calls += 1; }, brokersFor: async () => HOSTS, clock: () => now });
  assert.equal(await c.follow({ exists: true, locked: true, publicKeyHex: 'AB' }, null), null);
  assert.equal(calls, 0);
  assert.equal(c.state().state, 'unknown');
  await c.follow(unlocked, {});
  now = 2000;
  c.report({ ok: false, detail: 'closed', at: 2000 });
  assert.equal(c.state().state, 'alert');
  c.report({ ok: true, at: 1500 });   // older than what is known: ignored
  assert.equal(c.state().state, 'alert');
});
