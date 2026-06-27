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

module.exports = { mkvPathFor, buildRemuxArgs, remuxToMkv };
