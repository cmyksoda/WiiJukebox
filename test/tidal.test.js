// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { TidalSource } = require('../src/sources/tidal');

const manifest = (body) => Buffer.from(JSON.stringify(body)).toString('base64');
const track = (id, extra = {}) => ({
    id, title: `Song ${id}`, duration: 200, allowStreaming: true,
    artist: { name: 'Artist' }, album: { title: 'Album', cover: 'aaaa-bbbb-cccc' }, ...extra,
});

// A small stand-in for auth.tidal.com and api.tidal.com.
async function fakeTidal({ pollsBeforeApproval = 1 } = {}) {
    const state = { polls: 0, refreshes: 0, requests: [], expireNext: false };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://fixture');
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            const form = Object.fromEntries(new URLSearchParams(body));
            const send = (status, json) => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(json));
            };
            state.requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), form, auth: req.headers.authorization });
            if (url.pathname === '/auth/device_authorization') {
                return send(200, { deviceCode: 'dev-1', userCode: 'ABCDE', verificationUri: 'link.tidal.com',
                    verificationUriComplete: 'link.tidal.com/ABCDE', expiresIn: 300, interval: 1 });
            }
            if (url.pathname === '/auth/token' && form.grant_type.includes('device_code')) {
                return ++state.polls <= pollsBeforeApproval
                    ? send(400, { status: 400, error: 'authorization_pending', sub_status: 1002 })
                    : send(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer' });
            }
            if (url.pathname === '/auth/token' && form.grant_type === 'refresh_token') {
                state.refreshes++;
                return send(200, { access_token: `access-${state.refreshes + 1}`, expires_in: 3600 });
            }
            if (state.expireNext) {
                state.expireNext = false;
                return send(401, { userMessage: 'The token has expired.' });
            }
            if (url.pathname === '/api/sessions') return send(200, { sessionId: 's', countryCode: 'NL', userId: 42 });
            if (url.pathname === '/api/users/42/playlists') {
                return send(200, { totalNumberOfItems: 1, items: [{ uuid: 'pl-uuid', title: 'Mine', numberOfTracks: 2, squareImage: 'x-y-z' }] });
            }
            if (url.pathname === '/api/users/42/favorites/albums') {
                return send(200, { totalNumberOfItems: 1, items: [{ item: { id: 7, title: 'Fav Album', artist: { name: 'Artist' }, cover: 'q-r-s' } }] });
            }
            if (url.pathname === '/api/albums/7/tracks') {
                const offset = Number(url.searchParams.get('offset'));
                const all = [1, 2, 3, 4].map((n) => track(n, n === 3 ? { allowStreaming: false } : {}));
                return send(200, { totalNumberOfItems: 4, items: all.slice(offset, offset + Number(url.searchParams.get('limit'))) });
            }
            if (url.pathname === '/api/playlists/pl-uuid/tracks') return send(200, { totalNumberOfItems: 2, items: [track(10), track(11)] });
            if (url.pathname === '/api/search') {
                return send(200, { tracks: { items: [track(1)] }, albums: { items: [{ id: 7, title: 'Fav Album', artist: { name: 'Artist' } }] },
                    artists: { items: [{ id: 9, name: 'Artist' }] }, playlists: { items: [{ uuid: 'pl-uuid', title: 'Mine' }] } });
            }
            const playback = /^\/api\/tracks\/(\d+)\/playbackinfopostpaywall$/.exec(url.pathname);
            if (playback) {
                const id = playback[1];
                if (id === '2') return send(200, { manifestMimeType: 'application/dash+xml', manifest: 'AAAA' });
                if (id === '4') return send(200, { manifestMimeType: 'application/vnd.tidal.bts',
                    manifest: manifest({ urls: ['https://cdn.example/4.flac'], encryptionType: 'AES', keyId: 'k' }) });
                return send(200, { manifestMimeType: 'application/vnd.tidal.bts',
                    manifest: manifest({ urls: [`https://cdn.example/${id}.m4a`], codecs: 'mp4a.40.2', encryptionType: 'NONE' }) });
            }
            return send(404, { userMessage: 'not found' });
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { state, server, endpoints: { auth: `${base}/auth`, api: `${base}/api/` } };
}

const newSource = (fake, config = {}) => {
    const source = new TidalSource({ clientId: 'cid', clientSecret: 'secret', quality: 'HIGH', ...config },
        { tidalEndpoints: fake.endpoints });
    source.saved = {};
    source.on('credentials', (patch) => Object.assign(source.saved, patch));
    return source;
};

test('device-code sign-in stores tokens, user and country', async () => {
    const fake = await fakeTidal();
    const source = newSource(fake);
    try {
        const start = await source.action('login-start');
        assert.equal(start.userCode, 'ABCDE');
        assert.equal(start.url, 'https://link.tidal.com/ABCDE');
        assert.deepEqual(source.info().login, { userCode: 'ABCDE', url: 'https://link.tidal.com/ABCDE' });
        assert.equal(fake.state.requests[0].form.client_id, 'cid');
        assert.deepEqual(await source.action('login-poll'), { status: 'pending' });
        assert.deepEqual(await source.action('login-poll'), { status: 'ok' });
        assert.equal(source.saved.refreshToken, 'refresh-1');
        assert.equal(source.saved.userId, 42);
        assert.equal(source.saved.countryCode, 'NL');
        assert.equal(source.info().loggedIn, true);
        assert.equal(source.info().login, null);
        await assert.rejects(source.action('login-poll'), /expired/);
        await source.action('logout');
        assert.equal(source.saved.refreshToken, null);
    } finally { fake.server.close(); }
});

test('sign-in without client credentials explains what to do', async () => {
    const source = new TidalSource({ python: '/nonexistent/python' }, {});
    await assert.rejects(source.action('login-start'), /client ID and secret/);
});

test('connecting needs a saved sign-in, and an expired token is refreshed transparently', async () => {
    const fake = await fakeTidal();
    try {
        const out = newSource(fake);
        await assert.rejects(out.connect(), /not signed in/);
        assert.equal(out.state, 'error');

        const source = newSource(fake, { accessToken: 'stale', refreshToken: 'refresh-1', expiresAt: Date.now() + 3600e3, userId: 42, countryCode: 'NL' });
        fake.state.expireNext = true;
        await source.connect();
        assert.equal(fake.state.refreshes, 1);
        assert.equal(source.state, 'ready');
        const last = fake.state.requests.at(-1);
        assert.equal(last.auth, 'Bearer access-2');
        assert.equal(last.query.countryCode, 'NL');
    } finally { fake.server.close(); }
});

test('browse, search and album queues with unavailable, encrypted and segmented tracks skipped', async () => {
    const fake = await fakeTidal();
    const source = newSource(fake, { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600e3, userId: 42, countryCode: 'NL' });
    const warnings = [];
    const metadata = [];
    source.on('warning', (message) => warnings.push(message));
    source.on('metadata', (meta) => metadata.push(meta));
    try {
        await source.connect();
        assert.equal((await source.browse()).items.length, 4);
        const lists = await source.browse({ path: 'playlists' });
        assert.deepEqual(lists.items[0], { id: 'playlist/pl-uuid', type: 'playlist', title: 'Mine', subtitle: '2 tracks',
            artwork: 'https://resources.tidal.com/images/x/y/z/320x320.jpg' });
        const albums = await source.browse({ path: 'favalbums' });
        assert.equal(albums.items[0].id, 'album/7');
        const page = await source.browse({ path: 'album/7', offset: 2, limit: 2 });
        assert.equal(page.total, 4);
        assert.equal(page.items[0].unavailable, true);
        await assert.rejects(source.browse({ offset: -1 }), /invalid library page/);

        const results = await source.search('artist');
        assert.deepEqual([...new Set(results.items.map((i) => i.group))], ['Songs', 'Albums', 'Artists', 'Playlists']);

        const handle = await source.open({ id: 'album/7', type: 'album' });
        assert.equal(handle.uri, 'https://cdn.example/1.m4a');
        assert.equal(fake.state.requests.at(-1).query.audioquality, 'HIGH');
        assert.deepEqual(metadata.at(-1), { title: 'Song 1', artist: 'Artist', album: 'Album',
            artwork: 'https://resources.tidal.com/images/aaaa/bbbb/cccc/320x320.jpg', duration: 200 });
        assert.equal(source.queue.items.length, 4);
        assert.equal(source.capabilities.previous, false);

        // Track 2 is segmented-only and 4 is encrypted: both are skipped, not played.
        assert.equal((await source.next()).uri, 'https://cdn.example/3.m4a');
        assert.equal(await source.next(), null);
        assert.ok(warnings.some((w) => /segmented/.test(w)));
        assert.ok(warnings.some((w) => /encrypted/.test(w)));
        await assert.rejects(source.open({ id: '4', type: 'track', title: 'Locked' }), /encrypted/);
        await assert.rejects(source.open({ id: 'album/7', type: 'album', startId: 'gone' }), /no longer/);
        await source.close();
        assert.equal(source.queue.items.length, 0);
    } finally { fake.server.close(); }
});
