// SPDX-License-Identifier: GPL-3.0-only
// Liked Songs, playlists and saved albums as browse pages, and the playback request for a selection.
// Positions stay absolute: unavailable entries keep their slot, so a track's index never shifts.

const { SpotifyError } = require('./spotify-api');

const PROVIDER_PAGE_MAX = 50;
const SEARCH_LIMIT = 10;
const LIKED_WINDOW = 100; // Spotify takes at most 100 uris per play request
const CACHE_MS = 30 * 1000;
const CACHE_ENTRIES = 100;
const ID = /^[A-Za-z0-9]{1,40}$/;

const uriFor = (kind, id) => `spotify:${kind}:${id}`;
const names = (list) => (list || []).map((entry) => entry?.name).filter(Boolean).join(', ');
const count = (n, noun) => `${n} ${n === 1 ? noun : `${noun}s`}`;
const startOffset = (item) => (Number.isSafeInteger(item.startIndex) && item.startIndex >= 0 ? item.startIndex : null);

/** A cover around 300 px wide: the smallest image at least that wide, else the largest there is. */
function pickImage(images) {
    const list = (images || []).filter((image) => image?.url);
    const wide = list.filter((image) => image.width >= 300).sort((a, b) => a.width - b.width);
    return (wide[0] || list.sort((a, b) => (b.width || 0) - (a.width || 0))[0])?.url || null;
}

function trackItem(track, albumArt = null) {
    const episode = track.type === 'episode';
    const artist = episode ? track.show?.name || '' : names(track.artists);
    const item = {
        id: `${episode ? 'episode' : 'track'}/${track.id}`,
        type: 'track',
        title: track.name || 'Untitled',
        subtitle: episode ? artist : [artist, track.album?.name].filter(Boolean).join(' — '),
        artist,
        album: track.album?.name || '',
        artwork: pickImage(track.album?.images || track.images) || albumArt,
        duration: track.duration_ms ? track.duration_ms / 1000 : null,
    };
    if (track.is_playable === false) {
        return { ...item, id: `unavailable/${track.id}`, unavailable: true, subtitle: 'Not available in your country' };
    }
    return item;
}

const placeholder = (position, reason) => ({
    id: `unavailable/${position}`, type: 'track', title: 'Unavailable track',
    subtitle: reason, unavailable: true, duration: null,
});

class SpotifyLibrary {
    /** @param {import('./spotify-api').SpotifyApi} api */
    constructor(api, { now = Date.now } = {}) {
        this.api = api;
        this._now = now;
        this._cache = new Map();
        this._me = null;
        this._albumArt = new Map();
    }

    forget() {
        this._cache.clear();
        this._me = null;
    }

    /** One page of a library path, `offset` and `limit` counted from the start of the whole list. */
    browse({ path, offset = 0, limit = 100 }) {
        return this._cached(`${path}|${offset}|${limit}`, () => this._browse(path, offset, limit));
    }

    async _browse(path, offset, limit) {
        const [kind, id] = path.split('/');
        if (id !== undefined && !ID.test(id)) throw new Error('invalid Spotify item');

        if (path === 'liked') {
            const item = (entry, position) => (entry.track ? trackItem(entry.track) : placeholder(position, 'Removed'));
            return this._window('/me/tracks', offset, limit, item);
        }
        if (path === 'albums') {
            return this._window('/me/albums', offset, limit, (entry) => this._albumItem(entry.album));
        }
        if (path === 'playlists') {
            const me = await this._user();
            return this._window('/me/playlists', offset, limit, (playlist) => this._playlistItem(playlist, me));
        }
        if (kind === 'playlist' && id) return this._playlistTracks(id, offset, limit);
        if (kind === 'album' && id) return this._albumTracks(id, offset, limit);
        throw new Error('unknown Spotify browse path');
    }

    async _playlistTracks(id, offset, limit) {
        const item = (entry, position) => {
            const track = entry.item ?? entry.track;
            if (entry.is_local) {
                const local = placeholder(position, 'Local file, not playable from Spotify');
                return { ...local, title: track?.name || 'Local file' };
            }
            return track ? trackItem(track) : placeholder(position, 'Removed or not available');
        };
        try {
            return await this._window(`/playlists/${id}/items`, offset, limit, item);
        } catch (err) {
            // Development-mode apps only read playlists their user owns or collaborates on.
            if (err.kind !== 'forbidden') throw err;
            return {
                total: 1,
                unavailable: true,
                items: [{
                    id: `unavailable/${id}`, type: 'track', title: 'Tracks are not shared with this app', unavailable: true,
                    subtitle: 'Spotify only shares playlists you own or collaborate on. Play the whole playlist instead.',
                }],
            };
        }
    }

    async _albumTracks(id, offset, limit) {
        const art = await this._albumCover(id);
        return this._window(`/albums/${id}/tracks`, offset, limit, (track) => trackItem(track, art));
    }

    async _albumCover(id) {
        if (!this._albumArt.has(id)) this._albumArt.set(id, pickImage((await this.api.get(`/albums/${id}`)).images));
        return this._albumArt.get(id);
    }

    _albumItem(album) {
        const artwork = pickImage(album.images);
        this._albumArt.set(album.id, artwork);
        const tracks = album.total_tracks ? count(album.total_tracks, 'track') : '';
        return {
            id: `album/${album.id}`, type: 'album', title: album.name || 'Untitled',
            subtitle: [names(album.artists), tracks].filter(Boolean).join(' · '), artwork,
        };
    }

    _playlistItem(playlist, me) {
        const total = playlist.items?.total ?? playlist.tracks?.total;
        const owner = playlist.owner?.id !== me.id && playlist.owner?.display_name ? `by ${playlist.owner.display_name}` : '';
        const tracks = Number.isInteger(total) ? count(total, 'track') : '';
        return {
            id: `playlist/${playlist.id}`, type: 'playlist', title: playlist.name || 'Untitled',
            subtitle: [owner, tracks].filter(Boolean).join(' · '), artwork: pickImage(playlist.images),
        };
    }

    async _user() {
        this._me ||= await this.api.me();
        return this._me;
    }

    async _window(path, offset, limit, map) {
        const items = [];
        let total = 0;
        for (let at = offset; items.length < limit;) {
            const want = Math.min(PROVIDER_PAGE_MAX, limit - items.length);
            const page = await this.api.get(path, { offset: at, limit: want });
            total = Number.isInteger(page.total) ? page.total : total;
            const entries = page.items || [];
            entries.forEach((entry, i) => items.push(map(entry, at + i)));
            at += entries.length;
            if (!entries.length || at >= total) break;
        }
        return { items, total };
    }

    async search(query) {
        const result = await this.api.get('/search', { q: query, type: 'track,album,playlist', limit: SEARCH_LIMIT });
        const me = await this._user();
        const usable = (page) => (page?.items || []).filter(Boolean);
        const items = [
            ...usable(result.tracks).map((track) => ({ ...trackItem(track), group: 'Songs' })),
            ...usable(result.albums).map((album) => ({ ...this._albumItem(album), group: 'Albums' })),
            ...usable(result.playlists).map((playlist) => ({ ...this._playlistItem(playlist, me), group: 'Playlists' })),
        ];
        return { items, total: items.length };
    }

    /**
     * What to send Spotify for a selection: the play request body, and what to look for in the player
     * to know it took (`itemUri` for a known track, else the `contextUri`).
     */
    async target(item) {
        const [kind, id] = String(item?.id || '').split('/');
        if (kind === 'unavailable') throw new Error(item.subtitle || 'Spotify cannot play that.');
        if (id !== undefined && !ID.test(id)) throw new Error('invalid Spotify item');
        if (kind === 'track' || kind === 'episode') {
            const uri = uriFor(kind, id);
            return { body: { uris: [uri] }, itemUri: uri, contextUri: null };
        }
        if (item?.id === 'liked') return this._likedTarget(item);
        if (kind === 'album' || kind === 'playlist') return this._contextTarget(kind, id, item);
        throw new Error('select a Spotify song, album or playlist');
    }

    async _contextTarget(kind, id, item) {
        const contextUri = uriFor(kind, id);
        const body = { context_uri: contextUri };
        const start = this._startOf(item);
        if (!start) return { body, itemUri: null, contextUri };

        // A playlist can change between listing and playing, so the saved position is checked first.
        let position = startOffset(item);
        if (position !== null && kind === 'playlist') {
            const page = await this.api.get(`/playlists/${id}/items`, { offset: position, limit: 1 });
            const [entry] = page.items || [];
            if ((entry?.item ?? entry?.track)?.uri !== start.uri) position = null;
        }
        body.offset = position !== null ? { position } : { uri: start.uri };
        return { body, itemUri: start.uri, contextUri };
    }

    async _likedTarget(item) {
        const start = this._startOf(item);
        const uris = [];
        for (let at = startOffset(item) ?? 0; uris.length < LIKED_WINDOW;) {
            const want = Math.min(PROVIDER_PAGE_MAX, LIKED_WINDOW - uris.length);
            const page = await this.api.get('/me/tracks', { offset: at, limit: want });
            const entries = page.items || [];
            uris.push(...entries.map((entry) => entry.track?.uri).filter(Boolean));
            at += entries.length;
            if (!entries.length || at >= page.total) break;
        }
        // Songs saved since the list was drawn move everything down; the selected one is found again.
        let queue = uris;
        if (start) {
            const at = uris.indexOf(start.uri);
            if (at < 0) throw new Error('that song is no longer in Liked Songs; refresh and try again');
            queue = uris.slice(at);
        }
        if (!queue.length) throw new Error('Liked Songs is empty');
        return { body: { uris: queue }, itemUri: queue[0], contextUri: null };
    }

    _startOf(item) {
        if (item.startId === undefined) return null;
        const [kind, id] = String(item.startId).split('/');
        if (!['track', 'episode'].includes(kind) || !ID.test(id || '')) {
            throw new SpotifyError('not-found', 'That track is not available to play from Spotify.');
        }
        return { uri: uriFor(kind, id) };
    }

    _cached(key, load) {
        const hit = this._cache.get(key);
        if (hit && this._now() - hit.at < CACHE_MS) return hit.promise;
        const promise = load();
        this._cache.set(key, { at: this._now(), promise });
        promise.catch(() => {
            if (this._cache.get(key)?.promise === promise) this._cache.delete(key);
        });
        while (this._cache.size > CACHE_ENTRIES) this._cache.delete(this._cache.keys().next().value);
        return promise;
    }
}

module.exports = { SpotifyLibrary, pickImage, trackItem };
