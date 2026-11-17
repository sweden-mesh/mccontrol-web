// The hosted copy: _headers carries index.html's CSP plus frame-ancestors and the companion
// headers; the manifest is sound; scripts/web-dist.mjs makes a copy whose integrity.json matches
// every file, with the version stamped into the service worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDist, sourceFiles, stampWorker } from '../../scripts/web-dist.mjs';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const read = (f) => readFileSync(join(WEB, f), 'utf8');

function headerBlock(path) {
  const lines = read('_headers').split('\n');
  const start = lines.indexOf(path);
  assert.ok(start >= 0, `no block for ${path}`);
  const out = {};
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    const [name, ...value] = line.trim().split(':');
    out[name] = value.join(':').trim();
  }
  return out;
}

test('_headers: the page CSP plus frame-ancestors, and the companion headers', () => {
  const meta = read('index.html').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const h = headerBlock('/*');
  assert.equal(h['Content-Security-Policy'], `${meta}; frame-ancestors 'none'`);
  assert.match(h['Strict-Transport-Security'], /max-age=\d{7,}/);
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['Referrer-Policy'], 'no-referrer');
  assert.match(h['Permissions-Policy'], /serial=\(self\)/);
  assert.match(h['Permissions-Policy'], /bluetooth=\(self\)/);
  assert.match(h['Permissions-Policy'], /camera=\(\)/);
  assert.equal(headerBlock('/sw.js')['Cache-Control'], 'no-cache');
});

test('the manifest names icons that exist and stays in scope', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  for (const icon of m.icons) assert.ok(existsSync(join(WEB, icon.src)), icon.src);
});

test('the service worker version is stamped, and only a VERSION line', () => {
  const sw = read('sw.js');
  assert.match(sw, /^const VERSION = 'dev';$/m);
  const stamped = stampWorker(sw, 'web-v1.2.3');
  assert.match(stamped, /^const VERSION = 'web-v1.2.3';$/m);
  assert.equal(stamped.split('\n').length, sw.split('\n').length);
  assert.throws(() => stampWorker('nothing here', 'x'));
});

test('the deployable copy: no tests, every file hashed, the version everywhere', () => {
  const out = mkdtempSync(join(tmpdir(), 'mccontrol-dist-'));
  try {
    const m = buildDist({ web: WEB, out, version: 'web-v9.9.9', commit: 'abc123' });
    const files = Object.keys(m.files);
    assert.ok(files.includes('index.html') && files.includes('sw.js') && files.includes('_headers'));
    assert.ok(!files.some((f) => f.startsWith('test/') || f === 'package.json' || f === 'README.md'));
    assert.deepEqual(files, sourceFiles(WEB));
    for (const [f, sha] of Object.entries(m.files)) {
      assert.equal(createHash('sha256').update(readFileSync(join(out, f))).digest('hex'), sha, f);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'integrity.json'), 'utf8')), m);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'version.json'), 'utf8')), { version: 'web-v9.9.9', commit: 'abc123' });
    assert.match(readFileSync(join(out, 'sw.js'), 'utf8'), /^const VERSION = 'web-v9.9.9';$/m);
    assert.throws(() => buildDist({ web: WEB, out, version: "x'; alert(1)", commit: null }));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the service worker keeps the integrity list it checked, and caches nothing at run time (W-12)', () => {
  const sw = read('sw.js');
  assert.equal(sw.match(/fetch\('integrity\.json'/g).length, 1, 'one fetch of the list: no second, unchecked copy');
  const handler = sw.slice(sw.indexOf("addEventListener('fetch'"));
  assert.ok(!/cache\.put|cache\.add/.test(handler), 'a response from the network is never cached by the fetch handler');
  assert.match(sw, /if \(got !== sha\) throw/);
});
