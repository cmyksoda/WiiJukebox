// Navidrome (and anything else speaking the Subsonic API).
//
// The cleanest of the three self-hosted integrations by a distance: a fully
// documented API, stable since 2010, with one endpoint per thing you'd want.
// Gonic, Airsonic, Ampache and Navidrome all speak it, so this one file covers
// a good chunk of the self-hosted world.
//
// Subsonic has no cast/remote-control concept, unlike Jellyfin and Plex, so
// there is no "play to WiiJukebox" button inside a Navidrome client. Here
// the browsing happens in our WebUI instead.

const crypto = require('crypto');
const { Source } = require('./base');
const { queueStart } = require('./queue');

// Version we claim to speak. 1.16.1 is the last Subsonic spec release and what
// Navidrome targets; asking for more just gets rejected by older servers.
const API_VERSION = '1.16.1';
const CLIENT_NAME = 'WiiJukebox';

class SubsonicSource extends Source {
    static id = 'subsonic';
    static label = 'Navidrome / Subsonic';
    static family = 'pull';

    constructor(config = {}, deps = {}) {
        super(config, deps);
        this._queue = [];
        this._queueIndex = -1;
        this._current = null;
    }

    get capabilities() {
        return {
            play: true,
            pause: true,
            stop: true,
            next: this._queueIndex + 1 < this._queue.length,
            previous: this._queueIndex > 0,
            seek: true,
            browse: true,
            search: true,
            queue: true,
        };
    }

    /**
     * Subsonic auth: rather than sending the password, send a salted MD5 of it.
     * MD5 is not a security property here -- the server stores the password
     * reversibly and the scheme predates modern practice -- so this must run
     * over HTTPS to mean anything. Warned about in connect().
     */
    _authParams() {
        const { username, password, token, salt } = this.config;
        const params = new URLSearchParams({
            u: username,
            v: API_VERSION,
            c: CLIENT_NAME,
            f: 'json',
        });
        if (token && salt) {
            params.set('t', token);
            params.set('s', salt);
        } else {
            const s = crypto.randomBytes(8).toString('hex');
            params.set('t', crypto.createHash('md5').update(String(password ?? '') + s).digest('hex'));
            params.set('s', s);
        }
        return params;
    }

    _url(endpoint, extra = {}, url = this.config.url) {
        const base = String(url || '').replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(base)) throw new Error('use an HTTP(S) Navidrome server URL');
        const params = this._authParams();
        for (const [k, v] of Object.entries(extra)) {
            if (v != null) params.set(k, String(v));
        }
        return `${base}/rest/${endpoint}?${params}`;
    }

    // Requests made by this server can use a faster address, such as Navidrome on the
    // same machine; artwork links go to browsers, so they keep the public URL.
    _serverUrl(endpoint, extra = {}) {
        return this._url(endpoint, extra, this.config.serverUrl || this.config.url);
    }

    async _call(endpoint, extra) {
        const res = await fetch(this._serverUrl(endpoint, extra), {
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status}`);

        const body = await res.json();
        const sub = body['subsonic-response'];
        if (!sub) throw new Error(`${endpoint}: not a Subsonic response`);
        if (sub.status === 'failed') {
            const msg = sub.error ? sub.error.message : 'unknown error';
            // Code 40 is bad credentials; say so plainly rather than echoing the
            // server's terser wording, since this is what the user sees on the
            // settings screen.
            if (sub.error && sub.error.code === 40) {
                throw new Error('wrong username or password');
            }
            throw new Error(msg);
        }
        return sub;
    }

    async connect() {
        if (!this.config.url) throw new Error('server URL not set');
        if (!this.config.username) throw new Error('username not set');

        this._setState('connecting');
        try {
            await this._call('ping.view');
        } catch (err) {
            this._setState('error', err.message);
            throw err;
        }

        if (/^http:/i.test(this.config.url) && !/^http:\/\/(localhost|127\.|192\.168\.|10\.)/i.test(this.config.url)) {
            this._warn(
                'connected over plain HTTP: Subsonic auth is only as private as the transport, so prefer HTTPS off your local network',
            );
        }

        this._setState('ready');
    }

    // --- browsing -----------------------------------------------------------

    /**
     * Browse paths mirror what the WebUI shows:
     *   ''                    -> top-level categories
     *   'artists'             -> all artists
     *   'artist/<id>'         -> that artist's albums
     *   'albums'              -> all albums, newest first
     *   'album/<id>'          -> that album's tracks
     *   'playlists'           -> all playlists
     *   'playlist/<id>'       -> that playlist's tracks
     */
    async browse({ path = '', offset = 0, limit = 100 } = {}) {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
            throw new Error('invalid library page');
        }
        const [kind, id] = path.split('/');

        if (!kind) {
            return {
                items: [
                    { id: 'artists', type: 'folder', title: 'Artists' },
                    { id: 'albums', type: 'folder', title: 'Albums' },
                    { id: 'playlists', type: 'folder', title: 'Playlists' },
                    { id: 'starred', type: 'folder', title: 'Starred' },
                ],
                total: 4,
            };
        }

        if (kind === 'artists') {
            const res = await this._call('getArtists.view');
            // The API returns artists bucketed by first letter; flatten them.
            const index = (res.artists && res.artists.index) || [];
            const all = index.flatMap((bucket) => bucket.artist || []);
            return {
                items: all.slice(offset, offset + limit).map((a) => ({
                    id: `artist/${a.id}`,
                    type: 'artist',
                    title: a.name,
                    subtitle: `${a.albumCount || 0} albums`,
                    artwork: a.coverArt ? this._artUrl(a.coverArt) : null,
                })),
                total: all.length,
            };
        }

        if (kind === 'artist') {
            const res = await this._call('getArtist.view', { id });
            const albums = (res.artist && res.artist.album) || [];
            return {
                items: albums.slice(offset, offset + limit).map((a) => this._albumItem(a)),
                total: albums.length,
            };
        }

        if (kind === 'albums') {
            const res = await this._call('getAlbumList2.view', {
                type: 'newest',
                size: limit,
                offset,
            });
            const albums = (res.albumList2 && res.albumList2.album) || [];
            return {
                items: albums.map((a) => this._albumItem(a)),
                // The API gives no total for this listing, so report a moving
                // target the UI can page past rather than a wrong fixed number.
                total: offset + albums.length + (albums.length === limit ? limit : 0),
            };
        }

        if (kind === 'album') {
            const res = await this._call('getAlbum.view', { id });
            const songs = (res.album && res.album.song) || [];
            return { items: songs.slice(offset, offset + limit).map((s) => this._trackItem(s)), total: songs.length };
        }

        if (kind === 'playlists') {
            const res = await this._call('getPlaylists.view');
            const lists = (res.playlists && res.playlists.playlist) || [];
            return {
                items: lists.slice(offset, offset + limit).map((p) => ({
                    id: `playlist/${p.id}`,
                    type: 'playlist',
                    title: p.name,
                    subtitle: `${p.songCount || 0} tracks`,
                    artwork: p.coverArt ? this._artUrl(p.coverArt) : null,
                })),
                total: lists.length,
            };
        }

        if (kind === 'playlist') {
            const res = await this._call('getPlaylist.view', { id });
            const songs = (res.playlist && res.playlist.entry) || [];
            return { items: songs.slice(offset, offset + limit).map((s) => this._trackItem(s)), total: songs.length };
        }

        if (kind === 'starred') {
            const res = await this._call('getStarred2.view');
            const songs = (res.starred2 && res.starred2.song) || [];
            return { items: songs.slice(offset, offset + limit).map((s) => this._trackItem(s)), total: songs.length };
        }

        throw new Error(`unknown browse path: ${path}`);
    }

    async search(query, { limit = 50 } = {}) {
        const res = await this._call('search3.view', {
            query,
            songCount: limit,
            albumCount: limit,
            artistCount: limit,
        });
        const r = res.searchResult3 || {};
        const items = [
            ...(r.artist || []).map((a) => ({
                id: `artist/${a.id}`,
                type: 'artist',
                title: a.name,
            })),
            ...(r.album || []).map((a) => this._albumItem(a)),
            ...(r.song || []).map((s) => this._trackItem(s)),
        ];
        return { items, total: items.length };
    }

    _albumItem(a) {
        return {
            id: `album/${a.id}`,
            type: 'album',
            title: a.name || a.album,
            subtitle: a.artist,
            artwork: a.coverArt ? this._artUrl(a.coverArt) : null,
        };
    }

    _trackItem(s) {
        return {
            id: s.id,
            type: 'track',
            title: s.title,
            subtitle: [s.artist, s.album].filter(Boolean).join(' - '),
            artist: s.artist,
            album: s.album,
            duration: s.duration,
            artwork: s.coverArt ? this._artUrl(s.coverArt) : null,
        };
    }

    _artUrl(coverArt, size = 300) {
        return this._url('getCoverArt.view', { id: coverArt, size });
    }

    // --- playback -----------------------------------------------------------

    /**
     * Play a track. Given an album or playlist, expand it into a queue so
     * next/previous work -- otherwise picking an album would play one track and
     * stop, which is not what anyone means by "play this album".
     */
    async open(item) {
        if (!item) throw new Error('nothing selected');

        const ref = typeof item === 'string' ? { id: item, type: 'track' } : item;

        if (ref.type === 'album' || ref.type === 'playlist') {
            const [kind, id] = ref.id.split('/');
            if (kind !== ref.type || !id) throw new Error('invalid album or playlist');
            const response = await this._call(kind === 'album' ? 'getAlbum.view' : 'getPlaylist.view', { id });
            const songs = kind === 'album' ? response.album?.song : response.playlist?.entry;
            // Browsing is paged; a play-container action must still queue every
            // track, in the order supplied by Navidrome.
            this._queue = (songs || []).map((song) => this._trackItem(song));
            if (!this._queue.length) throw new Error('nothing playable in that selection');
            this._queueIndex = queueStart(this._queue, ref);
            return this._openQueueItem();
        }

        // A bare track still forms a queue of one so the control layer has a
        // consistent shape to work with.
        this._queue = [ref];
        this._queueIndex = 0;
        return this._openQueueItem();
    }

    _openQueueItem() {
        const track = this._queue[this._queueIndex];
        if (!track) throw new Error('queue exhausted');
        this._current = track;

        this._emitMetadata({
            title: track.title,
            artist: track.artist || '',
            album: track.album || '',
            artwork: track.artwork || null,
            duration: track.duration || null,
        });
        this._setState('playing');

        // Ask for the original file and let our own ffmpeg do the work. The
        // server's transcoder would be a second, redundant encode -- worse
        // quality for no benefit, since the pipeline re-encodes to MP3 anyway.
        return {
            type: 'uri',
            uri: this._serverUrl('stream.view', {
                id: track.id,
                format: 'raw',
                estimateContentLength: 'true',
            }),
            seekable: true,
        };
    }

    /** Advance the queue. Returns the next handle, or null at the end. */
    async advance(step = 1) {
        const next = this._queueIndex + step;
        if (next < 0 || next >= this._queue.length) return null;
        this._queueIndex = next;
        return this._openQueueItem();
    }

    async next() {
        return this.advance(1);
    }

    async previous() {
        return this.advance(-1);
    }

    get queue() {
        return { items: this._queue, index: this._queueIndex };
    }

    async disconnect() {
        await this.close();
        this._setState('idle');
    }

    async close() {
        this._queue = [];
        this._queueIndex = -1;
        this._current = null;
        this._setState('ready');
    }
}

module.exports = { SubsonicSource };
