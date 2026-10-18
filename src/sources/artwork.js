// SPDX-License-Identifier: GPL-3.0-only
// Receivers hand over raw cover images; shrink them so status updates stay small.

const { spawn } = require('node:child_process');

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10000;

/** @returns {Promise<string|null>} a data: URI, or null when it cannot be produced */
async function shrinkToDataUri(image, opts) {
    const jpeg = await shrinkImage(image, opts);
    return jpeg ? `data:image/jpeg;base64,${jpeg.toString('base64')}` : null;
}

/** @returns {Promise<Buffer|null>} a JPEG at most `size` pixels on each side */
function shrinkImage(image, { ffmpegPath = 'ffmpeg', size = 300 } = {}) {
    if (!image?.length || image.length > MAX_INPUT_BYTES) return Promise.resolve(null);
    return new Promise((resolve) => {
        const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1',
            '-vf', `scale='min(${size},iw)':'min(${size},ih)':force_original_aspect_ratio=decrease`,
            '-q:v', '4', '-f', 'mjpeg', 'pipe:1'];
        let child;
        try {
            child = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'ignore'] });
        } catch {
            return resolve(null);
        }
        const chunks = [];
        const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
        timer.unref?.();
        child.stdout.on('data', (chunk) => chunks.push(chunk));
        child.stdin.on('error', () => {});
        child.on('error', () => { clearTimeout(timer); resolve(null); });
        child.on('close', (code) => {
            clearTimeout(timer);
            const out = Buffer.concat(chunks);
            resolve(code === 0 && out.length ? out : null);
        });
        child.stdin.end(image);
    });
}

module.exports = { shrinkToDataUri, shrinkImage };
