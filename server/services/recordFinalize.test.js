'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { mkvPathFor, buildRemuxArgs, buildProbeArgs, parseProbeDurationMs, isUnremuxed } = require('./recordFinalize');

test('isUnremuxed: true only for done .ts recordings', () => {
  assert.strictEqual(isUnremuxed({ status: 'done', save_path: '/r/a.ts' }), true);
  assert.strictEqual(isUnremuxed({ status: 'done', save_path: '/r/a.mkv' }), false);
  assert.strictEqual(isUnremuxed({ status: 'recording', save_path: '/r/a.ts' }), false);
  assert.strictEqual(isUnremuxed({ status: 'error', save_path: '/r/a.ts' }), false);
  assert.strictEqual(isUnremuxed(null), false);
  assert.strictEqual(isUnremuxed({ status: 'done' }), false);
});

test('mkvPathFor: swaps .ts extension to .mkv', () => {
  assert.strictEqual(mkvPathFor('/staging/abc.ts'), '/staging/abc.mkv');
  assert.strictEqual(mkvPathFor('/some/path/show - 2024-01-01.ts'), '/some/path/show - 2024-01-01.mkv');
});

test('buildRemuxArgs: includes -c copy, v/a/s maps, -i src, dest last', () => {
  const args = buildRemuxArgs({ src: '/in.ts', dest: '/out.mkv' });
  // dest is last
  assert.strictEqual(args[args.length - 1], '/out.mkv');
  // -i src
  const iIdx = args.indexOf('-i');
  assert.ok(iIdx !== -1, '-i flag present');
  assert.strictEqual(args[iIdx + 1], '/in.ts');
  // -c copy
  const cIdx = args.indexOf('-c');
  assert.ok(cIdx !== -1, '-c flag present');
  assert.strictEqual(args[cIdx + 1], 'copy');
  // optional-stream maps
  assert.ok(args.includes('0:v?'), '0:v? map present');
  assert.ok(args.includes('0:a?'), '0:a? map present');
  assert.ok(args.includes('0:s?'), '0:s? map present');
});

test('buildProbeArgs: returns correct ffprobe argv with file last', () => {
  const args = buildProbeArgs('/some/file.mkv');
  assert.deepStrictEqual(args, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    '/some/file.mkv',
  ]);
});

test('parseProbeDurationMs: parses float seconds string with trailing newline', () => {
  assert.strictEqual(parseProbeDurationMs('1771.234\n'), 1771234);
});

test('parseProbeDurationMs: returns null for N/A', () => {
  assert.strictEqual(parseProbeDurationMs('N/A'), null);
});

test('parseProbeDurationMs: returns null for empty string', () => {
  assert.strictEqual(parseProbeDurationMs(''), null);
});

test('parseProbeDurationMs: returns null for zero or negative value', () => {
  assert.strictEqual(parseProbeDurationMs('0'), null);
  assert.strictEqual(parseProbeDurationMs('-1.5'), null);
});

test('parseProbeDurationMs: rounds to nearest ms', () => {
  assert.strictEqual(parseProbeDurationMs('60.0005'), 60001);
  assert.strictEqual(parseProbeDurationMs('3600'), 3600000);
});
