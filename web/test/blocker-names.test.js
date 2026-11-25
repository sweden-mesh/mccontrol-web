// A content blocker's privacy list (EasyPrivacy, in uBlock Origin) blocks every path that holds
// "/beacon.js", which also catches "/beacon.json". A blocked module stops the whole page from
// starting, so no file the page loads may carry such a name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BLOCKED = [/\/beacon\.js/i];

test('no served file has a name a privacy list blocks', () => {
  const served = readdirSync(ROOT, { recursive: true }).map((p) => `/${String(p).replaceAll('\\', '/')}`)
    .filter((p) => !p.startsWith('/test/') && !p.startsWith('/node_modules/'));
  assert.ok(served.includes('/ui/app.js'));
  for (const path of served) for (const rx of BLOCKED) assert.ok(!rx.test(path), `${path} is blocked by ${rx}`);
});
