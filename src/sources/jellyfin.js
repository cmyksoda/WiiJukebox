// Jellyfin source.
//
// Two ways in, both supported:
//   - Browse the library here and play (this file).
//   - Hit "Play On" in any Jellyfin client and have it land here (cast.js).
//
// The cast half is why this registers a real device identity rather than just
// making anonymous API calls: Jellyfin only offers a client as a remote-control
// target if it has announced itself as a session, so the DeviceId below is what
// makes WiiJukebox appear in that menu.

const crypto = require('crypto');
const { Source } = require('./base');

const CLIENT_NAME = 'WiiJukebox';
const CLIENT_VERSION = '0.1.0';

class JellyfinSource extends Source {
    static id = 'jellyfin';
    static label = 'Jellyfin';
    static family = 'pull';

    constructor(config = {}, deps = {}) {
        super(config, deps);
        this._queue = [];
        this._queueIndex = -1;
        this._userId = config.userId || null;
        this._token = config.token || null;

        // Stable per-install id. Jellyfin keys sessions off this, so generating
        // a fresh one each boot would leave a trail of dead devices in the
        // server's session list.
        this._deviceId = config.deviceId || crypto.randomUUID();
    }

    get deviceId() {
        return this._deviceId;
    }

    get capabilities() {
        return {
            play: true,
            pause: true,
            stop: true,
            next: this._queue.length > 1,
            previous: this._queue.length > 1,
            seek: true,
            browse: true,
            search: true,
            queue: true,
        };
    }

    /**
     * Jellyfin wants its auth in a structured header rather than a bearer token
     * alone; the Device fields here are what show up in the server's dashboard.
     */
    _authHeader() {
        const parts = [
            `Client="${CLIENT_NAME}"`,
            `Device="${CLIENT_NAME}"`,
            `DeviceId="${this._deviceId}"`,
            `Version="${CLIENT_VERSION}"`,
        ];
        if (this._token) parts.push(`Token="${this._token}"`);
        return `MediaBrowser ${parts.join(', ')}`;
    }

    _base() {
        return String(this.config.url || '').replace(/\/+$/, '');
    }

    async _call(path, { method = 'GET', body, query } = {}) {
        const url = new URL(`${this._base()}${path}`);
        for (const [k, v] of Object.entries(query || {})) {
            if (v != null) url.searchParams.set(k, String(v));
        }

        const res = await fetch(url, {
            method,
            headers: {
                Authorization: this._authHeader(),
                'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15000),
        });

        if (res.status === 401) throw new Error('login rejected; check username and password');
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        if (res.status === 204) return null;

        const text = await res.text();
        return text ? JSON.parse(text) : null;
    }

    async connect() {
        if (!this.config.url) throw new Error('server URL not set');
        this._setState('connecting');

        try {
            if (!this._token) {
                if (!this.config.username) throw new Error('username not set');
                const auth = await this._call('/Users/AuthenticateByName', {
                    method: 'POST',
                    body: {
                        Username: this.config.username,
                        Pw: this.config.password || '',
                    },
                });
                this._token = auth.AccessToken;
                this._userId = auth.User.Id;
                // Surfaced so the caller can persist it and skip the password
                // next time.
                this.emit('credentials', {
                    token: this._token,
                    userId: this._userId,
                    deviceId: this._deviceId,
                });
            }
            await this._call('/System/Info');
        } catch (err) {
            this._setState('error', err.message);
            throw err;
        }

        this._setState('ready');
    }

    // --- browsing -----------------------------------------------------------

    async browse({ path = '', offset = 0, limit = 100 } = {}) {
        const [kind, id] = path.split('/');

        if (!kind) {
            return {
                items: [
                    { id: 'artists', type: 'folder', title: 'Artists' },
                    { id: 'albums', type: 'folder', title: 'Albums' },
                    { id: 'playlists', type: 'folder', title: 'Playlists' },
                ],
                total: 3,
            };
        }

        if (kind === 'artists') {
            const res = await this._call('/Artists', {
                query: {
                    userId: this._userId,
                    StartIndex: offset,
                    Limit: limit,
                    SortBy: 'SortName',
                },
            });
            return {
                items: (res.Items || []).map((a) => ({
                    id: `artist/${a.Id}`,
                    type: 'artist',
                    title: a.Name,
                    artwork: this._artUrl(a),
                })),
                total: res.TotalRecordCount || 0,
            };
        }

        if (kind === 'artist') {
            const res = await this._call('/Items', {
                query: {
                    userId: this._userId,
                    ArtistIds: id,
                    IncludeItemTypes: 'MusicAlbum',
                    Recursive: 'true',
                    SortBy: 'ProductionYear,SortName',
                },
            });
            return {
                items: (res.Items || []).map((a) => this._albumItem(a)),
                total: res.TotalRecordCount || 0,
            };
        }

        if (kind === 'albums') {
            const res = await this._call('/Items', {
                query: {
                    userId: this._userId,
                    IncludeItemTypes: 'MusicAlbum',
                    Recursive: 'true',
                    StartIndex: offset,
                    Limit: limit,
                    SortBy: 'DateCreated',
                    SortOrder: 'Descending',
                },
            });
            return {
                items: (res.Items || []).map((a) => this._albumItem(a)),
                total: res.TotalRecordCount || 0,
            };
        }

        if (kind === 'album' || kind === 'playlist') {
            const res = await this._call('/Items', {
                query: {
                    userId: this._userId,
                    ParentId: id,
                    IncludeItemTypes: 'Audio',
                    Recursive: 'true',
                    SortBy: kind === 'album' ? 'ParentIndexNumber,IndexNumber' : 'SortName',
                },
            });
            return {
                items: (res.Items || []).map((t) => this._trackItem(t)),
                total: res.TotalRecordCount || 0,
            };
        }

        if (kind === 'playlists') {
            const res = await this._call('/Items', {
                query: {
                    userId: this._userId,
                    IncludeItemTypes: 'Playlist',
                    Recursive: 'true',
                },
            });
            return {
                items: (res.Items || [])
                    // Jellyfin playlists can hold video; a video playlist here
                    // would just produce a queue of things that fail to decode.
                    .filter((p) => !p.MediaType || p.MediaType === 'Audio')
                    .map((p) => ({
                        id: `playlist/${p.Id}`,
                        type: 'playlist',
                        title: p.Name,
                        subtitle: `${p.ChildCount || 0} tracks`,
                        artwork: this._artUrl(p),
                    })),
                total: res.TotalRecordCount || 0,
            };
        }

        throw new Error(`unknown browse path: ${path}`);
    }

    async search(query, { limit = 50 } = {}) {
        const res = await this._call('/Items', {
            query: {
                userId: this._userId,
                SearchTerm: query,
                IncludeItemTypes: 'Audio,MusicAlbum,MusicArtist',
                Recursive: 'true',
                Limit: limit,
            },
        });
        const items = (res.Items || []).map((i) => {
            if (i.Type === 'MusicAlbum') return this._albumItem(i);
            if (i.Type === 'MusicArtist') {
                return { id: `artist/${i.Id}`, type: 'artist', title: i.Name };
            }
            return this._trackItem(i);
        });
        return { items, total: res.TotalRecordCount || items.length };
    }

    _albumItem(a) {
        return {
            id: `album/${a.Id}`,
            type: 'album',
            title: a.Name,
            subtitle: a.AlbumArtist || (a.Artists || []).join(', '),
            artwork: this._artUrl(a),
        };
    }

    _trackItem(t) {
        return {
            id: t.Id,
            type: 'track',
            title: t.Name,
            subtitle: [(t.Artists || []).join(', '), t.Album].filter(Boolean).join(' - '),
            artist: (t.Artists || []).join(', '),
            album: t.Album,
            // Jellyfin reports ticks: 10,000,000 per second.
            duration: t.RunTimeTicks ? Math.round(t.RunTimeTicks / 10000000) : null,
            artwork: this._artUrl(t),
        };
    }

    _artUrl(item) {
        if (!item) return null;
        // Tracks usually carry no art of their own but inherit the album's.
        const id = item.AlbumId || item.Id;
        const tag =
            (item.ImageTags && item.ImageTags.Primary) ||
            item.AlbumPrimaryImageTag ||
            null;
        if (!id || !tag) return null;
        return `${this._base()}/Items/${id}/Images/Primary?maxHeight=300&tag=${tag}`;
    }

    // --- playback -----------------------------------------------------------

    async open(item) {
        if (!item) throw new Error('nothing selected');
        const ref = typeof item === 'string' ? { id: item, type: 'track' } : item;

        if (ref.type === 'album' || ref.type === 'playlist') {
            const { items } = await this.browse({ path: ref.id });
            this._queue = items.filter((i) => i.type === 'track');
            this._queueIndex = 0;
            if (!this._queue.length) throw new Error('nothing playable in that selection');
        } else {
            this._queue = [ref];
            this._queueIndex = 0;
        }
        return this._openQueueItem();
    }

    _openQueueItem() {
        const track = this._queue[this._queueIndex];
        if (!track) throw new Error('queue exhausted');

        this._emitMetadata({
            title: track.title,
            artist: track.artist || '',
            album: track.album || '',
            artwork: track.artwork || null,
            duration: track.duration || null,
        });
        this._setState('playing');

        // /Audio/{id}/stream with static=true hands back the original file
        // untouched. Anything else asks Jellyfin's transcoder for a second
        // encode we would only decode again.
        const url = new URL(`${this._base()}/Audio/${track.id}/stream`);
        url.searchParams.set('static', 'true');
        url.searchParams.set('DeviceId', this._deviceId);

        return {
            type: 'uri',
            uri: url.toString(),
            headers: { Authorization: this._authHeader() },
        };
    }

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

    async close() {
        this._queue = [];
        this._queueIndex = -1;
        this._setState('ready');
    }
}

module.exports = { JellyfinSource };
