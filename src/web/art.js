// SPDX-License-Identifier: GPL-3.0-only
// Cover art for the web UI. Art links often carry a service token or point at an address only
// this machine can reach, so the browser is given an opaque /api/art/<key> path and this
// server fetches the image.

const { createHash } = require('node:crypto');

const PREFIX = '/api/art/';
const KEY_LIMIT = 4096;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;
// Raster only: an SVG opened directly from this origin could run script.
const IMAGE_TYPES = /^image\/(png|jpe?g|webp|gif|avif)\b/i;

class ArtProxy {
    constructor({ fetchImpl = fetch } = {}) {
        this.fetch = fetchImpl;
        this.urls = new Map();
    }

    /** The browser-safe path for an art link, or null when it is not a picture a browser can show. */
    link(url) {
        if (typeof url !== 'string') return null;
        if (url.startsWith(PREFIX) || /^data:image\//i.test(url)) return url;
        if (!/^https?:\/\//i.test(url)) return null;
        const key = createHash('sha256').update(url).digest('hex').slice(0, 20);
        this._touch(key, url);
        return `${PREFIX}${key}`;
    }

    /** A copy of a response with every `artwork` link, at any depth, turned into a proxy path. */
    publish(value) {
        if (Array.isArray(value)) return value.map((entry) => this.publish(entry));
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
            [key, key === 'artwork' ? this.link(entry) : this.publish(entry)]));
    }

    /** Puts the real art link back on whatever the browser sends back; a key it no longer knows drops the art. */
    restore(value) {
        if (Array.isArray(value)) return value.map((entry) => this.restore(entry));
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
            if (key !== 'artwork' || typeof entry !== 'string' || !entry.startsWith(PREFIX)) return [[key, this.restore(entry)]];
            const url = this.urls.get(entry.slice(PREFIX.length));
            return url ? [[key, url]] : [];
        }));
    }

    async serve(key, res) {
        const url = this.urls.get(key);
        if (!url) return fail(res, 404, 'unknown artwork');
        this._touch(key, url);
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

    // Least recently used goes first, so what a page is showing stays while old keys age out.
    _touch(key, url) {
        this.urls.delete(key);
        this.urls.set(key, url);
        while (this.urls.size > KEY_LIMIT) this.urls.delete(this.urls.keys().next().value);
    }
}

function fail(res, code, message) {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(message);
}

module.exports = { ArtProxy };
