// HTTP API + WebSocket, sharing one port with the audio mount.
//
// One port matters for the no-Docker goal: the user opens one address, the Wii
// connects to the same address, and there is no second service to explain.

const http = require('http');
const path = require('path');
const fs = require('fs');
const { control } = require('../core/transport');
const { PlayHistory } = require('../core/history');
const { WiiProtocol } = require('../client/protocol');
const { ArtProxy } = require('./art');
const { HomeService } = require('./home');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.gif': 'image/gif',
};

// Never sent back to the browser; the settings form only learns whether each is set.
const SECRET_KEYS = new Set(['password', 'token', 'salt', 'accessToken', 'refreshToken', 'clientSecret']);

class WebServer {
    /**
     * @param {object} deps
     * @param {import('../core/pipeline').Pipeline} deps.pipeline
     * @param {import('../sources/index').SourceRegistry} deps.registry
     * @param {import('../config').Config} deps.config
     * @param {PlayHistory} [deps.history]  what the home screen offers again; kept next to config.json by default
     */
    constructor({ pipeline, registry, config, publicDir, history }) {
        this.pipeline = pipeline;
        this.registry = registry;
        this.config = config;
        this.wii = new WiiProtocol({ pipeline, registry, config });
        this.history = history || new PlayHistory({ file: path.join(config.dir, 'history.json') });
        this.history.listen(pipeline);
        this.art = new ArtProxy();
        this.home = new HomeService({ registry, config, history: this.history, art: this.art });
        this.publicDir = publicDir || path.join(__dirname, '..', '..', 'public');

        this._sseClients = new Set();
        this.server = http.createServer((req, res) => this._route(req, res));

        // Push status to the WebUI as it changes rather than making it poll.
        // Server-sent events rather than WebSocket: one-directional is all this
        // needs, and it survives reconnects on its own.
        const push = () => this._broadcast('status', this.pipeline.status);
        pipeline.on('status', push);
        pipeline.on('metadata', () => this._broadcast('metadata', pipeline.nowPlaying));
        pipeline.on('warning', (msg) => this._broadcast('warning', { message: msg }));
    }

    listen(port, host = '0.0.0.0') {
        return new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(port, host, () => resolve(this.server.address()));
        });
    }

    close() {
        for (const res of this._sseClients) res.end();
        this._sseClients.clear();
        this.server.close();
    }

    _broadcast(event, data) {
        const payload = `event: ${event}\ndata: ${JSON.stringify(this.art.publish(data))}\n\n`;
        for (const res of this._sseClients) {
            if (!res.writableEnded) res.write(payload);
        }
    }

    async _route(req, res) {
        // The audio mount takes priority; it is the one route that must never be
        // shadowed by anything else.
        if (this.pipeline.broadcaster.handles(req)) {
            this.pipeline.broadcaster.handleRequest(req, res);
            return;
        }

        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = url.pathname;

        try {
            if (pathname.startsWith('/api/wii/')) return await this.wii.handle(req, res, url);
            if (pathname === '/events') return this._events(req, res);
            if (pathname === '/playlist.pls') return this._playlist(req, res);
            if (pathname.startsWith('/api/')) return await this._api(req, res, url);
            return this._static(req, res, pathname);
        } catch (err) {
            this._json(res, 500, { error: err.message });
        }
    }

    // Every browser-bound body goes through here, so no art link leaves without the proxy.
    _json(res, status, body) {
        const text = JSON.stringify(this.art.publish(body));
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(text),
        });
        res.end(text);
    }

    async _readBody(req) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            // Nothing this API accepts is large; refuse anything that looks like
            // an attempt to exhaust memory.
            if (size > 1_000_000) throw new Error('request body too large');
            chunks.push(chunk);
        }
        if (!chunks.length) return {};
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }

    _events(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        res.write('retry: 2000\n\n');
        res.write(`event: status\ndata: ${JSON.stringify(this.art.publish(this.pipeline.status))}\n\n`);

        this._sseClients.add(res);
        req.on('close', () => this._sseClients.delete(res));

        // Proxies and browsers drop an idle event stream; a periodic comment
        // keeps it open without generating UI churn.
        const keepalive = setInterval(() => {
            if (res.writableEnded) return clearInterval(keepalive);
            res.write(': keepalive\n\n');
        }, 20000);
        keepalive.unref?.();
    }

    /**
     * The .pls the user drops on their SD card. Because the mount is permanent,
     * this file is written once and never needs regenerating -- which is the
     * whole point of the pivot.
     */
    _playlist(req, res) {
        const host = this.config.data.hostIp || 'localhost';
        const port = this.config.data.port;
        const name = this.config.data.station.name;

        // .pls has no escaping, so a newline in a value would inject bogus keys.
        const safe = (v) => String(v).replace(/[\r\n]+/g, ' ').trim();

        const body = [
            '[playlist]',
            'NumberOfEntries=1',
            `File1=http://${host}:${port}${this.config.data.mount}`,
            `Title1=${safe(name)}`,
            'Length1=-1',
            'Version=2',
            '',
        ].join('\r\n');

        // Keep exported playlist filenames compatible with FAT32.
        const filename = `${safe(name).replace(/[\\/:*?"<>|]/g, '') || 'stream'}.pls`;

        res.writeHead(200, {
            'Content-Type': 'audio/x-scpls',
            'Content-Disposition': `attachment; filename="${filename}"`,
        });
        res.end(body);
    }

    async _api(req, res, url) {
        const parts = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
        const [section, ...rest] = parts;

        if (section === 'status') {
            return this._json(res, 200, this.pipeline.status);
        }

        if (section === 'sources') {
            if (req.method === 'GET' && !rest.length) {
                return this._json(res, 200, { sources: this.registry.describe() });
            }

            const id = rest[0];
            const action = rest[1];

            if (action === 'favorites' && ['radio', 'ytdlp', 'ytmusic'].includes(id)) {
                const key = id === 'radio' ? 'stations' : 'links';
                const cfg = this.config.sourceConfig(id);
                if (req.method === 'GET') return this._json(res, 200, { items: cfg[key] || [] });
                const body = await this._readBody(req);
                let entries = cfg[key] || [];
                if (req.method === 'POST') {
                    const link = new URL(body.url);
                    if (!['http:', 'https:'].includes(link.protocol) || link.username || link.password) {
                        return this._json(res, 400, { error: 'use an HTTP(S) link without embedded credentials' });
                    }
                    const url = link.toString();
                    const entry = { id: require('node:crypto').randomUUID(), url,
                        name: String(body.name || link.hostname).slice(0, 200) };
                    entries = [...entries.filter((item) => item.url !== url), entry];
                } else if (req.method === 'DELETE') entries = entries.filter((item) => item.id !== body.id);
                else return this._json(res, 405, { error: 'method not allowed' });
                this.config.updateSource(id, { [key]: entries });
                // Favorite edits must not interrupt an active stream or extraction.
                this.registry.get(id).config[key] = entries;
                return this._json(res, 200, { items: entries });
            }

            if (req.method === 'POST' && action === 'config') {
                const patch = await this._readBody(req);
                await this.pipeline.command(async () => {
                    if (this.pipeline.activeSource?.id === id) await this.pipeline.detach();
                    await this.registry.configure(id, patch);
                });
                this.home.forget(id);
                return this._json(res, 200, { ok: true });
            }

            // Current settings for the edit form; secrets are reported as set/unset only.
            if (req.method === 'GET' && action === 'settings') {
                const values = {};
                const secrets = {};
                for (const [key, value] of Object.entries(this.config.sourceConfig(id))) {
                    if (SECRET_KEYS.has(key)) secrets[key] = Boolean(value);
                    else if (['string', 'number', 'boolean'].includes(typeof value) || Array.isArray(value)) {
                        // Saved stations, links and subscriptions have their own endpoints.
                        if (!['stations', 'links', 'subscriptions'].includes(key)) values[key] = value;
                    }
                }
                return this._json(res, 200, { values, secrets });
            }

            // Source-specific panels: current state (GET) and one-off steps such as
            // signing in (POST), implemented by sources that define info()/action().
            if (req.method === 'GET' && action === 'info') {
                const source = this.registry.get(id);
                return this._json(res, 200, source.info ? source.info() : {});
            }

            if (req.method === 'POST' && action === 'action' && rest[2]) {
                const source = this.registry.get(id);
                if (typeof source.action !== 'function') {
                    return this._json(res, 404, { error: `${source.label} has no such action` });
                }
                try {
                    const body = this.art.restore(await this._readBody(req));
                    const result = await source.action(rest[2], body);
                    this.home.forget(id);
                    return this._json(res, 200, result);
                } catch (err) {
                    return this._json(res, 400, { error: err.message });
                }
            }

            if (req.method === 'POST' && action === 'connect') {
                try {
                    await this.registry.connect(id);
                    return this._json(res, 200, { ok: true });
                } catch (err) {
                    // A failed login is a user-facing outcome, not a server
                    // fault; 400 so the UI shows the message rather than "oops".
                    return this._json(res, 400, { error: err.message });
                }
            }

            if (req.method === 'GET' && action === 'browse') {
                const source = await this.registry.connect(id);
                const result = await source.browse({
                    path: url.searchParams.get('path') || '',
                    offset: Number(url.searchParams.get('offset') || 0),
                    limit: Number(url.searchParams.get('limit') || 100),
                });
                return this._json(res, 200, result);
            }

            if (req.method === 'GET' && action === 'search') {
                const source = await this.registry.connect(id);
                const result = await source.search(url.searchParams.get('q') || '', {});
                return this._json(res, 200, result);
            }

            if (req.method === 'POST' && action === 'play') {
                // Items that came from a page carry art proxy paths in place of the real links.
                const item = this.art.restore(await this._readBody(req));
                await this.pipeline.command(async () => {
                    const source = await this.registry.connect(id);
                    await this.pipeline.attach(source, item);
                });
                this.config.data.lastPlayed = { source: id, item };
                this.config.save();
                return this._json(res, 200, { ok: true, status: this.pipeline.status });
            }
        }

        if (section === 'home' && rest[0] === 'primary' && rest.length === 1) {
            if (req.method === 'GET') return this._json(res, 200, this.home.primary());
            if (req.method === 'POST') {
                const body = await this._readBody(req);
                if (!('id' in body)) return this._json(res, 400, { error: 'name a service, or null to leave it automatic' });
                try {
                    return this._json(res, 200, this.home.setPrimary(body.id));
                } catch (err) {
                    return this._json(res, err.code || 500, { error: err.message });
                }
            }
        }

        if (section === 'home' && req.method === 'GET') {
            if (!rest.length) return this._json(res, 200, this.home.overview());
            try {
                return this._json(res, 200, await this.home.service(rest[0]));
            } catch (err) {
                return this._json(res, err.code || 500, { error: err.message });
            }
        }

        if (section === 'home' && req.method === 'DELETE' && rest[0] === 'recent' && rest.length === 1) {
            this.history.clear();
            return this._json(res, 200, { ok: true });
        }

        if (section === 'ui' && rest[0] === 'hidden-sources' && rest.length === 1) {
            if (req.method === 'GET') return this._json(res, 200, { hidden: this.registry.hidden() });
            if (req.method === 'POST') {
                try {
                    const hidden = this.registry.setHidden(await this._readBody(req));
                    this._broadcast('sources', { hidden });
                    return this._json(res, 200, { hidden });
                } catch (err) {
                    return this._json(res, err instanceof SyntaxError ? 400 : err.code || 500, { error: err.message });
                }
            }
        }

        if (section === 'art' && req.method === 'GET' && rest.length === 1) {
            return this.art.serve(rest[0], res);
        }

        if (section === 'control' && req.method === 'POST') {
            // Actions such as seek carry their argument in the body.
            const body = await this._readBody(req).catch(() => ({}));
            const result = await control(this.pipeline, this.config, rest[0], body);
            return this._json(res, result.code || 200, result);
        }

        if (section === 'settings') {
            if (req.method === 'GET') {
                // Never hand credentials back out; the UI only needs to know
                // whether each source is set up.
                const { sources, ...rest2 } = this.config.data;
                return this._json(res, 200, rest2);
            }
            if (req.method === 'POST') {
                const patch = await this._readBody(req);
                Object.assign(this.config.data, patch);
                this.config.save();
                if (patch.station) this.pipeline.broadcaster.setStationInfo(patch.station);
                return this._json(res, 200, { ok: true });
            }
        }

        return this._json(res, 404, { error: 'no such endpoint' });
    }

    _static(req, res, pathname) {
        const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');

        // Resolve and confirm containment, so a crafted path cannot walk out of
        // the public directory and serve the config file.
        const full = path.resolve(this.publicDir, rel);
        if (!full.startsWith(path.resolve(this.publicDir) + path.sep)) {
            res.writeHead(403);
            return res.end('forbidden');
        }

        fs.readFile(full, (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                return res.end('not found');
            }
            res.writeHead(200, {
                'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
            });
            res.end(data);
        });
    }
}

module.exports = { WebServer };
