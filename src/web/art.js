// SPDX-License-Identifier: GPL-3.0-only
// Cover art for the web home screen. Art links often carry a service token, so the
// browser is given an opaque /api/art/<key> path and this server fetches the image.

const { createHash } = require('node:crypto');

const PREFIX = '/api/art/';
const KEY_LIMIT = 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;
// Raster only: an SVG opened directly from this origin could run script.
const IMAGE_TYPES = /^image\/(png|jpe?g|webp|gif|avif)\b/i;

class ArtProxy {
    constructor({ fetchImpl = fetch } = {}) {
        this.fetch = fetchImpl;
        this.urls = new Map();
    }

    /** The browser-safe path for an art link, or null when it is not a web image. */
    link(url) {
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
        const key = createHash('sha256').update(url).digest('hex').slice(0, 20);
        this.urls.delete(key);
        this.urls.set(key, url);
        while (this.urls.size > KEY_LIMIT) this.urls.delete(this.urls.keys().next().value);
        return `${PREFIX}${key}`;
    }

    /** Puts the real art link back on an item that came from a home screen response. */
    restore(item) {
        if (typeof item?.artwork !== 'string' || !item.artwork.startsWith(PREFIX)) return item;
        const { artwork, ...rest } = item;
        const url = this.urls.get(artwork.slice(PREFIX.length));
        return url ? { ...rest, artwork: url } : rest;
    }

    async serve(key, res) {
        const url = this.urls.get(key);
        if (!url) return fail(res, 404, 'unknown artwork');
        try {
            const upstream = await this.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
            const type = upstream.headers.get('content-type') || '';
            if (!upstream.ok || !IMAGE_TYPES.test(type)) return fail(res, 502, 'artwork unavailable');
            const body = Buffer.from(await upstream.arrayBuffer());
            if (body.length > MAX_IMAGE_BYTES) return fail(res, 502, 'artwork too large');
            res.writeHead(200, {
                'Content-Type': type, 'Content-Length': body.length, 'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'private, max-age=3600',
            });
            res.end(body);
        } catch {
            fail(res, 502, 'artwork unavailable');
        }
    }
}

function fail(res, code, message) {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(message);
}

module.exports = { ArtProxy };
