const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeFilename, computeDurationSec, buildRecordArgs } = require('./recordSession');

test('sanitizeFilename strips path/illegal chars', () => {
  assert.strictEqual(sanitizeFilename('The Movie: Part/2 *?'), 'The Movie- Part-2');
  assert.strictEqual(sanitizeFilename(''), 'recording');
});

test('computeDurationSec: duration mode uses minutes', () => {
  assert.strictEqual(computeDurationSec({ mode: 'duration', durationMin: 90 }), 5400);
});

test('computeDurationSec: manual mode is open-ended (null)', () => {
  assert.strictEqual(computeDurationSec({ mode: 'manual' }), null);
});

test('computeDurationSec: program mode = epgEnd - now + postPad', () => {
  const nowMs = 1_000_000;
  const epgEndMs = nowMs + 60_000; // 60s to end
  assert.strictEqual(computeDurationSec({ mode: 'program', epgEndMs, nowMs, postPadMin: 1 }), 120);
});

test('buildRecordArgs: copy to mpegts with duration', () => {
  const args = buildRecordArgs({ url: 'http://up/stream', userAgent: 'UA', durationSec: 60, outputPath: '/staging/x.ts' });
  assert.ok(args.includes('-c') && args[args.indexOf('-c') + 1] === 'copy');
  assert.ok(args.includes('-f') && args[args.indexOf('-f') + 1] === 'mpegts');
  assert.ok(args.includes('-i') && args[args.indexOf('-i') + 1] === 'http://up/stream');
  assert.ok(args.includes('-t') && args[args.indexOf('-t') + 1] === '60');
  assert.strictEqual(args[args.length - 1], '/staging/x.ts');
  assert.ok(args.includes('-user_agent') && args[args.indexOf('-user_agent') + 1] === 'UA');
});

test('buildRecordArgs: no -t when durationSec is null', () => {
  const args = buildRecordArgs({ url: 'u', userAgent: 'UA', durationSec: null, outputPath: '/s/x.ts' });
  assert.ok(!args.includes('-t'));
});
