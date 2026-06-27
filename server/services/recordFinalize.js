'use strict';

const { spawn } = require('child_process');

/**
 * Returns the same path with the extension swapped from .ts to .mkv.
 * Pure function — no I/O.
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
