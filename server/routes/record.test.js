const { test } = require('node:test');
const assert = require('node:assert');
const { canStart, resolveStart } = require('./record');

test('canStart: blocked at max concurrent', () => {
  const repo = { countActive: () => 1 };
  assert.deepStrictEqual(canStart(repo, { maxConcurrent: 1 }), { ok: false, reason: 'max-concurrent' });
});

test('canStart: allowed under limit', () => {
  const repo = { countActive: () => 0 };
  assert.strictEqual(canStart(repo, { maxConcurrent: 1 }).ok, true);
});

test('resolveStart: invalid body rejected', () => {
  assert.strictEqual(resolveStart({}).ok, false);
  assert.strictEqual(resolveStart({ url: 'u', mode: 'bogus' }).ok, false);
});

test('resolveStart: duration mode resolves filename + durationSec', () => {
  const r = resolveStart({ url: 'u', channelName: 'Ch5', mode: 'duration', durationMin: 30 },
    { defaultDurationMin: 120, epgPostPadMin: 5 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.durationSec, 1800);
  assert.strictEqual(r.value.fileBase, 'Ch5');
});

test('resolveStart: program mode uses programmeTitle for filename', () => {
  const now = 1_000_000;
  const r = resolveStart(
    { url: 'u', channelName: 'Ch5', mode: 'program', programmeTitle: 'The Show', epgEndMs: now + 60_000 },
    { defaultDurationMin: 120, epgPostPadMin: 1 }, now);
  assert.strictEqual(r.value.fileBase, 'The Show');
  assert.strictEqual(r.value.durationSec, 120);
});

test('resolveStart: program mode without valid epgEndMs is rejected', () => {
  const cfg = { defaultDurationMin: 120, epgPostPadMin: 5 };
  assert.strictEqual(resolveStart({ url: 'u', channelName: 'Ch5', mode: 'program' }, cfg).ok, false);
  assert.strictEqual(resolveStart({ url: 'u', channelName: 'Ch5', mode: 'program', epgEndMs: NaN }, cfg).ok, false);
  assert.strictEqual(resolveStart({ url: 'u', channelName: 'Ch5', mode: 'program', epgEndMs: null }, cfg).ok, false);
});

test('canStart: blocked when over the concurrent limit', () => {
  const repo = { countActive: () => 2 };
  assert.deepStrictEqual(canStart(repo, { maxConcurrent: 1 }), { ok: false, reason: 'max-concurrent' });
});
