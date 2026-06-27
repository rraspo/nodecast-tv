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

const VALID_MODES = ['program', 'duration', 'manual'];

// Pure helper: a session status of 'error' means ffmpeg crashed (not a manual stop or clean
// duration finish). Used in the exit handler to decide move-vs-discard.
function shouldMove(sessionStatus) {
  return sessionStatus !== 'error';
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
  if (!mover) { mover = createMover({ repo: dbSqlite.recordings, config: recordConfig }); mover.start(); }
  return mover;
}

router.get('/', auth.requireAuth, (req, res) => {
  res.json(dbSqlite.recordings.list());
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
    const savePath = path.join(recordConfig.savePath, `${session.fileBase} - ${stamp}.ts`);
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

router.delete('/:id', auth.requireAuth, (req, res) => {
  const session = recordSvc.getSession(req.params.id);
  if (session) session.stop();
  res.json({ ok: true });
});

module.exports = router;
module.exports.canStart = canStart;
module.exports.resolveStart = resolveStart;
module.exports.getMover = getMover;
module.exports.shouldMove = shouldMove;
