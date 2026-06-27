const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { RECORDINGS_DDL, createRecordingsRepo } = require('./recordings');

function freshRepo() {
  const db = new Database(':memory:');
  db.exec(RECORDINGS_DDL);
  return createRecordingsRepo(db);
}

test('create + get round-trips a recording', () => {
  const repo = freshRepo();
  repo.create({ id: 'abc', channel_name: 'Ch5', programme_title: 'Movie',
    mode: 'duration', status: 'recording', staging_path: '/staging/abc.ts', save_path: '/recordings/Movie.ts' });
  const row = repo.get('abc');
  assert.strictEqual(row.channel_name, 'Ch5');
  assert.strictEqual(row.status, 'recording');
});

test('countActive counts recording + moving + pending-move', () => {
  const repo = freshRepo();
  repo.create({ id: '1', channel_name: 'A', mode: 'manual', status: 'recording', staging_path: '/s/1.ts', save_path: '/r/1.ts' });
  repo.create({ id: '2', channel_name: 'B', mode: 'manual', status: 'pending-move', staging_path: '/s/2.ts', save_path: '/r/2.ts' });
  repo.create({ id: '3', channel_name: 'C', mode: 'manual', status: 'done', staging_path: '/s/3.ts', save_path: '/r/3.ts' });
  assert.strictEqual(repo.countActive(), 2);
});

test('setState updates status and extra fields', () => {
  const repo = freshRepo();
  repo.create({ id: 'x', channel_name: 'A', mode: 'manual', status: 'recording', staging_path: '/s/x.ts', save_path: '/r/x.ts' });
  repo.setState('x', 'error', { error: 'boom' });
  const row = repo.get('x');
  assert.strictEqual(row.status, 'error');
  assert.strictEqual(row.error, 'boom');
});

test('listByState filters', () => {
  const repo = freshRepo();
  repo.create({ id: 'p', channel_name: 'A', mode: 'manual', status: 'pending-move', staging_path: '/s/p.ts', save_path: '/r/p.ts' });
  assert.strictEqual(repo.listByState('pending-move').length, 1);
  assert.strictEqual(repo.listByState('done').length, 0);
});

test('create + get round-trips channel identity fields', () => {
  const repo = freshRepo();
  repo.create({
    id: 'ch1', channel_name: 'SkyNews', mode: 'manual', status: 'recording',
    staging_path: '/s/ch1.ts', save_path: '/r/ch1.ts',
    channel_id: 'xtream_3_456', source_id: '3', source_type: 'xtream', stream_id: '456',
  });
  const row = repo.get('ch1');
  assert.strictEqual(row.channel_id, 'xtream_3_456');
  assert.strictEqual(row.source_id, '3');
  assert.strictEqual(row.source_type, 'xtream');
  assert.strictEqual(row.stream_id, '456');
});

test('create defaults channel identity fields to null when absent', () => {
  const repo = freshRepo();
  repo.create({ id: 'n1', channel_name: 'A', mode: 'manual', status: 'recording', staging_path: '/s/n1.ts', save_path: '/r/n1.ts' });
  const row = repo.get('n1');
  assert.strictEqual(row.channel_id, null);
  assert.strictEqual(row.source_id, null);
  assert.strictEqual(row.source_type, null);
  assert.strictEqual(row.stream_id, null);
});

test('setPaths updates only the provided path columns', () => {
  const repo = freshRepo();
  repo.create({ id: 'sp1', channel_name: 'A', mode: 'manual', status: 'recording',
    staging_path: '/staging/sp1.ts', save_path: '/recordings/A.mkv' });

  // Update staging_path only; save_path must stay unchanged.
  repo.setPaths('sp1', { staging_path: '/staging/sp1.mkv' });
  let row = repo.get('sp1');
  assert.strictEqual(row.staging_path, '/staging/sp1.mkv');
  assert.strictEqual(row.save_path, '/recordings/A.mkv');

  // Update save_path only; staging_path must stay unchanged.
  repo.setPaths('sp1', { save_path: '/recordings/A.ts' });
  row = repo.get('sp1');
  assert.strictEqual(row.staging_path, '/staging/sp1.mkv');
  assert.strictEqual(row.save_path, '/recordings/A.ts');
});
