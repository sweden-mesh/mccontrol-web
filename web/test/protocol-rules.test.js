// The checks before signing reproduce Python's answers in test/vectors.json: deny list,
// cautions, reads, firmware rules, facts and command building.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rulesFrom } from '../lib/protocol/rules.js';
import { V, data } from './protocol-helpers.js';

const rules = rulesFrom({
  denylist: data('denylist'), cautions: data('cautions'), commands: data('commands'),
  firmware: data('firmware'), facts: data('facts'),
});
const table = data('commands').table;
const C = V.checks;

test('deny list', () => {
  for (const c of C.refusal) assert.equal(rules.refusal(c.command), c.refusal, JSON.stringify(c.command));
});

test('broadcast refusals', () => {
  for (const c of C.broadcast_refusal) assert.equal(rules.broadcastRefusal(c.command), c.refusal, JSON.stringify(c.command));
});

test('cautions', () => {
  for (const c of C.caution) assert.equal(rules.caution(c.command), c.caution, JSON.stringify(c.command));
});

test('reads', () => {
  for (const c of C.is_read) assert.equal(rules.isRead(c.command), c.read, JSON.stringify(c.command));
});

test('the oldest firmware that admits a command', () => {
  for (const c of C.needs) assert.equal(rules.needs(c.command), c.tag, JSON.stringify(c.command));
});

test('firmware rules per version', () => {
  for (const f of C.firmware) {
    const v = f.version;
    assert.equal(rules.revision(v), f.revision, v);
    assert.equal(rules.features(v), f.features, v);
    assert.equal(rules.entryFor(v).tag, f.entry, v);
    assert.equal(rules.speaksV2(v), f.speaks_v2, v);
    assert.equal(rules.admitsUtf8(v), f.admits_utf8, v);
    assert.equal(rules.privateSubtype(v), f.private_subtype, v);
    for (const [cmd, want] of Object.entries(f.admits)) assert.equal(rules.admits(v, cmd), want, `${v} ${cmd}`);
    for (const [cmd, want] of Object.entries(f.lacks)) assert.equal(rules.lacks(v, cmd), want, `${v} ${cmd}`);
  }
});

test('facts from answers', () => {
  for (const c of C.facts) assert.deepEqual(rules.parseFacts(c.command, c.reply), c.facts, c.command);
  assert.equal(rules.reader('version'), 'ver');
  assert.equal(rules.reader('autoreply.channel'), 'get autoreply');
  assert.equal(rules.reader('txdelay'), 'get txdelay');
});

test('command building', () => {
  for (const c of C.build) {
    const entry = table.find((e) => e.text === c.text);
    assert.equal(rules.build(entry, c.values), c.built, c.text);
  }
});
