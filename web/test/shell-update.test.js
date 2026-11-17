// W-20k: the Trusted Types policy for the service worker is made when the worker registers, not
// when ui/update.js loads, so a browser that refuses it still starts the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fresh = () => import(`../ui/update.js?${Math.random()}`);

test('loading the module creates no policy, even when the browser refuses every policy', async () => {
  let asked = 0;
  globalThis.trustedTypes = { createPolicy() { asked += 1; throw new TypeError('refused'); } };
  try {
    const mod = await fresh();
    assert.equal(asked, 0);
    assert.equal(await mod.startUpdates({ version: 'dev', onWaiting() {} }), null);
    assert.equal(asked, 0);
  } finally { delete globalThis.trustedTypes; }
  const src = readFileSync(new URL('../ui/update.js', import.meta.url), 'utf8');
  const topLevel = src.split('\n').filter((l) => /createPolicy/.test(l) && !/^\s/.test(l) && !l.startsWith('//'));
  assert.deepEqual(topLevel, [], 'createPolicy at the top level');
});

test('a refused policy costs only the offline copy, and is asked once', async () => {
  const mod = await fresh();
  let asked = 0;
  const refusing = { createPolicy() { asked += 1; throw new TypeError("Policy 'mccontrol-sw' disallowed"); } };
  assert.throws(() => mod.swPolicy(refusing), /refused the service worker's Trusted Types policy.*disallowed/);
  assert.equal(mod.swPolicy(refusing), false);
  assert.equal(asked, 1);
});

test('the policy accepts sw.js and nothing else; no Trusted Types means a plain URL', async () => {
  const mod = await fresh();
  const tt = { createPolicy: (name, rules) => ({ name, ...rules }) };
  const p = mod.swPolicy(tt);
  assert.equal(p.name, 'mccontrol-sw');
  assert.equal(p.createScriptURL('sw.js'), 'sw.js');
  assert.throws(() => p.createScriptURL('evil.js'), /not the service worker/);
  assert.equal(mod.swPolicy(tt), p);
  assert.equal((await fresh()).swPolicy(undefined), null);
});
