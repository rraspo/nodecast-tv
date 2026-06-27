'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { mkvPathFor, buildRemuxArgs } = require('./recordFinalize');

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
