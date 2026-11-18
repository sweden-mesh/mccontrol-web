// The copies of mccontrol-spec (lib/data/*.json, test/vectors.json, test/key-backup-vectors.json)
// are the tag spec.lock names: each matches its hash there, and no generated data file is missing
// from it. Offline; `node scripts/spec-sync.mjs --check` compares with GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { LOCK, parseLock, sha256, local } from '../../scripts/spec-sync.mjs';

const ROOT = new URL('../../', import.meta.url);
const lock = parseLock(readFileSync(LOCK, 'utf8'));

test('every copy matches its line in spec.lock', () => {
  assert.ok(lock.tag, 'spec.lock names a tag');
  const bad = lock.files.filter((f) => f.local !== local(f.path) || sha256(readFileSync(new URL(f.local, ROOT))) !== f.sha256);
  assert.deepEqual(bad.map((f) => f.local), [], 'edited by hand or stale: run scripts/spec-sync.mjs');
});

test('every JSON file in lib/data/ comes from the spec', () => {
  const data = readdirSync(new URL('web/lib/data/', ROOT)).filter((n) => n.endsWith('.json')).map((n) => `web/lib/data/${n}`);
  assert.deepEqual(data.filter((d) => !lock.files.some((f) => f.local === d)), []);
});
