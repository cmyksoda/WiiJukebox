// SPDX-License-Identifier: GPL-3.0-only
// A local stand-in for Spotify's accounts service and Web API, with a small player behind it, and a
// librespot that follows that player. Nothing here (or in the tests using it) contacts Spotify.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { listen, coverPng } = require('./fake-services');
const { SCOPES } = require('../../src/sources/spotify-api');

const json = (res, body, status = 200, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
};
const apiError = (res, status, message, reason, headers) => json(res, { error: { status, message, ...(reason ? { reason } : {}) } }, status, headers);
const id = (prefix, n, width = 3) => `${prefix}${String(n).padStart(width, '0')}`;

/**
 * `premium`, `allowlisted` and `extended` switch the account's situation; `stateFile` is where the player
 * writes what a fake librespot should be doing; `deviceDelayMs` makes the receiver appear late.
 */
async function fakeSpotify({ clientId = 'test-client-id', deviceName = 'WiiJukebox', premium = true, allowlisted = true,
    extended = false, stateFile = null, deviceDelayMs = 0, applyDelayMs = 0 } = {}) {
    const me = { id: 'jaxi', display_name: 'Jaxi' };
    const calls = [];
    const codes = new Map();
    const refreshTokens = new Set();
    const accessTokens = new Set();
    let hiddenUntil = Date.now() + deviceDelayMs;
    const knobs = { premium, allowlisted, extended, injected: [], limited: 0, retryAfter: 1 };
    let counter = 0;
    // The address is needed for the cover links in the data, so the server starts first and gets its handler below.
    let handle = () => {};
    const server = await listen((req, res, url) => handle(req, res, url));
    const origin = server.url;

    const cover = (seed) => [640, 300, 64].map((width) => ({ url: `${origin}/img/${seed}.png`, width, height: width }));
    const artist = (name) => ({ id: id('art', name.length), name, uri: `spotify:artist:${name.length}` });
    const album = (albumId, name, artistName) => ({
        id: albumId, uri: `spotify:album:${albumId}`, name, artists: [artist(artistName)], images: cover(albumId), total_tracks: 14,
    });
    const track = (trackId, name, artistName, albumId = 'alb001', albumName = 'Paper Lanterns') => ({
        id: trackId, uri: `spotify:track:${trackId}`, type: 'track', name, artists: [artist(artistName)],
        album: album(albumId, albumName, artistName), duration_ms: 180000 + trackId.length * 1000, is_playable: undefined,
    });

    // --- the account's music ----------------------------------------------------
    const liked = Array.from({ length: 130 }, (_, i) => track(id('lk', i + 1), `Liked Song ${i + 1}`, 'Mika Ito'));
    const roadTrip = Array.from({ length: 130 }, (_, i) => track(id('rt', i + 1), `Road Trip ${i + 1}`, 'Harbor Lights', 'alb002', 'Low Tide Radio'));
    roadTrip[6] = roadTrip[4]; // the same song twice
    const roadTripEntries = roadTrip.map((item) => ({ added_at: '2026-01-01T00:00:00Z', is_local: false, item }));
    roadTripEntries[8] = { added_at: null, is_local: false, item: null };
    roadTripEntries[10] = { added_at: null, is_local: true, item: { ...track('local', 'My Demo', 'Me'), id: null, uri: 'spotify:local:::My+Demo:180' } };
    const shared = Array.from({ length: 20 }, (_, i) => track(id('sh', i + 1), `Shared ${i + 1}`, 'Alma Reyes', 'alb003', 'Second Spring'));
    const playlists = [
        { id: 'plRoadTrip', name: 'Road Trip', owner: me, collaborative: false, entries: roadTripEntries },
        { id: 'plShared', name: 'Shared Mix', owner: { id: 'sam', display_name: 'Sam' }, collaborative: true,
            entries: shared.map((item) => ({ added_at: '2026-02-01T00:00:00Z', is_local: false, item })) },
        { id: 'plEmpty', name: 'Empty One', owner: me, collaborative: false, entries: [] },
        { id: 'plEditorial', name: 'Editorial Picks', owner: { id: 'spotify', display_name: 'Spotify' }, collaborative: false, hidden: true,
            entries: shared.slice(0, 12).map((item) => ({ added_at: null, is_local: false, item })) },
        // Another user's playlist whose summary carries no count at all.
        { id: 'plDiscover', name: 'Discover Weekly', owner: { id: 'spotify', display_name: 'Spotify' }, collaborative: false, hidden: true, noCount: true,
            entries: shared.slice(0, 5).map((item) => ({ added_at: null, is_local: false, item })) },
    ];
    const albums = [['alb001', 'Paper Lanterns', 'Mika Ito'], ['alb002', 'Low Tide Radio', 'Harbor Lights'], ['alb003', 'Second Spring', 'Alma Reyes']]
        .map(([albumId, name, who]) => ({
            ...album(albumId, name, who),
            tracks: Array.from({ length: 14 }, (_, i) => track(id(albumId.replace('alb', 'al'), i + 1), `${name} ${i + 1}`, who, albumId, name)),
        }));
    const contexts = (uri) => {
        const [, kind, ref] = uri.split(':');
        if (kind === 'album') return albums.find((a) => a.id === ref)?.tracks;
        // Positions count unavailable entries too, as a playlist's own numbering does.
        if (kind === 'playlist') return playlists.find((p) => p.id === ref)?.entries.map((e) => e.item);
        return null;
    };
    const everyTrack = [...liked, ...roadTrip, ...shared, ...albums.flatMap((a) => a.tracks)];

    // --- the player ------------------------------------------------------------------
    const player = { contextUri: null, queue: [], index: -1, playing: false, progressMs: 0, shuffle: false, repeat: 'off', deviceId: null, active: false };
    const devices = [{ id: 'dev-wii', name: deviceName, type: 'Speaker', is_active: false, is_private_session: false, is_restricted: false, volume_percent: 100 }];
    const deviceVisible = () => Date.now() >= hiddenUntil;
    const current = () => player.queue[player.index] || null;
    const publish = () => {
        if (!stateFile) return;
        const now = current();
        fs.writeFileSync(stateFile, JSON.stringify({
            playing: player.playing && Boolean(now), uri: now?.uri || null, name: now?.name, artists: now?.artists.map((a) => a.name).join('\n'),
            album: now?.album.name, cover: now?.album.images[1].url, duration: now?.duration_ms, version: ++counter,
        }));
    };
    const settle = (change) => {
        const apply = () => { change(); publish(); };
        if (applyDelayMs) setTimeout(apply, applyDelayMs).unref?.();
        else apply();
    };
    const playerState = () => {
        const now = current();
        if (!now) return null;
        const last = player.index >= player.queue.length - 1;
        return {
            device: devices.find((d) => d.id === player.deviceId) || null,
            repeat_state: player.repeat, shuffle_state: player.shuffle, timestamp: Date.now(), progress_ms: player.progressMs,
            is_playing: player.playing, item: now, currently_playing_type: 'track',
            context: player.contextUri ? { type: player.contextUri.split(':')[1], uri: player.contextUri } : null,
            actions: { disallows: { ...(last && player.repeat === 'off' ? { skipping_next: true } : {}), ...(player.index === 0 ? { skipping_prev: true } : {}) } },
        };
    };

    const page = (all, url, map = (x) => x) => {
        const limit = Number(url.searchParams.get('limit') ?? 20);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        if (!(limit >= 1 && limit <= 50)) return null;
        return { href: url.href, limit, offset, total: all.length, next: null, previous: null, items: all.slice(offset, offset + limit).map(map) };
    };
    const summary = (p) => ({
        id: p.id, name: p.name, owner: p.owner, collaborative: p.collaborative, public: false, images: cover(p.id), uri: `spotify:playlist:${p.id}`,
        ...(p.noCount ? {} : { items: { href: '', total: p.entries.length } }),
    });

    async function body(req) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        return Buffer.concat(chunks).toString('utf8');
    }

    // --- accounts: authorize check and token endpoint --------------------------------
    async function token(req, res) {
        const form = new URLSearchParams(await body(req));
        const record = { method: 'POST', path: '/api/token', form: Object.fromEntries(form) };
        calls.push(record);
        if (form.get('client_id') !== clientId) return json(res, { error: 'invalid_client', error_description: 'Invalid client' }, 400);
        const grant = form.get('grant_type');
        const issue = (refresh) => {
            const access = `acc-${++counter}-${crypto.randomBytes(18).toString('base64url')}`;
            accessTokens.add(access);
            return { access_token: access, token_type: 'Bearer', expires_in: 3600, scope: SCOPES.join(' '), ...(refresh ? { refresh_token: refresh } : {}) };
        };
        if (grant === 'authorization_code') {
            const saved = codes.get(form.get('code'));
            codes.delete(form.get('code'));
            const verified = saved && saved.redirect === form.get('redirect_uri')
                && crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url') === saved.challenge;
            if (!verified) return json(res, { error: 'invalid_grant', error_description: 'Invalid authorization code or verifier' }, 400);
            const refresh = `ref-${++counter}-${crypto.randomBytes(18).toString('base64url')}`;
            refreshTokens.add(refresh);
            return json(res, issue(refresh));
        }
        if (grant === 'refresh_token' && refreshTokens.has(form.get('refresh_token'))) return json(res, issue(null));
        return json(res, { error: 'invalid_grant', error_description: 'Refresh token revoked' }, 400);
    }

    // --- the Web API ------------------------------------------------------------------
    async function api(req, res, url) {
        const raw = await body(req);
        const record = { method: req.method, path: url.pathname.replace(/^\/v1/, ''), query: Object.fromEntries(url.searchParams), body: raw ? JSON.parse(raw) : null,
            auth: req.headers.authorization };
        calls.push(record);
        const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
        if (!accessTokens.has(bearer)) return apiError(res, 401, 'The access token expired');
        if (knobs.limited > 0) {
            knobs.limited--;
            return apiError(res, 429, 'API rate limit exceeded', 'RATE_LIMIT', { 'Retry-After': String(knobs.retryAfter) });
        }
        if (knobs.injected.length) {
            const { status, message, reason } = knobs.injected.shift();
            return apiError(res, status, message, reason);
        }
        if (!knobs.allowlisted) return apiError(res, 403, 'User not registered in the Developer Dashboard');
        const route = record.path;
        const send = (data) => (data ? json(res, data) : apiError(res, 400, 'Invalid limit'));

        if (route === '/me') return json(res, me);
        if (route === '/me/tracks') return send(page(liked, url, (t) => ({ added_at: '2026-03-01T00:00:00Z', track: t })));
        if (route === '/me/albums') return send(page(albums, url, (a) => ({ added_at: '2026-03-01T00:00:00Z', album: { ...a, tracks: undefined } })));
        if (route === '/me/playlists') return send(page(playlists, url, summary));
        let m = route.match(/^\/playlists\/(\w+)\/items$/);
        if (m) {
            const playlist = playlists.find((p) => p.id === m[1]);
            if (!playlist) return apiError(res, 404, 'Not found.');
            if (playlist.hidden && !knobs.extended) return apiError(res, 403, 'Forbidden');
            return send(page(playlist.entries, url));
        }
        m = route.match(/^\/albums\/(\w+)(\/tracks)?$/);
        if (m) {
            const found = albums.find((a) => a.id === m[1]);
            if (!found) return apiError(res, 404, 'Not found.');
            return m[2] ? send(page(found.tracks, url, ({ album: _album, ...simple }) => simple)) : json(res, { ...found, tracks: undefined });
        }
        if (route === '/search') {
            if (Number(url.searchParams.get('limit') || 5) > 10) return apiError(res, 400, 'Invalid limit');
            const q = (url.searchParams.get('q') || '').toLowerCase();
            const hit = (name) => name.toLowerCase().includes(q);
            return json(res, {
                tracks: { items: everyTrack.filter((t) => hit(t.name)).slice(0, 10) },
                albums: { items: albums.filter((a) => hit(a.name)).map((a) => ({ ...a, tracks: undefined })) },
                playlists: { items: [null, ...playlists.filter((p) => hit(p.name)).map(summary)] },
            });
        }
        if (route === '/me/player/devices') return json(res, { devices: deviceVisible() ? devices.map((d) => ({ ...d, is_active: d.id === player.deviceId })) : [] });
        if (route === '/me/player' && req.method === 'GET') {
            const state = playerState();
            if (!state) { res.writeHead(204); return res.end(); }
            return json(res, state);
        }
        if (!route.startsWith('/me/player')) return apiError(res, 404, 'Not found.');

        // Player commands
        if (!knobs.premium) return apiError(res, 403, 'Player command failed: Premium required', 'PREMIUM_REQUIRED');
        const device = devices.find((d) => d.id === (record.query.device_id || player.deviceId));
        if (!device || !deviceVisible()) return apiError(res, 404, 'Device not found', 'NO_ACTIVE_DEVICE');
        const done = () => { res.writeHead(204); res.end(); };
        if (route === '/me/player/play') {
            const request = record.body || {};
            let queue = player.queue;
            let index = player.index;
            let contextUri = player.contextUri;
            if (request.context_uri) {
                queue = contexts(request.context_uri);
                if (!queue) return apiError(res, 404, 'Invalid context uri');
                contextUri = request.context_uri;
                index = request.offset?.uri ? queue.findIndex((t) => t?.uri === request.offset.uri) : request.offset?.position ?? 0;
                if (!queue[index]?.id) return apiError(res, 404, 'Not found.');
            } else if (request.uris) {
                queue = request.uris.map((uri) => everyTrack.find((t) => t.uri === uri)).filter(Boolean);
                contextUri = null;
                index = 0;
                if (!queue.length) return apiError(res, 400, 'Invalid track uri');
            } else if (!queue.length) return apiError(res, 404, 'Device not found', 'NO_ACTIVE_DEVICE');
            settle(() => Object.assign(player, { queue, index, contextUri, playing: true, progressMs: 0, deviceId: device.id }));
            return done();
        }
        if (route === '/me/player/pause') {
            if (!player.playing) return apiError(res, 403, 'Player command failed: Restriction violated', 'UNKNOWN');
            settle(() => { player.playing = false; });
            return done();
        }
        if (route === '/me/player/next') {
            settle(() => {
                const playable = (at) => Boolean(player.queue[at]?.id);
                let at = player.index + 1;
                while (at < player.queue.length && !playable(at)) at++;
                if (at < player.queue.length) player.index = at;
                else if (player.repeat === 'context') player.index = 0;
                else player.playing = false;
                player.progressMs = 0;
            });
            return done();
        }
        if (route === '/me/player/previous') {
            settle(() => {
                let at = player.index - 1;
                while (at > 0 && !player.queue[at]?.id) at--;
                if (player.progressMs < 3000 && at >= 0) player.index = at;
                player.progressMs = 0;
            });
            return done();
        }
        if (route === '/me/player/shuffle') { player.shuffle = record.query.state === 'true'; return done(); }
        if (route === '/me/player/repeat') { player.repeat = record.query.state; return done(); }
        return apiError(res, 404, 'Not found.');
    }

    handle = async (req, res, url) => {
        if (url.pathname === '/api/token' && req.method === 'POST') return token(req, res);
        if (url.pathname.startsWith('/v1/')) return api(req, res, url);
        const image = url.pathname.match(/^\/img\/(\w+)\.png$/);
        if (image) {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            return res.end(coverPng(image[1]));
        }
        res.writeHead(404);
        return res.end();
    };
    publish();

    return {
        url: origin, clientId, calls, player, knobs, devices, me, libraryTracks: liked,
        deps: { spotify: { accountsBase: origin, apiBase: `${origin}/v1`, timing: { pollMs: 150, confirmPollMs: 25, confirmMs: 3000, deviceRetryMs: 25, deviceWaitMs: 300, deviceStartWaitMs: 1500 } } },
        /** Checks what the sign-in link asks for like Spotify would, then returns where it would send the browser. */
        authorize(authUrl, { redirectUri } = {}) {
            const q = new URL(authUrl).searchParams;
            const problems = [];
            if (new URL(authUrl).origin !== origin || new URL(authUrl).pathname !== '/authorize') problems.push('not the authorize endpoint');
            if (q.get('client_id') !== clientId) problems.push('client_id');
            if (q.get('response_type') !== 'code') problems.push('response_type');
            if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) problems.push('pkce');
            if (q.get('scope') !== SCOPES.join(' ')) problems.push(`scope ${q.get('scope')}`);
            if (redirectUri && q.get('redirect_uri') !== redirectUri) problems.push(`redirect_uri ${q.get('redirect_uri')}`);
            if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(q.get('redirect_uri'))) problems.push('redirect_uri is not a 127.0.0.1 loopback address');
            if (problems.length) throw new Error(`Spotify would refuse this sign-in: ${problems.join(', ')}`);
            const code = `code-${++counter}-${crypto.randomBytes(12).toString('base64url')}`;
            codes.set(code, { challenge: q.get('code_challenge'), redirect: q.get('redirect_uri') });
            return `${q.get('redirect_uri')}?code=${code}&state=${q.get('state')}`;
        },
        /** Mints a refresh token as if a sign-in had happened earlier. */
        signedIn() {
            const refresh = `ref-${++counter}-${crypto.randomBytes(18).toString('base64url')}`;
            refreshTokens.add(refresh);
            return refresh;
        },
        /** The receiver drops out of the device list for a while, as when it is still signing in. */
        hideDeviceFor(ms) { hiddenUntil = Date.now() + ms; },
        expireAccessTokens: () => accessTokens.clear(),
        revoke: () => { refreshTokens.clear(); accessTokens.clear(); },
        /** The next `count` API requests answer 429. */
        rateLimit(count, retryAfter = 1) { Object.assign(knobs, { limited: count, retryAfter }); },
        /** The next API request answers with this error. */
        inject(status, message, reason) { knobs.injected.push({ status, message, reason }); },
        accessTokenCount: () => accessTokens.size,
        paths: (method) => calls.filter((c) => !method || c.method === method).map((c) => c.path),
        close: server.close,
    };
}

/** Source for a fake librespot that plays whatever `stateFile` says, emitting PCM and the player events a real one would. */
function fakeLibrespotSource(dir, stateFile) {
    return `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('librespot 0.8.0 (fake)'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(path.join(dir, 'runs.json'))}, JSON.stringify({ pid: process.pid, args }) + '\\n');
const hook = args[args.indexOf('--onevent') + 1];
const emit = (env) => hook && spawnSync(hook, [], { env: { ...process.env, ...env } });
let seen = { version: 0, uri: null, playing: false };
setInterval(() => {
    let want;
    try { want = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8')); } catch { return; }
    if (want.version !== seen.version) {
        if (want.uri && want.uri !== seen.uri) {
            emit({ PLAYER_EVENT: 'track_changed', NAME: want.name, ARTISTS: want.artists, ALBUM: want.album, COVERS: want.cover, DURATION_MS: String(want.duration), ITEM_TYPE: 'Track' });
        }
        if (want.playing !== seen.playing) emit({ PLAYER_EVENT: want.playing ? 'playing' : 'paused', TRACK_ID: want.uri });
        seen = { version: want.version, uri: want.uri, playing: want.playing };
    }
    if (seen.playing) process.stdout.write(Buffer.alloc(3528, 5));
}, 20);
`;
}

module.exports = { fakeSpotify, fakeLibrespotSource };
