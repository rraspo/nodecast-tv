const express = require('express');
const path = require('path');
const router = express.Router();

const auth = require('../auth');
const { recordConfig } = require('../recordConfig');
const dbSqlite = require('../db/sqlite');
const recordSvc = require('../services/recordSession');
const { createMover } = require('../services/recordMover');

const VALID_MODES = ['program', 'duration', 'manual'];

function canStart(repo, config) {
  if (repo.countActive() >= config.maxConcurrent) return { ok: false, reason: 'max-concurrent' };
  return { ok: true };
}

function resolveStart(body, config = recordConfig, nowMs = Date.now()) {
  const { url, channelName, mode, durationMin, epgEndMs, programmeTitle } = body || {};
  if (!url || !VALID_MODES.includes(mode)) return { ok: false };
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
  try {
    const repo = dbSqlite.recordings;
    const gate = canStart(repo, recordConfig);
    if (!gate.ok) return res.status(409).json({ error: 'Max concurrent recordings reached', reason: gate.reason });

    const parsed = resolveStart(req.body, recordConfig);
    if (!parsed.ok) return res.status(400).json({ error: 'url and a valid mode (program|duration|manual) are required' });

    const session = recordSvc.createRecordSession({
      url: parsed.value.url,
      userAgent: 'Mozilla/5.0',
      durationSec: parsed.value.durationSec,
      stagingDir: recordConfig.stagingPath,
      fileBase: parsed.value.fileBase,
      ffmpegPath: req.app.locals.ffmpegPath || 'ffmpeg',
    });

    const savePath = path.join(recordConfig.savePath, `${session.fileBase}.ts`);
    repo.create({
      id: session.id, channel_name: req.body.channelName || parsed.value.fileBase,
      programme_title: parsed.value.programmeTitle, mode: parsed.value.mode,
      status: 'recording', staging_path: session.stagingPath, save_path: savePath,
    });

    session.on('exit', () => {
      repo.setState(session.id, 'moving');
      getMover().enqueue(session.id).catch(console.error);
      recordSvc.removeSession(session.id);
    });
    session.on('error', (err) => repo.setState(session.id, 'error', { error: err.message }));

    await session.start();
    res.status(201).json({ id: session.id });
  } catch (err) {
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
