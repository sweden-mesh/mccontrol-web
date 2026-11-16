// The generated data loads through lib/data and has what the screens rely on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadAll, NAMES } from '../lib/data/load.js';

const readJson = async (url) => JSON.parse(await readFile(fileURLToPath(url), 'utf8'));

test('every data file loads and says it is generated', async () => {
  const data = await loadAll(readJson);
  assert.deepEqual(Object.keys(data).sort(), [...NAMES].sort());
  for (const name of NAMES) assert.match(data[name]._source, /do not edit/);
});

test('the command table, results and help are there', async () => {
  const data = await loadAll(readJson);
  assert.ok(data.commands.table.some((c) => c.text === 'ver' && c.read));
  assert.equal(data.results.codes['14'], 'not-allowed');
  assert.ok(data.help.topics.index.title);
  assert.equal(data.firmware.v2_from, 13);
});
