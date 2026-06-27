const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const EventEmitter = require('events');

const sessions = new Map();

function sanitizeFilename(name) {
  const clean = String(name || '')
    .replace(/[\/\\:*?"<>|]/g, '-')   // illegal chars -> dash
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')              // collapse multiple dashes
    .trim()
    .replace(/-+$/, '')               // remove trailing dashes
    .trim();                          // trim again to remove trailing spaces
  return clean || 'recording';
}

function computeDurationSec({ mode, durationMin, epgEndMs, nowMs = Date.now(), postPadMin = 0 }) {
  if (mode === 'manual') return null;
  if (mode === 'duration') return Math.max(1, Math.round(durationMin * 60));
  if (mode === 'program') {
    const sec = Math.round((epgEndMs - nowMs) / 1000) + postPadMin * 60;
    return Math.max(1, sec);
  }
  return null;
}

function buildRecordArgs({ url, userAgent, durationSec, outputPath }) {
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-user_agent', userAgent || 'Mozilla/5.0',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '3',
    '-fflags', '+genpts+discardcorrupt', '-err_detect', 'ignore_err',
    '-i', url,
  ];
  if (durationSec != null) args.push('-t', String(durationSec));
  args.push('-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-f', 'mpegts', outputPath);
  return args;
}

class RecordSession extends EventEmitter {
  constructor({ url, userAgent, durationSec, stagingDir, fileBase, ffmpegPath }) {
    super();
    this.id = crypto.randomBytes(8).toString('hex');
    this.url = url;
    this.userAgent = userAgent;
    this.durationSec = durationSec;
    this.ffmpegPath = ffmpegPath || 'ffmpeg';
    this.stagingPath = path.join(stagingDir, `${this.id}.ts`);
    this.fileBase = sanitizeFilename(fileBase);
    this.status = 'pending';
    this.error = null;
    this.process = null;
    this._stopTimer = null;
    this.stderrTail = '';
  }

  // Keep a rolling tail of ffmpeg stderr so a failed capture can report the real reason
  // (403, codec error, etc.) instead of just "ffmpeg exited N".
  _appendStderr(text) {
    this.stderrTail = (this.stderrTail + text).slice(-4000);
  }

  async start() {
    await fs.mkdir(path.dirname(this.stagingPath), { recursive: true });
    const args = buildRecordArgs({
      url: this.url, userAgent: this.userAgent,
      durationSec: this.durationSec, outputPath: this.stagingPath,
    });
    this.process = spawn(this.ffmpegPath, args, { windowsHide: true });
    this.status = 'recording';
    this.process.stderr.on('data', (d) => {
      const text = d.toString();
      this._appendStderr(text);
      console.log(`[Record ${this.id}] ${text}`.trim());
    });
    this.process.on('error', (err) => {
      this.status = 'error'; this.error = err.message; this.emit('error', err);
    });
    this.process.on('exit', (code) => {
      if (code === 0 || code === null || code === 255) this.status = 'stopped';
      else {
        this.status = 'error';
        const tail = this.stderrTail.trim();
        this.error = tail ? `ffmpeg exited ${code}\n${tail}` : `ffmpeg exited ${code}`;
      }
      this.process = null;
      this.emit('exit', code);
    });
  }

  scheduleStop(atMs) {
    this.cancelScheduledStop();
    const delay = Math.max(0, atMs - Date.now());
    this._stopTimer = setTimeout(() => this.stop(), delay);
    this._stopTimer.unref();
  }

  cancelScheduledStop() {
    if (this._stopTimer) {
      clearTimeout(this._stopTimer);
      this._stopTimer = null;
    }
  }

  stop() {
    this.cancelScheduledStop();
    if (this.process) {
      this.process.kill('SIGTERM');
      setTimeout(() => { if (this.process) this.process.kill('SIGKILL'); }, 2000);
    }
    this.status = 'stopped';
  }
}

function createRecordSession(opts) {
  const s = new RecordSession(opts);
  sessions.set(s.id, s);
  return s;
}
const getSession = (id) => sessions.get(id);
const getAllSessions = () => Array.from(sessions.values());
const removeSession = (id) => sessions.delete(id);

module.exports = {
  RecordSession, createRecordSession, getSession, getAllSessions, removeSession,
  sanitizeFilename, computeDurationSec, buildRecordArgs,
};
