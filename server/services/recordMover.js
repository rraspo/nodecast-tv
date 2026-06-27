const fsp = require('fs').promises;
const path = require('path');

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

function createMover({ repo, config, intervalMs = 30000, isMountedFn = isMounted, moveFileFn = moveFile }) {
  let timer = null;

  async function attempt(row) {
    if (!row) return;
    repo.setState(row.id, 'moving');
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
