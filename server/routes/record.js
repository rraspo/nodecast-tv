const express = require('express');
const path = require('path');
const fsp = require('fs').promises;
const router = express.Router();

const auth = require('../auth');
const db = require('../db');
const { recordConfig } = require('../recordConfig');
const dbSqlite = require('../db/sqlite');
const recordSvc = require('../services/recordSession');
const { createMover } = require('../services/recordMover');
const recordFinalize = require('../services/recordFinalize');

// Ids currently being remuxed in place (.ts -> .mkv) by the remux/remux-all actions,
// plus their 0-100 progress. Surfaced on GET /record so the UI can show a progress bar.
const remuxing = new Set();
const remuxProgress = new Map();

// Remux one finished .ts recording to .mkv in place on the save path (kepler mount),
// probe its duration, update the row, and delete the original .ts. Best-effort: logs
// and leaves the .ts untouched on failure so nothing is lost.
async function remuxOne(id, ffmpegPath) {
  const repo = dbSqlite.recordings;
  const row = repo.get(id);
  if (!recordFinalize.isUnremuxed(row) || remuxing.has(id)) return;
  remuxing.add(id);
  remuxProgress.set(id, 0);
  try {
    const dest = recordFinalize.mkvPathFor(row.save_path);
    const totalMs = await recordFinalize.probeDurationMs({ file: row.save_path }).catch(() => null);
    await recordFinalize.remuxToMkv({
      ffmpegPath, src: row.save_path, dest,
      onProgress: (ms) => { if (totalMs) remuxProgress.set(id, Math.min(99, Math.round(ms / totalMs * 100))); },
    });
    const ms = await recordFinalize.probeDurationMs({ file: dest }).catch(() => null);
    repo.setPaths(id, { save_path: dest });
    if (ms) repo.setDuration(id, ms);
    await fsp.unlink(row.save_path).catch(() => {});
  } catch (err) {
    console.error(`[remux] failed for ${id}: ${err.message}`);
  } finally {
    remuxing.delete(id);
    remuxProgress.delete(id);
  }
}

const VALID_MODES = ['program', 'duration', 'manual'];

// Pure helper: a session status of 'error' means ffmpeg crashed (not a manual stop or clean
// duration finish). Used in the exit handler to decide move-vs-discard.
function shouldMove(sessionStatus) {
  return sessionStatus !== 'error';
}

// Pure helper: validate and clamp a scheduled-stop epoch ms value.
// Returns { ok: false } for non-finite input.
// Past timestamps resolve to nowMs (stop immediately).
// Future timestamps beyond maxMs are clamped to nowMs + maxMs.
function clampStopAt(stopAtMs, nowMs, maxMs = 24 * 60 * 60 * 1000) {
  if (!Number.isFinite(stopAtMs)) return { ok: false };
  if (stopAtMs <= nowMs) return { ok: true, stopAtMs: nowMs };
  if (stopAtMs - nowMs > maxMs) return { ok: true, stopAtMs: nowMs + maxMs };
  return { ok: true, stopAtMs };
}

function canStart(repo, config) {
  if (repo.countActive() >= config.maxConcurrent) return { ok: false, reason: 'max-concurrent' };
  return { ok: true };
}

function formatStamp(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function resolveStart(body, config = recordConfig, nowMs = Date.now()) {
  const { url, channelName, mode, durationMin, epgEndMs, programmeTitle } = body || {};
  if (!url || !VALID_MODES.includes(mode)) return { ok: false };
  if (mode === 'program' && !Number.isFinite(epgEndMs)) return { ok: false };
  const fileBase = mode === 'program' ? (programmeTitle || channelName) : channelName;
  const durationSec = recordSvc.computeDurationSec({
    mode,
    durationMin: durationMin || config.defaultDurationMin,
    epgEndMs, nowMs, postPadMin: config.epgPostPadMin,
  });
  return { ok: true, value: { url, fileBase: fileBase || 'recording', mode, durationSec, programmeTitle: programmeTitle || null } };
}

// Mover is created lazily so the repo (and thus DB) is only touched at runtime, not on require.
let mover = null;
function getMover() {
  if (!mover) {
    mover = createMover({ repo: dbSqlite.recordings, config: recordConfig });
    mover.start();
    // Safety reaper: backstop for any scheduled stop whose setTimeout was lost (e.g. restart).
    // Scans live sessions every 30s; if the persisted stop_at is due, calls session.stop().
    const reaper = setInterval(() => {
      const now = Date.now();
      for (const session of recordSvc.getAllSessions()) {
        const row = dbSqlite.recordings.get(session.id);
        if (row && row.stop_at && row.stop_at <= now) {
          session.stop();
        }
      }
    }, 30000);
    reaper.unref();
  }
  return mover;
}

router.get('/', auth.requireAuth, (req, res) => {
  const rows = dbSqlite.recordings.list().map(r => ({
    ...r,
    remuxing: remuxing.has(r.id),
    remux_progress: remuxProgress.has(r.id) ? remuxProgress.get(r.id) : null,
  }));
  res.json(rows);
});

// Clear a finished recording from nodecast's tracking. Removes the DB row only —
// the file on disk is left in place (the recording lives on the NAS now).
router.post('/:id/clear', auth.requireAuth, (req, res) => {
  const repo = dbSqlite.recordings;
  const row = repo.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Recording not found' });
  if (['recording', 'moving', 'pending-move'].includes(row.status)) {
    return res.status(409).json({ error: 'Recording is still in progress' });
  }
  repo.remove(row.id);
  res.json({ ok: true });
});

// Clear all finished, remuxed (.mkv) recordings from tracking. Files are kept.
router.post('/clear-remuxed', auth.requireAuth, (req, res) => {
  const repo = dbSqlite.recordings;
  const done = repo.list().filter(r => r.status === 'done' && String(r.save_path || '').endsWith('.mkv'));
  for (const r of done) repo.remove(r.id);
  res.json({ ok: true, cleared: done.length });
});

// Recursively list files under a directory (best-effort; returns [] on any error).
async function walkFiles(dir) {
  const out = [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walkFiles(full));
    else out.push(full);
  }
  return out;
}

// Browse the recordings root for the Locate file picker. Constrained to savePath
// (no path traversal): returns directories and files for the requested dir.
router.get('/browse', auth.requireAuth, async (req, res) => {
  const root = path.resolve(recordConfig.savePath);
  const dir = req.query.dir ? path.resolve(req.query.dir) : root;
  if (!recordFinalize.isWithinRoot(root, dir)) return res.status(400).json({ error: 'Path outside recordings root' });
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return res.status(404).json({ error: 'Cannot read directory' }); }
  const items = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { items.push({ name: e.name, path: full, type: 'dir' }); }
    else if (e.isFile()) {
      const size = await fsp.stat(full).then(s => s.size).catch(() => null);
      items.push({ name: e.name, path: full, type: 'file', size });
    }
  }
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)));
  res.json({ root, dir, parent: dir === root ? null : path.dirname(dir), entries: items });
});

// Manually re-point a recording at a file the user selected in the picker.
router.post('/:id/relocate', auth.requireAuth, async (req, res) => {
  const repo = dbSqlite.recordings;
  const row = repo.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Recording not found' });
  const root = path.resolve(recordConfig.savePath);
  const target = req.body && req.body.path ? path.resolve(req.body.path) : null;
  if (!target || !recordFinalize.isWithinRoot(root, target)) return res.status(400).json({ error: 'Invalid path' });
  const isFile = await fsp.stat(target).then(s => s.isFile()).catch(() => false);
  if (!isFile) return res.status(400).json({ error: 'Not a file' });
  repo.setPaths(row.id, { save_path: target });
  res.json({ ok: true, save_path: target });
});

// Scan finished recordings and report which save_path files no longer exist on disk
// (e.g. moved/renamed/deleted outside the app).
router.post('/scan', auth.requireAuth, async (req, res) => {
  const rows = dbSqlite.recordings.list().filter(r => r.status === 'done');
  const results = [];
  for (const r of rows) {
    const exists = await fsp.access(r.save_path).then(() => true).catch(() => false);
    results.push({ id: r.id, exists });
  }
  res.json({ results, missing: results.filter(x => !x.exists).map(x => x.id) });
});

// Try to relocate a recording whose file went stale: search the save root for a file
// with the same basename stem (preferring .mkv) and repoint save_path to it.
router.post('/:id/locate', auth.requireAuth, async (req, res) => {
  const repo = dbSqlite.recordings;
  const row = repo.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Recording not found' });
  if (await fsp.access(row.save_path).then(() => true).catch(() => false)) {
    return res.json({ found: true, save_path: row.save_path, unchanged: true });
  }
  const stem = recordFinalize.recordingStem(row.save_path);
  const files = await walkFiles(recordConfig.savePath);
  const match = recordFinalize.pickRelocated(stem, files);
  if (!match) return res.json({ found: false });
  repo.setPaths(row.id, { save_path: match });
  res.json({ found: true, save_path: match });
});

// Remux all finished .ts recordings to .mkv in place. Runs in the background
// (sequential, NFS-bound); the client polls GET /record to see rows convert.
router.post('/remux-all', auth.requireAuth, (req, res) => {
  const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';
  const eligible = dbSqlite.recordings.list().filter(recordFinalize.isUnremuxed);
  (async () => { for (const r of eligible) await remuxOne(r.id, ffmpegPath); })().catch(console.error);
  res.status(202).json({ started: true, count: eligible.length });
});

router.post('/start', auth.requireAuth, async (req, res) => {
  let session = null;
  try {
    const repo = dbSqlite.recordings;
    // Critical section: canStart -> resolveStart -> createRecordSession -> repo.create is fully
    // synchronous (better-sqlite3 is sync; no await until session.start()), so the max-concurrent
    // gate is race-free and would break if the data layer became async.
    const gate = canStart(repo, recordConfig);
    if (!gate.ok) return res.status(409).json({ error: 'Max concurrent recordings reached', reason: gate.reason });

    const parsed = resolveStart(req.body, recordConfig);
    if (!parsed.ok) return res.status(400).json({ error: 'url and a valid mode (program|duration|manual) are required' });

    // Use the user's configured User-Agent (same as the transcode/remux playback paths).
    // Providers 403 a generic UA, so recording must match what playback sends.
    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);

    session = recordSvc.createRecordSession({
      url: parsed.value.url,
      userAgent,
      durationSec: parsed.value.durationSec,
      stagingDir: recordConfig.stagingPath,
      fileBase: parsed.value.fileBase,
      ffmpegPath: req.app.locals.ffmpegPath || 'ffmpeg',
    });

    const stamp = formatStamp(new Date());
    const savePath = path.join(recordConfig.savePath, `${session.fileBase} - ${stamp}.mkv`);
    repo.create({
      id: session.id, channel_name: req.body.channelName || parsed.value.fileBase,
      programme_title: parsed.value.programmeTitle, mode: parsed.value.mode,
      status: 'recording', staging_path: session.stagingPath, save_path: savePath,
      channel_id: req.body.channelId || null,
      source_id: req.body.sourceId != null ? String(req.body.sourceId) : null,
      source_type: req.body.sourceType || null,
      stream_id: req.body.streamId != null ? String(req.body.streamId) : null,
    });

    session.on('exit', () => {
      // Fix #4: only enqueue a move when the capture succeeded. A crashed capture (ffmpeg
      // exited with a non-zero, non-255 code) produces a partial/unusable file; mark it
      // 'error', delete the staging file (best-effort), and skip the move.
      // Manual stop and duration auto-stop both land on status 'stopped' and are SUCCESSES —
      // their partial/complete .ts is the intended output and must be moved normally.
      if (!shouldMove(session.status)) {
        repo.setState(session.id, 'error', { error: session.error || 'ffmpeg capture failed' });
        // Remove unusable partial staging file (best-effort; ignore ENOENT if ffmpeg never
        // created it). NOTE: do NOT delete staging files on a move error — a move-error file
        // is a complete recording where only the destination write failed (e.g. disk full);
        // deleting it would be data loss. Move-error files are retained for manual recovery.
        fsp.unlink(session.stagingPath).catch(() => {});
        recordSvc.removeSession(session.id);
        return;
      }
      repo.setState(session.id, 'moving');
      getMover().enqueue(session.id).catch(console.error);
      recordSvc.removeSession(session.id);
    });
    session.on('error', (err) => {
      // Fix #5a: remove the in-memory session on spawn failure so it does not leak.
      repo.setState(session.id, 'error', { error: err.message });
      recordSvc.removeSession(session.id);
    });

    await session.start();
    res.status(201).json({ id: session.id });
  } catch (err) {
    if (session) recordSvc.removeSession(session.id);
    console.error('Error starting recording:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/schedule-stop', auth.requireAuth, (req, res) => {
  const { id } = req.params;
  const session = recordSvc.getSession(id);
  if (!session) return res.status(404).json({ error: 'No active recording session' });

  const repo = dbSqlite.recordings;
  const { stopAtMs } = req.body;

  // null -> cancel any existing schedule
  if (stopAtMs === null) {
    session.cancelScheduledStop();
    repo.setStopAt(id, null);
    return res.json({ canceled: true });
  }

  const now = Date.now();
  const clamped = clampStopAt(stopAtMs, now);
  if (!clamped.ok) return res.status(400).json({ error: 'stopAtMs must be a finite number' });

  if (clamped.stopAtMs <= now) {
    session.stop();
    repo.setStopAt(id, null);
    return res.json({ stopped: true });
  }

  session.scheduleStop(clamped.stopAtMs);
  repo.setStopAt(id, clamped.stopAtMs);
  return res.json({ stopAtMs: clamped.stopAtMs });
});

// Remux a single finished .ts recording to .mkv in place (background).
router.post('/:id/remux', auth.requireAuth, (req, res) => {
  const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';
  const row = dbSqlite.recordings.get(req.params.id);
  if (!recordFinalize.isUnremuxed(row)) return res.status(400).json({ error: 'Not an unremuxed recording' });
  if (remuxing.has(row.id)) return res.status(409).json({ error: 'Already remuxing' });
  remuxOne(row.id, ffmpegPath).catch(console.error);
  res.status(202).json({ started: true });
});

router.delete('/:id', auth.requireAuth, (req, res) => {
  const session = recordSvc.getSession(req.params.id);
  if (session) session.stop();
  dbSqlite.recordings.setStopAt(req.params.id, null);
  res.json({ ok: true });
});

module.exports = router;
module.exports.canStart = canStart;
module.exports.resolveStart = resolveStart;
module.exports.getMover = getMover;
module.exports.shouldMove = shouldMove;
module.exports.clampStopAt = clampStopAt;
