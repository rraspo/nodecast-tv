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

test('mover stores duration_ms via probeFn when probe succeeds', async () => {
  const dir = tmp();
  const staging = path.join(dir, 's3.ts');
  await fsp.writeFile(staging, 'Z');
  const db = new Database(':memory:'); db.exec(RECORDINGS_DDL);
  const repo = createRecordingsRepo(db);
  repo.create({ id: 'm3', channel_name: 'C', mode: 'manual', status: 'recording',
    staging_path: staging, save_path: path.join(dir, 'dest', 'C.ts') });
  const probeFn = async () => 42000;
  const mover = createMover({ repo, config: {}, isMountedFn: async () => true, probeFn });
  await mover.enqueue('m3');
  assert.strictEqual(repo.get('m3').status, 'done');
  assert.strictEqual(repo.get('m3').duration_ms, 42000);
});

test('mover skips duration when probeFn returns null', async () => {
  const dir = tmp();
  const staging = path.join(dir, 's4.ts');
  await fsp.writeFile(staging, 'W');
  const db = new Database(':memory:'); db.exec(RECORDINGS_DDL);
  const repo = createRecordingsRepo(db);
  repo.create({ id: 'm4', channel_name: 'D', mode: 'manual', status: 'recording',
    staging_path: staging, save_path: path.join(dir, 'dest', 'D.ts') });
  const probeFn = async () => null;
  const mover = createMover({ repo, config: {}, isMountedFn: async () => true, probeFn });
  await mover.enqueue('m4');
  assert.strictEqual(repo.get('m4').status, 'done');
  assert.strictEqual(repo.get('m4').duration_ms, null);
});

// --- finalize (remux) tests ---

test('mover finalize: .ts staging + .mkv save -> remux called, .ts removed, .mkv moved to dest', async () => {
  const dir = tmp();
  const stagingTs = path.join(dir, 'rec.ts');
  const stagingMkv = path.join(dir, 'rec.mkv');
  const destMkv = path.join(dir, 'dest', 'Movie.mkv');
  await fsp.writeFile(stagingTs, 'TS');
  const db = new Database(':memory:'); db.exec(RECORDINGS_DDL);
  const repo = createRecordingsRepo(db);
  repo.create({ id: 'f1', channel_name: 'A', mode: 'manual', status: 'recording',
    staging_path: stagingTs, save_path: destMkv });

  let remuxCalled = false;
  const remuxFn = async ({ src, dest }) => {
    remuxCalled = true;
    assert.strictEqual(src, stagingTs);
    assert.strictEqual(dest, stagingMkv);
    await fsp.writeFile(dest, 'MKV');
  };
  const mkvPathForFn = (p) => p.replace(/\.ts$/, '.mkv');

  const mover = createMover({ repo, config: {}, isMountedFn: async () => true, remuxFn, mkvPathForFn });
  await mover.enqueue('f1');

  assert.ok(remuxCalled, 'remux must be called');
  assert.strictEqual(repo.get('f1').status, 'done');
  assert.strictEqual(fs.existsSync(stagingTs), false, '.ts source must be deleted');
  assert.ok(fs.existsSync(destMkv), '.mkv must exist at save path');
  assert.ok(repo.get('f1').staging_path.endsWith('.mkv'), 'staging_path updated to .mkv in DB');
});

test('mover finalize: remux failure -> fallback to .ts delivery, status done', async () => {
  const dir = tmp();
  const stagingTs = path.join(dir, 'rec.ts');
  const destMkv = path.join(dir, 'dest', 'Movie.mkv');
  const destTs = path.join(dir, 'dest', 'Movie.ts');
  await fsp.writeFile(stagingTs, 'TS');
  const db = new Database(':memory:'); db.exec(RECORDINGS_DDL);
  const repo = createRecordingsRepo(db);
  repo.create({ id: 'f2', channel_name: 'A', mode: 'manual', status: 'recording',
    staging_path: stagingTs, save_path: destMkv });

  const remuxFn = async () => { throw new Error('codec error'); };
  const mkvPathForFn = (p) => p.replace(/\.ts$/, '.mkv');

  const mover = createMover({ repo, config: {}, isMountedFn: async () => true, remuxFn, mkvPathForFn });
  await mover.enqueue('f2');

  assert.strictEqual(repo.get('f2').status, 'done');
  assert.strictEqual(repo.get('f2').save_path, destTs, 'save_path switched to .ts fallback');
  assert.strictEqual(fs.existsSync(stagingTs), false, '.ts moved away from staging');
  assert.ok(fs.existsSync(destTs), 'original .ts delivered to dest');
  assert.strictEqual(fs.existsSync(destMkv), false, 'no .mkv at dest (remux failed)');
});

test('mover finalize: staging already .mkv -> remux skipped, just moved', async () => {
  const dir = tmp();
  const stagingMkv = path.join(dir, 'rec.mkv');
  const destMkv = path.join(dir, 'dest', 'Movie.mkv');
  await fsp.writeFile(stagingMkv, 'MKV');
  const db = new Database(':memory:'); db.exec(RECORDINGS_DDL);
  const repo = createRecordingsRepo(db);
  repo.create({ id: 'f3', channel_name: 'A', mode: 'manual', status: 'recording',
    staging_path: stagingMkv, save_path: destMkv });

  let remuxCalled = false;
  const remuxFn = async () => { remuxCalled = true; };
  const mkvPathForFn = (p) => p.replace(/\.ts$/, '.mkv');

  const mover = createMover({ repo, config: {}, isMountedFn: async () => true, remuxFn, mkvPathForFn });
  await mover.enqueue('f3');

  assert.strictEqual(remuxCalled, false, 'remux must NOT be called when staging is already .mkv');
  assert.strictEqual(repo.get('f3').status, 'done');
  assert.ok(fs.existsSync(destMkv));
});
