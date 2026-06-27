const { test } = require('node:test');
const assert = require('node:assert');
const { loadRecordConfig } = require('./recordConfig');

test('defaults are generic container paths and sane numbers', () => {
  const c = loadRecordConfig({});
  assert.strictEqual(c.savePath, '/recordings');
  assert.strictEqual(c.stagingPath, '/staging');
  assert.strictEqual(c.defaultDurationMin, 120);
  assert.strictEqual(c.epgPrePadMin, 2);
  assert.strictEqual(c.epgPostPadMin, 5);
  assert.strictEqual(c.maxConcurrent, 1);
});

test('env overrides are parsed as ints / strings', () => {
  const c = loadRecordConfig({
    RECORD_SAVE_PATH: '/recordings',
    RECORD_STAGING_PATH: '/staging',
    RECORD_DEFAULT_DURATION_MIN: '90',
    RECORD_MAX_CONCURRENT: '3',
  });
  assert.strictEqual(c.defaultDurationMin, 90);
  assert.strictEqual(c.maxConcurrent, 3);
});

test('non-numeric env falls back to default', () => {
  const c = loadRecordConfig({ RECORD_MAX_CONCURRENT: 'abc' });
  assert.strictEqual(c.maxConcurrent, 1);
});
