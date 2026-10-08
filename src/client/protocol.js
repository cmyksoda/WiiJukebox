// SPDX-License-Identifier: GPL-3.0-only
const { randomBytes } = require('node:crypto');
const { control } = require('../core/transport');
const { serverIdentity } = require('./discovery');
const { Artwork } = require('./artwork');
const PAGE_SIZE = 12;
const TTL = 60 * 60 * 1000;

function controlMessage(action, result) {
    if (action === 'shuffle') return `Shuffle ${result.status.modes.shuffle ? 'on' : 'off'}`;
    if (action === 'repeat') return `Repeat ${result.status.modes.repeat}`;
    return { stop: 'Stopped', pause: 'Paused', play: 'Resumed', seek: 'Seeked' }[action] || 'Audio ready';
}

// A bounded text protocol keeps the Wii parser small. Opaque references retain
// full upstream items (including radio URLs) on the server, not on the console.
class WiiProtocol {
    constructor({ registry, pipeline, config, artwork = new Artwork() }) {
        this.registry = registry;
        this.pipeline = pipeline;
        this.config = config;
        this.artwork = artwork;
        this.id = serverIdentity(config);
        this.items = new Map();
        this.commandStatus = "";
        this.commandId = 0;
        this.commandState = "idle";
    }

    _remember(source, item, playback = item) {
        const now = Date.now();
        for (const [key, entry] of this.items) {
            if (entry.expires < now) this.items.delete(key);
        }
        while (this.items.size >= 4096) this.items.delete(this.items.keys().next().value);
        const ref = randomBytes(12).toString('hex');
        this.items.set(ref, { source, item, playback, expires: now + TTL });
        return ref;
    }

    _lookup(ref, source, playback = false) {
        const entry = this.items.get(ref);
        if (!entry || entry.source !== source || entry.expires < Date.now()) {
            throw new Error('selection expired; return to sources and browse again');
        }
        return playback ? entry.playback : entry.item;
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
                let s = this.pipeline.status;
                if (url.searchParams.has('audible')) {
                    const epoch = Number(url.searchParams.get('epoch') || 0);
                    const byte = Number(url.searchParams.get('byte') ?? -1);
                    const played = Number(url.searchParams.get('played') ?? -1);
                    if (![epoch, byte, played].every(Number.isSafeInteger)) throw new Error('invalid playback clock');
                    s = this.pipeline.playbackAt(epoch, byte, played);
                }
                rows = [['status', s.nowPlaying.title, s.nowPlaying.artist,
                    s.playbackState || (s.paused ? 'paused' : (s.source ? 'playing' : 'idle')), s.source?.label || '',
                    Object.entries(s.capabilities).filter(([, enabled]) => enabled).map(([key]) => key).join(',')],
                    ['progress', Math.floor((s.nowPlaying.position || 0) * 1000),
                        Math.floor((s.nowPlaying.duration || 0) * 1000)],
                    ['command', this.commandStatus, this.commandId, this.commandState],
                    ['art', this.artwork.keyFor(s.nowPlaying.artwork)]];
                if (s.modes) rows.push(['modes', s.modes.shuffle ? 1 : 0, s.modes.repeat]);
                if (s.jump) rows.push(['jump', s.jump.id, s.jump.epoch, s.jump.byte]);
            } else if (req.method === 'GET' && action === 'art') {
                const size = Number(url.searchParams.get('size') || 128);
                let image;
                try {
                    image = await this.artwork.render(url.searchParams.get('key') || '', size);
                } catch (err) {
                    return this._send(res, 404, [['error', err.message]]);
                }
                res.writeHead(200, { 'Content-Type': 'application/octet-stream',
                    'Content-Length': image.length, 'Cache-Control': 'no-store',
                    'X-WiiJukebox-Art': `${size}x${size} rgb565 gx-tiled` });
                return res.end(image);
            } else if (req.method === 'GET' && action === 'browse') {
                const id = url.searchParams.get('source');
                const ref = url.searchParams.get('ref');
                const offset = Number(url.searchParams.get('offset') || 0);
                if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid page');
                const source = await this.registry.connect(id);
                const parent = ref ? this._lookup(ref, id) : null;
                const path = parent?.id || '';
                const result = await source.browse({ path, offset, limit: PAGE_SIZE });
                // Some existing providers ignore pagination. Normalize at this
                // boundary until all their browse implementations support it.
                let items = result.items;
                if (items.length > PAGE_SIZE) items = items.slice(offset, offset + PAGE_SIZE);
                rows = [['page', offset, result.total]];
                rows.push(...items.map((item, index) => {
                    const playback = item.type === 'track' && ['album', 'playlist'].includes(parent?.type)
                        ? { ...parent, startId: item.id, startIndex: offset + index } : item;
                    return ['item', this._remember(id, item, playback), item.type, item.title, item.subtitle || ''];
                }));
            } else if (req.method === 'POST' && action === 'play') {
                const id = url.searchParams.get('source');
                const item = this._lookup(url.searchParams.get('ref'), id, true);
                if (this.commandState === 'pending') throw new Error('a Wii command is already running');
                const commandId = this._command(this.pipeline.command(async () => {
                    const source = await this.registry.connect(id);
                    await this.pipeline.attach(source, item);
                    this.config.data.lastPlayed = { source: id, item };
                    this.config.save();
                }), { audio: true, message: 'Audio ready' });
                rows = [['ok', 'accepted', commandId]];
            } else if (req.method === 'POST' && action === 'control') {
                const action = url.searchParams.get('action');
                if (this.commandState === 'pending' && action !== 'stop') throw new Error('a Wii command is already running');
                let position;
                if (action === 'seek') {
                    const ms = Number(url.searchParams.get('position'));
                    if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('invalid seek position');
                    position = ms / 1000;
                }
                const value = url.searchParams.get('value') ?? undefined;
                const commandId = this._command(control(this.pipeline, this.config, action, { position, value }), {
                    audio: action === 'next' || action === 'previous' || action === 'seek',
                    message: (result) => controlMessage(action, result),
                });
                rows = [['ok', 'accepted', commandId]];
            } else {
                return this._send(res, 404, [['error', 'unknown Wii endpoint']]);
            }
            this._send(res, 200, rows);
        } catch (err) { this._send(res, 400, [['error', err.message]]); }
    }

    _command(promise, { audio = false, message = 'Complete' } = {}) {
        const id = ++this.commandId;
        this.commandState = 'pending';
        this.commandStatus = 'Working...';
        Promise.resolve(promise).then(async (result) => {
            if (id !== this.commandId) return;
            if (result?.error) throw new Error(result.error);
            if (audio && !result?.endOfQueue) {
                this.commandStatus = 'Waiting for audio...';
                await this.pipeline.waitForAudio();
            }
            if (id !== this.commandId) return;
            this.commandStatus = result?.endOfQueue ? 'End of queue' : typeof message === 'function' ? message(result) : message;
            this.commandState = 'complete';
        }).catch((err) => {
            if (id !== this.commandId) return;
            this.commandStatus = err.message;
            this.commandState = 'failed';
        });
        return id;
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
