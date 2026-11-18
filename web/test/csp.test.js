// The page runs under script-src 'self' with Trusted Types: no inline script or style, no
// handler attributes, no eval or HTML-string sinks anywhere in our code. Vendored code is
// checked for eval and Function only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('..', import.meta.url));

function files(dir, ext) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return path.endsWith(ext) ? [path] : [];
  });
}

test('index.html carries the CSP and nothing inline', () => {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  for (const part of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "base-uri 'none'",
    "object-src 'none'", "require-trusted-types-for 'script'", 'trusted-types mccontrol-sw']) {
    assert.ok(csp.includes(part), part);
  }
  assert.ok(!/unsafe-inline|unsafe-eval|wasm-unsafe-eval/.test(csp));
  // W-31e: ws: beside wss:, for mccontrol-bridge on the owner's network (an https page reaches only
  // private addresses over ws://, behind the local-network prompt); never plain http:
  const connect = csp.match(/connect-src ([^;]+)/)[1].split(' ');
  assert.ok(connect.includes('wss:') && connect.includes('ws:'), 'connect-src wss: ws:');
  assert.ok(!connect.includes('http:') && !connect.includes('https:') && !connect.includes('*'), 'no scheme-wide http');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'inline script');
  assert.ok(!/<style\b/.test(html), 'inline style');
  assert.ok(!/\son[a-z]+=/i.test(html), 'handler attribute');
  assert.ok(!/\sstyle=/i.test(html), 'style attribute');
});

test('our code has no eval, Function or HTML-string sinks', () => {
  const ours = files(WEB, '.js').filter((f) => !relative(WEB, f).startsWith('vendor'));
  for (const f of ours) {
    if (relative(WEB, f).startsWith('test')) continue;
    const src = readFileSync(f, 'utf8');
    for (const bad of [/\beval\(/, /new Function\b/, /\.innerHTML\b/, /\.outerHTML\b/,
      /insertAdjacentHTML/, /document\.write/, /setHTMLUnsafe/]) {
      assert.ok(!bad.test(src), `${relative(WEB, f)}: ${bad}`);
    }
  }
});

test('vendored code has no eval or Function constructor', () => {
  for (const f of files(join(WEB, 'vendor'), '.js')) {
    // comments out; `eval(a, x) {` is a method of the same name, not the global
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/(^|[^.\w])eval\((?![^)]*\)\s*\{)/m.test(src), relative(WEB, f));
    assert.ok(!/new Function\(/.test(src), relative(WEB, f));
  }
});

test('nothing reaches a third party by URL in our code', () => {
  const ours = files(WEB, '.js').filter((f) => !/^(vendor|test)/.test(relative(WEB, f)));
  for (const f of ours) {
    assert.ok(!/https?:\/\//.test(readFileSync(f, 'utf8')), relative(WEB, f));
  }
});

// mccontrol-sw: the offline copy's worker (W-12); mccontrol-map: MapLibre's worker (W-29d).
test('the Trusted Types policies are the ones the CSP names (W-12, W-29d)', () => {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const allowed = csp.match(/trusted-types ([^;]+)/)[1].trim().split(/\s+/);
  const made = files(WEB, '.js').filter((f) => !relative(WEB, f).startsWith('test'))
    .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/createPolicy\(\s*'([^']+)'/g)].map((m) => m[1]));
  assert.deepEqual(allowed, ['mccontrol-sw', 'mccontrol-map']);
  assert.deepEqual([...new Set(made)].sort(), [...allowed].sort());
});
