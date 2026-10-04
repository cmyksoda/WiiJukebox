// SPDX-License-Identifier: GPL-3.0-only
const { randomBytes } = require('node:crypto');
const { control } = require('../core/transport');
const { serverIdentity } = require('./discovery');
const PAGE_SIZE = 12;
const TTL = 60 * 60 * 1000;

// A bounded text protocol keeps the Wii parser small. Opaque references retain
// full upstream items (including radio URLs) on the server, not on the console.
class WiiProtocol {
    constructor({ registry, pipeline, config }) {
        this.registry = registry;
        this.pipeline = pipeline;
        this.config = config;
        this.id = serverIdentity(config);
        this.items = new Map();
        this.commandStatus = "";
    }

    _remember(source, item) {
        const now = Date.now();
        for (const [key, entry] of this.items) {
            if (entry.expires < now) this.items.delete(key);
        }
        while (this.items.size >= 4096) this.items.delete(this.items.keys().next().value);
        const ref = randomBytes(12).toString('hex');
        this.items.set(ref, { source, item, expires: now + TTL });
        return ref;
    }

    _lookup(ref, source) {
        const entry = this.items.get(ref);
        if (!entry || entry.source !== source || entry.expires < Date.now()) {
            throw new Error('selection expired; return to sources and browse again');
        }
        return entry.item;
    }

    async handle(req, res, url) {
        const action = url.pathname.slice('/api/wii/'.length);
        let rows;
        try {
            if (req.method === 'GET' && action === 'info') {
                rows = [['server', this.id, this.config.data.station.name, this.config.data.mount]];
            } else if (req.method === 'GET' && action === 'sources') {
                rows = this.registry.describe().filter((s) => s.configured).map((s) =>
                    ['source', s.id, s.label, s.state]);
            } else if (req.method === 'GET' && action === 'status') {
                const s = this.pipeline.status;
                rows = [['status', s.nowPlaying.title, s.nowPlaying.artist,
                    s.paused ? 'paused' : (s.source ? 'playing' : 'idle'), s.source?.label || '',
                    Object.entries(s.capabilities).filter(([, enabled]) => enabled).map(([key]) => key).join(',')], ['command', this.commandStatus]];
            } else if (req.method === 'GET' && action === 'browse') {
                const id = url.searchParams.get('source');
                const ref = url.searchParams.get('ref');
                const offset = Number(url.searchParams.get('offset') || 0);
                if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid page');
                const source = await this.registry.connect(id);
                const path = ref ? this._lookup(ref, id).id : '';
                const result = await source.browse({ path, offset, limit: PAGE_SIZE });
                // Some existing providers ignore pagination. Normalize at this
                // boundary until all their browse implementations support it.
                let items = result.items;
                if (items.length > PAGE_SIZE) items = items.slice(offset, offset + PAGE_SIZE);
                rows = [['page', offset, result.total]];
                rows.push(...items.map((item) => ['item', this._remember(id, item),
                    item.type, item.title, item.subtitle || '']));
            } else if (req.method === 'POST' && action === 'play') {
                const id = url.searchParams.get('source');
                const item = this._lookup(url.searchParams.get('ref'), id);
                if (this.commandStatus === 'Working...') throw new Error('a Wii command is already running');
                this._command(this.pipeline.command(async () => {
                    const source = await this.registry.connect(id);
                    await this.pipeline.attach(source, item);
                    this.config.data.lastPlayed = { source: id, item };
                    this.config.save();
                }));
                rows = [['ok', 'accepted']];
            } else if (req.method === 'POST' && action === 'control') {
                if (this.commandStatus === 'Working...') throw new Error('a Wii command is already running');
                this._command(control(this.pipeline, this.config, url.searchParams.get('action')));
                rows = [['ok', 'accepted']];
            } else {
                return this._send(res, 404, [['error', 'unknown Wii endpoint']]);
            }
            this._send(res, 200, rows);
        } catch (err) { this._send(res, 400, [['error', err.message]]); }
    }

    _command(promise) {
        this.commandStatus = 'Working...';
        promise.then((result) => {
            this.commandStatus = result?.error || (result?.endOfQueue ? 'End of queue' : 'Done');
        }, (err) => { this.commandStatus = err.message; });
    }

    _send(res, code, rows) {
        const encode = (value) => encodeURIComponent(Array.from(String(value ?? '').replaceAll('\0', '')).slice(0, 256).join('').toWellFormed());
        const body = 'WIIJUKEBOX\t1\n' + rows.map((row) => row.map(encode).join('\t')).join('\n') + '\n';
        res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8',
            'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
        res.end(body);
    }
}
module.exports = { WiiProtocol, PAGE_SIZE };
