'use strict';

const fsp = require('fs').promises;
const path = require('path');
const recordFinalize = require('./recordFinalize');

async function isMounted(mountPath) {
  try {
    const here = await fsp.stat(mountPath);
    const parent = await fsp.stat(path.dirname(mountPath));
    return here.dev !== parent.dev;
  } catch {
    return false;
  }
}

async function moveFile(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  // staging (local) and dest (NFS) are different devices -> rename would EXDEV; copy+unlink.
  await fsp.copyFile(src, dest);
  await fsp.unlink(src);
}

function createMover({
  repo,
  config,
  intervalMs = 30000,
  isMountedFn = isMounted,
  moveFileFn = moveFile,
  remuxFn = recordFinalize.remuxToMkv,
  mkvPathForFn = recordFinalize.mkvPathFor,
}) {
  let timer = null;

  async function attempt(row) {
    if (!row) return;
    repo.setState(row.id, 'moving');

    // Finalize: if the destination is .mkv but staging is still .ts, remux first.
    // Idempotent: if staging_path already ends .mkv (retry/restart), skip remux.
    if (row.save_path.endsWith('.mkv') && row.staging_path.endsWith('.ts')) {
      const mkv = mkvPathForFn(row.staging_path);
      try {
        await remuxFn({ src: row.staging_path, dest: mkv });
        // Success — persist staging_path to DB first, then delete the source .ts (best-effort).
        // This ordering ensures crash safety: if process dies between setPaths and unlink,
        // the next attempt sees staging_path = .mkv (idempotent retry skips remux);
        // if it dies before setPaths, the row re-queues and remuxes the .ts again (no data loss).
        const tsToDelete = row.staging_path;
        repo.setPaths(row.id, { staging_path: mkv });
        row.staging_path = mkv;
        await fsp.unlink(tsToDelete).catch(() => {});
      } catch (err) {
        // DATA-SAFE FALLBACK: remux failed. Keep the .ts and deliver it instead.
        // The recording is not lost — we fall through to move the original .ts file.
        console.warn(`[recordMover] remux failed for ${row.id}, falling back to .ts delivery: ${err.message}`);
        const tsSave = row.save_path.replace(/\.mkv$/, '.ts');
        repo.setPaths(row.id, { save_path: tsSave });
        row.save_path = tsSave;
      }
    }

    if (!(await isMountedFn(path.dirname(row.save_path)))) {
      repo.setState(row.id, 'pending-move');
      return;
    }
    try {
      await moveFileFn(row.staging_path, row.save_path);
      repo.setState(row.id, 'done', { ended_at: new Date().toISOString() });
    } catch (err) {
      repo.setState(row.id, 'error', { error: err.message });
    }
  }

  return {
    isMounted: isMountedFn,
    async enqueue(id) { await attempt(repo.get(id)); },
    async processPending() {
      for (const row of repo.listByState('pending-move')) await attempt(row);
    },
    start() {
      if (!timer) { timer = setInterval(() => this.processPending().catch(console.error), intervalMs); timer.unref(); }
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

module.exports = { isMounted, moveFile, createMover };
