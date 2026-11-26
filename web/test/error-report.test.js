import test from 'node:test';
import assert from 'node:assert/strict';

// update.js and the session modules touch the page; the pure part is tested through a stubbed window.
globalThis.window ??= { addEventListener() {} };
const { reportText } = await import('../ui/error-report.js');

test('the copied status lines: version, time, browser, then one line per status with its detail', () => {
  const text = reportText({ version: '0.1.0-beta.12-57', now: Date.UTC(2026, 10, 26, 7, 0, 0), userAgent: 'Firefox/161', online: true,
    address: 'https://example.invalid/', lines: [
      { name: 'broker', state: 'alert', detail: 'connect: closed before CONNACK', hosts: ['a.example', 'b.example'] },
      { name: 'key', state: 'ok', detail: 'unlocked' },
      { name: 'refresh', state: 'ok', last: Date.UTC(2026, 10, 26, 6, 46, 0) },
      { name: 'discovery', state: undefined }] });
  assert.deepEqual(text.split('\n'), [
    'mccontrol 0.1.0-beta.12-57', '2026-11-26T07:00:00.000Z', 'Firefox/161', 'address: https://example.invalid/', 'browser online: true', '',
    '[ERROR] broker: hosts: a.example, b.example | connect: closed before CONNACK',
    '[ok] key: unlocked',
    '[ok] refresh: last: 2026-11-26T06:46:00.000Z',
    '[unknown] discovery']);
});
