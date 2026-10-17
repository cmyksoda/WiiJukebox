// SPDX-License-Identifier: GPL-3.0-only
const { QueueSource } = require('./queue');
const { version } = require('../../package.json');

class PlexSource extends QueueSource {
    static id = 'plex';
    static label = 'Plex';
    static family = 'pull';
    static suggests = true;
    static homeRows = [
        { id: 'recent', title: 'Recently added', remote: true },
        { id: 'ondeck', title: 'On Deck', remote: true },
    ];

    get capabilities() {
        return { play: true, pause: true, stop: true, browse: true, search: true, ...this.queueCapabilities };
    }

    _url(path) {
        const base = new URL(this.config.url);
        const url = new URL(path, base);
        // Media paths are supplied by a remote server. Never forward its token
        // to an unrelated origin or accept filesystem/pipe inputs for ffmpeg.
        if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin) {
            throw new Error('Plex returned an invalid media path');
        }
        return url;
    }

    _headers() {
        return { Accept: 'application/json', 'X-Plex-Token': this.config.token,
            'X-Plex-Product': 'WiiJukebox', 'X-Plex-Version': version,
            'X-Plex-Client-Identifier': this.deps.serverId || 'wiijukebox' };
    }

    async _call(path, query = {}, { offset = 0, limit = 100 } = {}) {
        const url = this._url(path);
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
        const response = await fetch(url, {
            headers: { ...this._headers(), 'X-Plex-Container-Start': String(offset),
                'X-Plex-Container-Size': String(limit) },
            redirect: 'error', signal: AbortSignal.timeout(15000),
        });
        if (response.status === 401) throw new Error('Plex rejected the token');
        if (!response.ok) throw new Error(`Plex: HTTP ${response.status}`);
        return (await response.json()).MediaContainer || {};
    }

    async connect() {
        this._setState('connecting');
        try {
            if (!this.config.url || !this.config.token) throw new Error('set the Plex server URL and token');
            await this._call('/library/sections');
            this._setState('ready');
        } catch (err) { this._setState('error', err.message); throw err; }
    }

    _item(item) {
        const type = item.type === 'playlist' ? 'playlist' : item.type;
        return { id: `${type}/${item.ratingKey}`, type, title: item.title || 'Untitled',
            artist: item.grandparentTitle || (type === 'album' ? item.parentTitle : ''),
            album: type === 'track' ? item.parentTitle || '' : '',
            subtitle: [item.grandparentTitle, item.parentTitle].filter(Boolean).join(' — '),
            duration: item.duration ? item.duration / 1000 : null, artwork: this._thumb(item) };
    }

    async browse({ path = '', offset = 0, limit = 100 } = {}) {
        if (!path) {
            const res = await this._call('/library/sections');
            const items = (res.Directory || []).filter((i) => i.type === 'artist').map((i) => ({
                id: `section/${i.key}`, type: 'folder', title: i.title,
            }));
            items.push({ id: 'playlists', type: 'folder', title: 'Playlists' });
            return { items: items.slice(offset, offset + limit), total: items.length };
        }
        const [kind, id] = path.split('/');
        if (kind !== 'playlists' && !/^\d+$/.test(id || '')) throw new Error('invalid Plex item');
        let route;
        let query = {};
        if (kind === 'section') { route = `/library/sections/${id}/all`; query.type = 8; }
        else if (kind === 'artist' || kind === 'album') route = `/library/metadata/${id}/children`;
        else if (kind === 'playlist') route = `/playlists/${id}/items`;
        else if (kind === 'playlists') { route = '/playlists'; query.playlistType = 'audio'; }
        else throw new Error('unknown Plex browse path');
        const res = await this._call(route, query, { offset, limit });
        let items = (res.Metadata || []).filter((i) => ['artist', 'album', 'track', 'playlist'].includes(i.type));
        // Older servers may ignore pagination; slice locally in that case.
        const paged = res.offset != null;
        const total = res.totalSize ?? items.length;
        if (!paged) items = items.slice(offset, offset + limit);
        return { items: items.map((i) => this._item(i)), total };
    }

    // Plex only serves images to a token; the link stays on the server and reaches browsers through the art proxy.
    _thumb(item) {
        const path = item.thumb || item.composite || item.parentThumb || item.grandparentThumb;
        if (!path) return null;
        try {
            const url = this._url(path);
            url.searchParams.set('X-Plex-Token', this.config.token);
            return url.toString();
        } catch { return null; }
    }

    async homeRow(row, { limit }) {
        let metadata;
        if (row === 'ondeck') {
            metadata = (await this._call('/library/onDeck', {}, { limit })).Metadata || [];
        } else if (row === 'recent') {
            const sections = ((await this._call('/library/sections')).Directory || [])
                .filter((section) => section.type === 'artist' && /^\d+$/.test(section.key)).slice(0, 4);
            const pages = await Promise.all(sections.map((section) =>
                this._call(`/library/sections/${section.key}/recentlyAdded`, { type: 9 }, { limit })));
            metadata = pages.flatMap((page) => page.Metadata || []).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        } else throw new Error(`unknown home row: ${row}`);
        return metadata.filter((entry) => ['album', 'track', 'playlist'].includes(entry.type)).slice(0, limit)
            .map((entry) => this._item(entry));
    }

    async search(query, { limit = 50 } = {}) {
        const res = await this._call('/hubs/search', { query, limit });
        const items = (res.Hub || []).flatMap((h) => h.Metadata || [])
            .filter((i) => ['artist', 'album', 'track'].includes(i.type))
            .slice(0, limit).map((i) => this._item(i));
        return { items, total: items.length };
    }

    async open(item) {
        if (!item?.id) throw new Error('select a Plex track, album or playlist');
        const queue = [];
        if (item.type === 'album' || item.type === 'playlist') {
            let offset = 0;
            for (;;) {
                const page = await this.browse({ path: item.id, offset });
                queue.push(...page.items.filter((i) => i.type === 'track'));
                offset += page.items.length;
                if (!page.items.length || offset >= page.total) break;
            }
        } else queue.push(item);
        if (!queue.length) throw new Error('no audio in this selection');
        this._queue.load(queue, item);
        return this._openQueueItem();
    }

    async _openQueueItem() {
        const ref = this._queue.current;
        const id = ref?.id.replace(/^track\//, '');
        if (!/^\d+$/.test(id || '')) throw new Error('invalid Plex track');
        const res = await this._call(`/library/metadata/${id}`);
        const track = res.Metadata?.[0];
        if (track?.type !== 'track') throw new Error('Plex item is not audio');
        const part = track.Media?.[0]?.Part?.[0];
        if (!part?.key) throw new Error('Plex track has no media');
        const uri = this._url(part.key).toString();
        const meta = this._item(track);
        this._emitMetadata({ title: meta.title, artist: meta.artist, album: meta.album,
            duration: meta.duration, artwork: meta.artwork });
        this._startTrack({ ...meta, ratingKey: id });
        this._setState('playing');
        return { type: 'uri', uri, headers: { 'X-Plex-Token': this.config.token }, seekable: true };
    }

    // Plex shows and records plays (and forwards them to Last.fm when linked) from the
    // timeline and scrobble reports its own players send.
    async _report(path, query) {
        const url = this._url(path);
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
        const response = await fetch(url, { headers: this._headers(), redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`Plex: HTTP ${response.status}`);
    }

    _timeline(track, state, seconds) {
        return this._report('/:/timeline', {
            ratingKey: track.ratingKey, key: `/library/metadata/${track.ratingKey}`, state,
            time: Math.round(seconds * 1000), duration: Math.round((track.duration || 0) * 1000),
        });
    }

    async reportPlaying(track) { await this._timeline(track, 'playing', 0); }

    async reportPlayed(track) {
        await this._report('/:/scrobble', { key: track.ratingKey, identifier: 'com.plexapp.plugins.library' });
    }

    async reportStopped(track, { position }) { await this._timeline(track, 'stopped', position); }

    async close() { this._queue.clear(); this._setState('ready'); }
    async disconnect() { await this.close(); this._setState('idle'); }
}

module.exports = { PlexSource };
