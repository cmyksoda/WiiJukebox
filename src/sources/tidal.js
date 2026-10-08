// SPDX-License-Identifier: GPL-3.0-only
// Tidal, signed in with the user's own subscription.
//
// The interface and login flow follow tidalapi / Mopidy-Tidal (LGPL-3.0,
// https://github.com/tamland/python-tidal): OAuth device-code login, then the
// v1 catalogue API and per-track playback info. Only unencrypted streams are
// accepted; anything that reports encryption is refused, never decrypted.
// The OAuth client identity is not bundled here. It comes from settings, or is
// read from the user's own installed tidalapi package.

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Source } = require('./base');
const { queueStart } = require('./queue');

const run = promisify(execFile);

const AUTH_BASE = 'https://auth.tidal.com/v1/oauth2';
const API_BASE = 'https://api.tidal.com/v1/';
const IMAGE_BASE = 'https://resources.tidal.com/images';
const SCOPE = 'r_usr w_usr w_sub';
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 12; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/91.0.4472.114 Safari/537.36';
const REQUEST_TIMEOUT_MS = 15000;
const REFRESH_MARGIN_MS = 60000;
const QUEUE_PAGE = 100;
const MAX_QUEUE = 1000;
const QUALITIES = ['LOW', 'HIGH', 'LOSSLESS'];

const imageUrl = (uuid, size = 320) => (uuid
    ? `${IMAGE_BASE}/${String(uuid).replaceAll('-', '/')}/${size}x${size}.jpg` : null);

class TidalSource extends Source {
    static id = 'tidal';
    static label = 'Tidal';
    static family = 'pull';

    constructor(config = {}, deps = {}) {
        super(config, deps);
        this._queue = [];
        this._queueIndex = -1;
        this._login = null;
    }

    get _endpoints() {
        return { auth: AUTH_BASE, api: API_BASE, ...this.deps.tidalEndpoints };
    }

    get capabilities() {
        return {
            play: true,
            pause: true,
            stop: true,
            next: this._queueIndex + 1 < this._queue.length,
            previous: this._queueIndex > 0,
            browse: true,
            search: true,
            queue: true,
        };
    }

    info() {
        return {
            loggedIn: Boolean(this.config.refreshToken),
            userId: this.config.userId || null,
            countryCode: this.config.countryCode || null,
            quality: this._quality,
            hasClientCredentials: Boolean(this.config.clientId && this.config.clientSecret),
            login: this._login && Date.now() < this._login.expiresAt
                ? { userCode: this._login.userCode, url: this._login.url } : null,
        };
    }

    get _quality() {
        return QUALITIES.includes(this.config.quality) ? this.config.quality : 'HIGH';
    }

    // --- sign-in -------------------------------------------------------------

    async _clientCredentials() {
        if (this.config.clientId && this.config.clientSecret) {
            return { id: this.config.clientId, secret: this.config.clientSecret };
        }
        try {
            const code = 'import json, tidalapi; c = tidalapi.Config(); print(json.dumps([c.client_id, c.client_secret]))';
            const { stdout } = await run(this.config.python || 'python3', ['-I', '-c', code], { timeout: 10000 });
            const [id, secret] = JSON.parse(stdout);
            if (id && secret) return { id, secret };
        } catch { /* fall through to the explanation below */ }
        throw new Error('Tidal needs an OAuth client ID and secret. Enter them in the Tidal settings, ' +
            'or install the Python package "tidalapi" so they can be read from it.');
    }

    async _form(url, fields) {
        const res = await (this.deps.fetch || fetch)(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
            body: new URLSearchParams(fields),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        let body = {};
        try { body = await res.json(); } catch { /* error bodies are optional */ }
        return { ok: res.ok, status: res.status, body };
    }

    async action(name) {
        if (name === 'login-start') return this._loginStart();
        if (name === 'login-poll') return this._loginPoll();
        if (name === 'logout') {
            this._login = null;
            this._queue = [];
            this._queueIndex = -1;
            this._saveTokens({ accessToken: null, refreshToken: null, expiresAt: 0, userId: null, countryCode: null });
            this._setState('idle');
            return { ok: true };
        }
        throw new Error(`unknown Tidal action: ${name}`);
    }

    async _loginStart() {
        const client = await this._clientCredentials();
        const { ok, body } = await this._form(`${this._endpoints.auth}/device_authorization`,
            { client_id: client.id, scope: SCOPE });
        if (!ok || !body.deviceCode) {
            throw new Error(`Tidal refused the sign-in request${body.error_description ? `: ${body.error_description}` : ''}`);
        }
        const link = String(body.verificationUriComplete || body.verificationUri || 'link.tidal.com');
        this._login = {
            deviceCode: body.deviceCode,
            userCode: body.userCode,
            url: /^https?:\/\//.test(link) ? link : `https://${link}`,
            expiresAt: Date.now() + (Number(body.expiresIn) || 300) * 1000,
            interval: Number(body.interval) || 2,
        };
        return { userCode: this._login.userCode, url: this._login.url,
            expiresIn: Math.round((this._login.expiresAt - Date.now()) / 1000), interval: this._login.interval };
    }

    async _loginPoll() {
        const login = this._login;
        if (!login || Date.now() >= login.expiresAt) {
            this._login = null;
            throw new Error('the Tidal sign-in code expired; start again');
        }
        const client = await this._clientCredentials();
        const { ok, body } = await this._form(`${this._endpoints.auth}/token`, {
            client_id: client.id, client_secret: client.secret, device_code: login.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code', scope: SCOPE,
        });
        if (!ok) {
            if (body.error === 'authorization_pending' || body.sub_status === 1002) return { status: 'pending' };
            this._login = null;
            throw new Error(body.error === 'expired_token' ? 'the Tidal sign-in code expired; start again'
                : `Tidal sign-in failed${body.error_description ? `: ${body.error_description}` : ''}`);
        }
        this._login = null;
        this._applyToken(body);
        const session = await this._api('sessions');
        this._saveTokens({ userId: session.userId ?? body.user?.userId ?? null, countryCode: session.countryCode || null });
        return { status: 'ok' };
    }

    _applyToken(body) {
        this._saveTokens({
            accessToken: body.access_token,
            refreshToken: body.refresh_token || this.config.refreshToken,
            expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
        });
    }

    // Persisted through the registry's 'credentials' hook, like Jellyfin and Subsonic.
    _saveTokens(patch) {
        Object.assign(this.config, patch);
        this.emit('credentials', patch);
    }

    async _refresh() {
        if (!this.config.refreshToken) throw new Error('not signed in to Tidal');
        const client = await this._clientCredentials();
        const { ok, body } = await this._form(`${this._endpoints.auth}/token`, {
            client_id: client.id, client_secret: client.secret, grant_type: 'refresh_token',
            refresh_token: this.config.refreshToken,
        });
        if (!ok) {
            this._saveTokens({ accessToken: null, expiresAt: 0 });
            throw new Error('the Tidal sign-in expired; sign in again');
        }
        this._applyToken(body);
    }

    // --- API -----------------------------------------------------------------

    async _api(path, params = {}, retried = false) {
        if (!this.config.accessToken || Date.now() > (this.config.expiresAt || 0) - REFRESH_MARGIN_MS) {
            await this._refresh();
        }
        const url = new URL(path, this._endpoints.api);
        url.searchParams.set('countryCode', this.config.countryCode || 'US');
        url.searchParams.set('limit', '50');
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        }
        const res = await (this.deps.fetch || fetch)(url, {
            headers: { authorization: `Bearer ${this.config.accessToken}`, 'User-Agent': USER_AGENT,
                'x-tidal-client-version': '2025.7.16' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.status === 401 && !retried) {
            await this._refresh();
            return this._api(path, params, true);
        }
        let body = {};
        try { body = await res.json(); } catch { /* non-JSON error pages */ }
        if (!res.ok) throw new Error(`Tidal: ${body.userMessage || body.error_description || `HTTP ${res.status}`}`);
        return body;
    }

    async connect() {
        this._setState('connecting');
        try {
            if (!this.config.refreshToken) throw new Error('not signed in to Tidal');
            const session = await this._api('sessions');
            this._saveTokens({ userId: session.userId ?? this.config.userId, countryCode: session.countryCode || this.config.countryCode });
        } catch (err) {
            this._setState('error', err.message);
            throw err;
        }
        this._setState('ready');
    }

    // --- items ---------------------------------------------------------------

    _trackItem(track) {
        const artist = track.artist?.name || track.artists?.[0]?.name || '';
        const album = track.album?.title || '';
        return {
            id: String(track.id),
            type: 'track',
            title: track.version ? `${track.title} (${track.version})` : track.title,
            subtitle: [artist, album].filter(Boolean).join(' - '),
            artist,
            album,
            duration: track.duration || null,
            artwork: imageUrl(track.album?.cover),
            unavailable: track.allowStreaming === false,
        };
    }

    _albumItem(album) {
        return {
            id: `album/${album.id}`, type: 'album', title: album.title,
            subtitle: album.artist?.name || album.artists?.[0]?.name || '', artwork: imageUrl(album.cover),
        };
    }

    _playlistItem(playlist) {
        return {
            id: `playlist/${playlist.uuid}`, type: 'playlist', title: playlist.title,
            subtitle: `${playlist.numberOfTracks ?? 0} tracks`,
            artwork: imageUrl(playlist.squareImage || playlist.image),
        };
    }

    _artistItem(artist) {
        return { id: `artist/${artist.id}`, type: 'artist', title: artist.name, artwork: imageUrl(artist.picture) };
    }

    _page(items, body, offset) {
        return { items, total: Number.isFinite(body.totalNumberOfItems) ? body.totalNumberOfItems : offset + items.length };
    }

    async browse({ path = '', offset = 0, limit = 100 } = {}) {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
            throw new Error('invalid library page');
        }
        const paging = { offset, limit };
        const [kind, id] = path.split('/');
        const userId = this.config.userId;

        if (!kind) {
            return {
                items: [
                    { id: 'playlists', type: 'folder', title: 'My Playlists' },
                    { id: 'favalbums', type: 'folder', title: 'Favorite Albums' },
                    { id: 'favtracks', type: 'folder', title: 'Favorite Tracks' },
                    { id: 'favartists', type: 'folder', title: 'Favorite Artists' },
                ],
                total: 4,
            };
        }
        if (kind === 'playlists') {
            const body = await this._api(`users/${userId}/playlists`, paging);
            return this._page((body.items || []).map((p) => this._playlistItem(p)), body, offset);
        }
        if (kind === 'favalbums') {
            const body = await this._api(`users/${userId}/favorites/albums`, paging);
            return this._page((body.items || []).map((entry) => this._albumItem(entry.item)), body, offset);
        }
        if (kind === 'favtracks') {
            const body = await this._api(`users/${userId}/favorites/tracks`, paging);
            return this._page((body.items || []).map((entry) => this._trackItem(entry.item)), body, offset);
        }
        if (kind === 'favartists') {
            const body = await this._api(`users/${userId}/favorites/artists`, paging);
            return this._page((body.items || []).map((entry) => this._artistItem(entry.item)), body, offset);
        }
        if (kind === 'artist' && id) {
            const body = await this._api(`artists/${id}/albums`, paging);
            return this._page((body.items || []).map((a) => this._albumItem(a)), body, offset);
        }
        if (kind === 'album' && id) {
            const body = await this._api(`albums/${id}/tracks`, paging);
            return this._page((body.items || []).map((t) => this._trackItem(t)), body, offset);
        }
        if (kind === 'playlist' && id) {
            const body = await this._api(`playlists/${id}/tracks`, paging);
            return this._page((body.items || []).map((t) => this._trackItem(t)), body, offset);
        }
        throw new Error(`unknown browse path: ${path}`);
    }

    async search(query, { limit = 12 } = {}) {
        const q = String(query || '').trim();
        if (!q) return { items: [], total: 0 };
        const body = await this._api('search', { query: q, types: 'TRACKS,ALBUMS,ARTISTS,PLAYLISTS', limit });
        const group = (group, items) => items.map((item) => ({ ...item, group }));
        const items = [
            ...group('Songs', (body.tracks?.items || []).map((t) => this._trackItem(t))),
            ...group('Albums', (body.albums?.items || []).map((a) => this._albumItem(a))),
            ...group('Artists', (body.artists?.items || []).map((a) => this._artistItem(a))),
            ...group('Playlists', (body.playlists?.items || []).map((p) => this._playlistItem(p))),
        ];
        return { items, total: items.length };
    }

    // --- playback ------------------------------------------------------------

    async _tracksOf(kind, id) {
        const tracks = [];
        while (tracks.length < MAX_QUEUE) {
            const body = await this._api(`${kind === 'album' ? 'albums' : 'playlists'}/${id}/tracks`,
                { offset: tracks.length, limit: QUEUE_PAGE });
            const page = body.items || [];
            tracks.push(...page.map((t) => this._trackItem(t)));
            if (!page.length || tracks.length >= (body.totalNumberOfItems ?? 0)) break;
        }
        return tracks.slice(0, MAX_QUEUE);
    }

    async open(item) {
        if (!item) throw new Error('nothing selected');
        const ref = typeof item === 'string' ? { id: item, type: 'track' } : item;

        if (ref.type === 'album' || ref.type === 'playlist') {
            const [kind, id] = String(ref.id).split('/');
            if (kind !== ref.type || !id) throw new Error('invalid album or playlist');
            this._queue = await this._tracksOf(kind, id);
            if (!this._queue.length) throw new Error('nothing playable in that selection');
            this._queueIndex = queueStart(this._queue, ref);
        } else {
            this._queue = [ref];
            this._queueIndex = 0;
        }
        return this._openQueueItem();
    }

    async _openQueueItem() {
        const track = this._queue[this._queueIndex];
        if (!track) throw new Error('queue exhausted');
        const stream = await this._streamFor(track.id);
        this._emitMetadata({
            title: track.title, artist: track.artist || '', album: track.album || '',
            artwork: track.artwork || null, duration: track.duration || null,
        });
        this._setState('playing');
        return { type: 'uri', uri: stream };
    }

    async _streamFor(trackId) {
        const info = await this._api(`tracks/${encodeURIComponent(trackId)}/playbackinfopostpaywall`, {
            playbackmode: 'STREAM', audioquality: this._quality, assetpresentation: 'FULL',
        });
        const mime = String(info.manifestMimeType || '');
        if (!mime.includes('vnd.tidal.bts')) {
            throw new Error('Tidal offered this track only as a segmented stream; set the quality to High');
        }
        let manifest;
        try {
            manifest = JSON.parse(Buffer.from(info.manifest, 'base64').toString('utf8'));
        } catch {
            throw new Error('Tidal returned a playback manifest that could not be read');
        }
        if (manifest.encryptionType && manifest.encryptionType !== 'NONE') {
            throw new Error('Tidal returned an encrypted stream, which is not supported');
        }
        const uri = manifest.urls?.[0];
        if (!/^https:\/\//.test(uri || '')) throw new Error('Tidal returned no playable address for this track');
        return uri;
    }

    async advance(step = 1) {
        const direction = step >= 0 ? 1 : -1;
        let next = this._queueIndex + step;
        for (;;) {
            if (next < 0 || next >= this._queue.length) return null;
            this._queueIndex = next;
            try {
                return await this._openQueueItem();
            } catch (err) {
                this._warn(`skipping ${this._queue[next].title || 'a track'}: ${err.message}`);
                next += direction;
            }
        }
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
        if (this._state !== 'idle') this._setState('ready');
    }
}

module.exports = { TidalSource };
