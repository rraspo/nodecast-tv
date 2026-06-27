const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const Database = require('better-sqlite3');
const { RECORDINGS_DDL, createRecordingsRepo } = require('../db/recordings');
const { isMounted, moveFile, createMover } = require('./recordMover');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')); }

test('isMounted: false for a plain subdir (same device as parent)', async () => {
  const dir = tmp();
  const sub = path.join(dir, 'recordings');
  await fsp.mkdir(sub);
  assert.strictEqual(await isMounted(sub), false);
});

test('isMounted: false for missing path', async () => {
  assert.strictEqual(await isMounted('/no/such/path/here'), false);
});

test('moveFile copies content then removes source', async () => {
  const dir = tmp();
  const src = path.join(dir, 'a.ts');
  const dest = path.join(dir, 'out', 'b.ts');
  await fsp.writeFile(src, 'DATA');
  await moveFile(src, dest);
  assert.strictEqual(await fsp.readFile(dest, 'utf8'), 'DATA');
  assert.strictEqual(fs.existsSync(src), false);
});

test('mover: healthy dest -> done', async () => {
  const dir = tmp();
  const staging = path.join(dir, 's.ts');
  await fsp.writeFile(staging, 'X');
  const db = new Database(':memory:'); db.exec(RECORDINGS_DDL);
  const repo = createRecordingsRepo(db);
  repo.create({ id: 'm1', channel_name: 'A', mode: 'manual', status: 'recording',
    staging_path: staging, save_path: path.join(dir, 'dest', 'A.ts') });
  const mover = createMover({ repo, config: {}, isMountedFn: async () => true });
  await mover.enqueue('m1');
  assert.strictEqual(repo.get('m1').status, 'done');
  assert.ok(fs.existsSync(path.join(dir, 'dest', 'A.ts')));
});

test('mover: unhealthy dest -> pending-move, retried when healthy', async () => {
  const dir = tmp();
  const staging = path.join(dir, 's2.ts');
  await fsp.writeFile(staging, 'Y');
  const db = new Database(':memory:'); db.exec(RECORDINGS_DDL);
  const repo = createRecordingsRepo(db);
  repo.create({ id: 'm2', channel_name: 'B', mode: 'manual', status: 'recording',
    staging_path: staging, save_path: path.join(dir, 'dest', 'B.ts') });
  let healthy = false;
  const mover = createMover({ repo, config: {}, isMountedFn: async () => healthy });
  await mover.enqueue('m2');
  assert.strictEqual(repo.get('m2').status, 'pending-move');
  healthy = true;
  await mover.processPending();
  assert.strictEqual(repo.get('m2').status, 'done');
});
