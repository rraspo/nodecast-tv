'use strict';

const { spawn } = require('child_process');

/**
 * Returns the same path with the extension swapped from .ts to .mkv.
 * Pure function — no I/O.
 *
 * @param {string} tsPath - Input path assumed to end with `.ts`. Returns the path unchanged if it does not.
 * @returns {string} Path with extension replaced.
 */
function mkvPathFor(tsPath) {
  return tsPath.replace(/\.ts$/, '.mkv');
}

/**
 * Returns the argv array for an ffmpeg remux: copy all streams (v/a/s),
 * no re-encode, tolerates streams that may be absent (? suffix).
 * Pure function — no I/O.
 */
function buildRemuxArgs({ src, dest }) {
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-i', src,
    '-map', '0:v?',
    '-map', '0:a?',
    '-map', '0:s?',
    '-c', 'copy',
    dest,
  ];
}

/**
 * Spawns ffmpeg to remux src (.ts) to dest (.mkv) without re-encoding.
 * Resolves on exit code 0; rejects with the stderr tail otherwise.
 *
 * **Data-safety model:** Trusts ffmpeg exit code 0 as indicator of success.
 * Does not verify the destination file size or stream presence post-completion;
 * for `-c copy` IPTV remux, ffmpeg exits non-zero on meaningful failures (corrupt input,
 * missing ffmpeg binary, output filesystem full). This is sufficient for the remux contract.
 *
 * @param {Object} params - Configuration object.
 * @param {string} [params.ffmpegPath='ffmpeg'] - Path to the ffmpeg binary.
 * @param {string} params.src - Source .ts file path.
 * @param {string} params.dest - Destination .mkv file path.
 * @returns {Promise<void>} Resolves on successful remux (exit 0).
 * @throws {Error} Rejects with ffmpeg stderr tail if exit code is non-zero.
 */
function remuxToMkv({ ffmpegPath = 'ffmpeg', src, dest }) {
  return new Promise((resolve, reject) => {
    const args = buildRemuxArgs({ src, dest });
    const proc = spawn(ffmpegPath, args);
    const stderrChunks = [];
    proc.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const tail = Buffer.concat(stderrChunks).toString('utf8').slice(-500);
        reject(new Error(`ffmpeg remux exited ${code}: ${tail}`));
      }
    });
    proc.on('error', reject);
  });
}

/**
 * Returns the ffprobe argv for probing the media duration of a file.
 * Pure function — no I/O.
 *
 * @param {string} file - Path to the media file.
 * @returns {string[]} Argument array for ffprobe.
 */
function buildProbeArgs(file) {
  return ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file];
}

/**
 * Parses the stdout from ffprobe (a float-seconds string) into milliseconds.
 * Pure function — no I/O.
 *
 * @param {string} stdout - Raw stdout from ffprobe.
 * @returns {number|null} Rounded milliseconds, or null if unparseable/N/A/zero.
 */
function parseProbeDurationMs(stdout) {
  const s = String(stdout || '').trim();
  if (!s || s === 'N/A') return null;
  const n = parseFloat(s);
  if (!isFinite(n) || n <= 0) return null;
  return Math.round(n * 1000);
}

/**
 * Spawns ffprobe to determine the true media duration of a file.
 * Always resolves — never rejects. Returns null on any failure so a probe
 * error never blocks or breaks the recording finalize/move flow.
 *
 * @param {Object} params
 * @param {string} [params.ffprobePath='ffprobe'] - Path to the ffprobe binary.
 * @param {string} params.file - Path to the media file to probe.
 * @returns {Promise<number|null>} Duration in ms, or null on failure.
 */
function probeDurationMs({ ffprobePath = 'ffprobe', file }) {
  return new Promise((resolve) => {
    let stdout = '';
    const proc = spawn(ffprobePath, buildProbeArgs(file));
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    // Drain stderr so a large error dump can't fill the pipe buffer and block
    // the child from exiting (which would hang the mover's finalize/move).
    proc.stderr.on('data', () => {});
    proc.on('close', (code) => {
      resolve(code === 0 ? parseProbeDurationMs(stdout) : null);
    });
    proc.on('error', () => resolve(null));
  });
}

module.exports = { mkvPathFor, buildRemuxArgs, remuxToMkv, buildProbeArgs, parseProbeDurationMs, probeDurationMs };
