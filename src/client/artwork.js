// SPDX-License-Identifier: GPL-3.0-only
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

const SIZES = [64, 96, 128, 160];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

/** Reorder row-major big-endian RGB565 into GX's 4x4-texel tiles. */
function tileRgb565(pixels, size) {
    const tiled = Buffer.alloc(size * size * 2);
    let out = 0;
    for (let ty = 0; ty < size; ty += 4) {
        for (let tx = 0; tx < size; tx += 4) {
            for (let y = ty; y < ty + 4; y++) {
                pixels.copy(tiled, out, (y * size + tx) * 2, (y * size + tx + 4) * 2);
                out += 8;
            }
        }
    }
    return tiled;
}

// Artwork URLs often carry provider credentials, so the Wii only ever sees an
// opaque key; the URL never leaves the server.
class Artwork {
    constructor({ ffmpegPath = 'ffmpeg', fetchImpl = fetch } = {}) {
        this.ffmpegPath = ffmpegPath;
        this.fetch = fetchImpl;
        this.urls = new Map();
        this.cache = new Map();
        this.pending = new Map();
    }

    keyFor(url) {
        if (!url || typeof url !== 'string') return '';
        const key = createHash('sha256').update(url).digest('hex').slice(0, 16);
        this.urls.delete(key);
        this.urls.set(key, url);
        while (this.urls.size > 64) this.urls.delete(this.urls.keys().next().value);
        return key;
    }

    async render(key, size) {
        if (!SIZES.includes(size)) throw new Error('unsupported artwork size');
        const url = this.urls.get(key);
        if (!url) throw new Error('unknown artwork');
        const id = `${key}:${size}`;
        if (this.cache.has(id)) {
            const hit = this.cache.get(id);
            this.cache.delete(id);
            this.cache.set(id, hit);
            return hit;
        }
        if (!this.pending.has(id)) {
            this.pending.set(id, this._render(url, size).finally(() => this.pending.delete(id)));
        }
        const tiled = await this.pending.get(id);
        this.cache.set(id, tiled);
        while (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value);
        return tiled;
    }

    async _image(url) {
        if (url.startsWith('data:')) {
            const match = /^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(url);
            if (!match) throw new Error('unsupported artwork data');
            return Buffer.from(match[1], 'base64');
        }
        if (!/^https?:\/\//i.test(url)) throw new Error('unsupported artwork URL');
        const res = await this.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`artwork HTTP ${res.status}`);
        const body = Buffer.from(await res.arrayBuffer());
        if (body.length > MAX_IMAGE_BYTES) throw new Error('artwork too large');
        return body;
    }

    async _render(url, size) {
        const image = await this._image(url);
        // Crop to a square rather than letterboxing, so the art fills its frame.
        const filter = `scale=${size}:${size}:force_original_aspect_ratio=increase:flags=lanczos,` +
            `crop=${size}:${size}`;
        const pixels = await new Promise((resolve, reject) => {
            const proc = spawn(this.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', 'pipe:0',
                '-frames:v', '1', '-vf', filter, '-filter_threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb565be', 'pipe:1'],
            { stdio: ['pipe', 'pipe', 'ignore'] });
            const chunks = [];
            const timer = setTimeout(() => proc.kill('SIGKILL'), FETCH_TIMEOUT_MS);
            proc.stdout.on('data', (chunk) => chunks.push(chunk));
            proc.stdin.on('error', () => {});
            proc.on('error', reject);
            proc.on('close', (code) => {
                clearTimeout(timer);
                const out = Buffer.concat(chunks);
                if (code === 0 && out.length === size * size * 2) resolve(out);
                else reject(new Error('artwork could not be converted'));
            });
            proc.stdin.end(image);
        });
        return tileRgb565(pixels, size);
    }
}

module.exports = { Artwork, tileRgb565, SIZES };
