// SPDX-License-Identifier: GPL-3.0-only
// Spotify library, selection and transport against a fake accounts service, Web API and librespot.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { control } = require('../src/core/transport');
const { rig } = require('./helpers/spotify-rig');
const { waitFor } = require('./helpers/fake-binary');
const { fromThisComputer } = require('../src/web/spotify-auth');
const { pickImage } = require('../src/sources/spotify-library');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const plays = (fake) => fake.calls.filter((call) => call.path === '/me/player/play');
const lastPlay = (fake) => plays(fake).at(-1);
const titles = (page) => page.items.map((item) => item.title);

test('signing in uses PKCE and the exact loopback redirect, and keeps the refresh token on the server', async () => {
    const r = await rig({ signedIn: false });
    try {
        const info = await r.app.get('/api/sources/spotify/info');
        assert.equal(info.web.state, 'not-connected');
        const redirect = `http://127.0.0.1:${new URL(r.app.base).port}/api/spotify/callback`;
        assert.equal(info.web.redirectUri, redirect);
        assert.equal(info.web.loginUrl, `http://127.0.0.1:${new URL(r.app.base).port}/api/spotify/login`);

        const login = await fetch(info.web.loginUrl, { redirect: 'manual' });
        assert.equal(login.status, 302);
        const back = r.fake.authorize(login.headers.get('location'), { redirectUri: redirect });
        const done = await fetch(back);
        assert.equal(done.status, 200);
        assert.match(await done.text(), /Spotify is connected/);

        const saved = r.app.config.sourceConfig('spotify');
        assert.match(saved.refreshToken, /^ref-/);
        assert.equal(saved.account, 'Jaxi');
        assert.equal(saved.reconnect, false);
        const exchange = r.fake.calls.find((call) => call.form?.grant_type === 'authorization_code');
        assert.ok(exchange.form.code_verifier.length >= 43, 'the PKCE verifier was sent');
        assert.equal(exchange.form.client_secret, undefined, 'no client secret is involved');
        assert.equal((await r.app.get('/api/sources/spotify/info')).web.state, 'connected');

        const again = await fetch(back);
        assert.equal(again.status, 400, 'a sign-in link works once');
        assert.match(await again.text(), /expired or was already used/);
        const forged = await fetch(`${r.app.base}/api/spotify/callback?code=x&state=nope`);
        assert.equal(forged.status, 400);
    } finally { await r.close(); }
});

test('declining the sign-in shows a clear page and stores nothing', async () => {
    const r = await rig({ signedIn: false });
    try {
        const login = await fetch(`${r.app.base}/api/spotify/login`, { redirect: 'manual' });
        const state = new URL(login.headers.get('location')).searchParams.get('state');
        const denied = await fetch(`${r.app.base}/api/spotify/callback?error=access_denied&state=${state}`);
        assert.equal(denied.status, 400);
        assert.match(await denied.text(), /declined/);
        assert.equal(r.app.config.sourceConfig('spotify').refreshToken, null);
    } finally { await r.close(); }
});

test('an account the development-mode app does not allow is told so at sign-in and is not kept', async () => {
    const r = await rig({ signedIn: false, fake: { allowlisted: false } });
    try {
        const login = await fetch(`${r.app.base}/api/spotify/login`, { redirect: 'manual' });
        const done = await fetch(r.fake.authorize(login.headers.get('location')));
        assert.equal(done.status, 400);
        assert.match(await done.text(), /User Management/);
        assert.equal(r.app.config.sourceConfig('spotify').refreshToken, null);
        assert.equal(r.source().auth, 'not-connected');
    } finally { await r.close(); }
});

test('only a browser on the server computer can start or finish a sign-in', () => {
    assert.equal(fromThisComputer({ remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' }), true);
    assert.equal(fromThisComputer({ remoteAddress: '::ffff:127.0.0.1', localAddress: '::ffff:192.168.1.5' }), true);
    assert.equal(fromThisComputer({ remoteAddress: '192.168.1.5', localAddress: '192.168.1.5' }), true, 'the page opened by the LAN address on the same machine');
    assert.equal(fromThisComputer({ remoteAddress: '192.168.1.9', localAddress: '192.168.1.5' }), false);
});

test('no Client ID and not connected give their own messages and leave only the receiver to browse', async () => {
    const r = await rig({ spotify: { clientId: '' }, signedIn: false });
    try {
        const source = r.source();
        assert.equal(source.auth, 'no-client-id');
        assert.throws(() => source.beginLogin(), /Client ID/);
        const root = await source.browse();
        assert.deepEqual(root.items.map((item) => item.type), ['station']);
        await assert.rejects(r.play({ id: 'playlist/plRoadTrip', type: 'playlist' }), /Client ID/);

        r.app.config.updateSource('spotify', { clientId: r.fake.clientId });
        await r.app.registry.configure('spotify', {});
        assert.equal(r.source().auth, 'not-connected');
        await assert.rejects(r.play({ id: 'liked', type: 'playlist' }), /Connect Spotify account/);
        assert.equal(r.runs(), 0, 'no receiver is started for a selection that cannot play');
    } finally { await r.close(); }
});

test('access tokens refresh when they expire, and a revoked sign-in turns into Reconnect Spotify', async () => {
    const r = await rig();
    try {
        const source = await r.app.registry.connect('spotify');
        await source.browse({ path: 'liked', limit: 12 });
        const refreshes = () => r.fake.calls.filter((call) => call.form?.grant_type === 'refresh_token').length;
        assert.equal(refreshes(), 1);
        r.fake.expireAccessTokens();
        assert.equal((await source.browse({ path: 'liked', offset: 12, limit: 12 })).items.length, 12, 'the 401 is retried after a refresh');
        assert.equal(refreshes(), 2);

        const warned = new Promise((resolve) => source.once('warning', resolve));
        r.fake.revoke();
        r.fake.expireAccessTokens();
        await assert.rejects(source.browse({ path: 'liked', offset: 24, limit: 12 }), /Reconnect Spotify/);
        assert.equal(source.auth, 'reconnect');
        const saved = r.app.config.sourceConfig('spotify');
        assert.equal(saved.refreshToken, null);
        assert.equal(saved.reconnect, true);
        const info = (await r.app.get('/api/sources/spotify/info')).web;
        assert.equal(info.state, 'reconnect');
        assert.match(info.message, /Reconnect Spotify/);
        assert.deepEqual((await source.browse()).items.map((item) => item.type), ['station'], 'the manual receiver is still offered');
        assert.match(await warned, /Reconnect Spotify/);

        const login = await fetch(info.loginUrl, { redirect: 'manual' });
        await fetch(r.fake.authorize(login.headers.get('location')));
        assert.equal(r.source().auth, 'connected');
        assert.equal(r.app.config.sourceConfig('spotify').reconnect, false);
    } finally { await r.close(); }
});

test('Liked Songs page with absolute offsets whatever the Wii or web page size', async () => {
    const r = await rig();
    try {
        const source = await r.app.registry.connect('spotify');
        const pageOf = (offset, limit) => source.browse({ path: 'liked', offset, limit });
        const second = await pageOf(12, 12);
        assert.equal(second.total, 130);
        assert.deepEqual(titles(second).slice(0, 2), ['Liked Song 13', 'Liked Song 14']);
        const asked = r.fake.calls.filter((call) => call.path === '/me/tracks').at(-1).query;
        assert.deepEqual([asked.offset, asked.limit], ['12', '12']);

        const web = await pageOf(0, 100);
        assert.equal(web.items.length, 100);
        const pairs = r.fake.calls.filter((call) => call.path === '/me/tracks').slice(-2).map((call) => [call.query.offset, call.query.limit]);
        assert.deepEqual(pairs, [['0', '50'], ['50', '50']], 'one 100-item page is two provider pages of at most 50');
        const last = await pageOf(120, 12);
        assert.equal(last.items.length, 10);
        assert.equal(last.items.at(-1).title, 'Liked Song 130');

        const track = second.items[0];
        assert.equal(track.id, 'track/lk013');
        assert.equal(track.type, 'track');
        assert.equal(track.artist, 'Mika Ito');
        assert.match(track.artwork, /\/img\/alb001\.png$/);
        assert.equal(track.duration, 185);
        const calls = r.fake.calls.length;
        await pageOf(12, 12);
        assert.equal(r.fake.calls.length, calls, 'a page asked for twice in a row is served from the short cache');
    } finally { await r.close(); }
});

test('playlists keep every position, tell empty from unavailable, and albums carry their cover', async () => {
    const r = await rig();
    try {
        const source = await r.app.registry.connect('spotify');
        const lists = await source.browse({ path: 'playlists', limit: 12 });
        assert.deepEqual(titles(lists), ['Road Trip', 'Shared Mix', 'Empty One', 'Editorial Picks', 'Discover Weekly']);
        assert.equal(lists.items[0].subtitle, '130 tracks');
        assert.equal(lists.items[1].subtitle, 'by Sam · 20 tracks');
        assert.equal(lists.items[4].subtitle, 'by Spotify', 'a playlist without a count still lists');
        assert.ok(lists.items.every((item) => item.type === 'playlist' && item.artwork));

        const trip = await source.browse({ path: 'playlist/plRoadTrip', offset: 0, limit: 12 });
        assert.equal(trip.total, 130);
        assert.equal(trip.items[8].unavailable, true, 'a removed song keeps its slot');
        assert.equal(trip.items[9].title, 'Road Trip 10', 'so the songs after it keep their positions');
        assert.equal(trip.items[10].unavailable, true, 'a local file cannot be played from Connect');
        assert.equal(trip.items[4].id, trip.items[6].id, 'the same song twice stays twice');
        assert.match(trip.items[0].artwork, /\/img\/alb002\.png$/, 'a track in a playlist shows its album cover');
        assert.equal((await source.browse({ path: 'playlist/plRoadTrip', offset: 120, limit: 12 })).items.length, 10);

        const empty = await source.browse({ path: 'playlist/plEmpty', limit: 12 });
        assert.deepEqual([empty.items.length, empty.total, empty.unavailable], [0, 0, undefined]);
        for (const id of ['plEditorial', 'plDiscover']) {
            const hidden = await source.browse({ path: `playlist/${id}`, limit: 12 });
            assert.equal(hidden.unavailable, true);
            assert.equal(hidden.items.length, 1);
            assert.match(hidden.items[0].subtitle, /own or collaborate/);
        }
        assert.equal((await source.browse({ path: 'playlist/plShared', limit: 12 })).items.length, 12, 'a collaborative playlist reads');

        const saved = await source.browse({ path: 'albums', limit: 12 });
        assert.deepEqual(titles(saved), ['Paper Lanterns', 'Low Tide Radio', 'Second Spring']);
        const album = await source.browse({ path: 'album/alb002', limit: 12 });
        assert.equal(album.total, 14);
        assert.match(album.items[0].artwork, /alb002\.png$/, 'album tracks show the album cover');
        const reads = r.fake.calls.filter((call) => /^\/albums\/alb002$/.test(call.path)).length;
        await source.browse({ path: 'album/alb002', offset: 12, limit: 12 });
        assert.equal(r.fake.calls.filter((call) => /^\/albums\/alb002$/.test(call.path)).length, reads, 'the cover is asked for once');
        await assert.rejects(source.browse({ path: 'playlist/../me' }), /invalid Spotify item/);
    } finally { await r.close(); }
});

test('roots are Liked Songs, Playlists, Albums and the receiver, and search groups its results', async () => {
    const r = await rig();
    try {
        const source = await r.app.registry.connect('spotify');
        const root = await source.browse();
        assert.deepEqual(root.items.map((item) => [item.id, item.type]), [['liked', 'playlist'], ['playlists', 'folder'], ['albums', 'folder'], ['receiver', 'station']]);
        assert.equal((await source.browse({ offset: 3, limit: 12 })).items[0].id, 'receiver');
        const found = await source.search('r');
        assert.deepEqual([...new Set(found.items.map((item) => item.group))], ['Songs', 'Albums', 'Playlists']);
        assert.ok(found.items.some((item) => item.id === 'playlist/plRoadTrip'));
        const ask = r.fake.calls.find((call) => call.path === '/search').query;
        assert.equal(ask.limit, '10', 'search pages stay within Spotify\'s ten-result limit');
        assert.deepEqual((await r.app.get('/api/sources/spotify/search?q=lantern')).items.map((item) => item.group).includes('Albums'), true);
    } finally { await r.close(); }
});

test('selecting sends a context with the absolute position, or a window of Liked Songs, to the receiver', async () => {
    const r = await rig();
    try {
        await r.play({ id: 'playlist/plRoadTrip', type: 'playlist', title: 'Road Trip', startId: 'track/rt027', startIndex: 26 });
        assert.deepEqual(lastPlay(r.fake).body, { context_uri: 'spotify:playlist:plRoadTrip', offset: { position: 26 } });
        assert.equal(lastPlay(r.fake).query.device_id, 'dev-wii');
        await waitFor(() => r.app.pipeline.nowPlaying.title === 'Road Trip 27');
        assert.equal(r.runs(), 1);

        await r.play({ id: 'playlist/plRoadTrip', type: 'playlist', startId: 'track/rt005', startIndex: 6 });
        assert.deepEqual(lastPlay(r.fake).body.offset, { position: 6 }, 'a repeated song is picked by its saved position');
        await r.play({ id: 'playlist/plRoadTrip', type: 'playlist', startId: 'track/rt005', startIndex: 4 });
        assert.deepEqual(lastPlay(r.fake).body.offset, { position: 4 });

        await r.play({ id: 'playlist/plRoadTrip', type: 'playlist', startId: 'track/rt013', startIndex: 3 });
        assert.deepEqual(lastPlay(r.fake).body.offset, { uri: 'spotify:track:rt013' }, 'a playlist that changed is searched for the song');

        await r.play({ id: 'album/alb003', type: 'album', startId: 'track/al003005', startIndex: 4 });
        assert.deepEqual(lastPlay(r.fake).body, { context_uri: 'spotify:album:alb003', offset: { position: 4 } });
        await r.play({ id: 'album/alb003', type: 'album' });
        assert.deepEqual(lastPlay(r.fake).body, { context_uri: 'spotify:album:alb003' });

        await r.play({ id: 'liked', type: 'playlist', startId: 'track/lk021', startIndex: 20 });
        const window = lastPlay(r.fake).body.uris;
        assert.equal(window.length, 100, 'Spotify takes at most 100 songs a request');
        assert.deepEqual([window[0], window.at(-1)], ['spotify:track:lk021', 'spotify:track:lk120']);
        await r.play({ id: 'liked', type: 'playlist', startId: 'track/lk021', startIndex: 5 });
        assert.equal(lastPlay(r.fake).body.uris[0], 'spotify:track:lk021', 'songs saved since the list was drawn move it, not the choice');
        await assert.rejects(r.play({ id: 'liked', type: 'playlist', startId: 'track/nowhere1', startIndex: 5 }), /no longer in Liked Songs/);

        await r.play({ id: 'track/sh004', type: 'track', title: 'Shared 4' });
        assert.deepEqual(lastPlay(r.fake).body, { uris: ['spotify:track:sh004'] });
        await r.play({ id: 'playlist/plEditorial', type: 'playlist' });
        assert.deepEqual(lastPlay(r.fake).body, { context_uri: 'spotify:playlist:plEditorial' }, 'a playlist with unreadable tracks still plays whole');
        await assert.rejects(r.play({ id: 'unavailable/9', type: 'track', subtitle: 'Removed or not available' }), /Removed or not available/);

        assert.equal(r.runs(), 1, 'the receiver started once for every selection');
    } finally { await r.close(); }
});

test('selecting while the receiver runs aims it again without restarting it', async () => {
    const r = await rig();
    try {
        await r.play({ id: 'receiver', type: 'station', title: 'WiiJukebox' });
        await waitFor(() => r.runs() === 1);
        assert.equal(r.source().capabilities.pause, true, 'with an account the running receiver can be commanded');
        const child = r.source()._child.pid;
        await r.play({ id: 'album/alb001', type: 'album', startId: 'track/al001003', startIndex: 2 });
        await r.play({ id: 'album/alb002', type: 'album' });
        await r.play({ id: 'liked', type: 'playlist' });
        assert.equal(r.runs(), 1);
        assert.equal(r.source()._child.pid, child);
        assert.equal(r.app.pipeline.activeSource, r.source());
        await waitFor(() => r.app.pipeline.nowPlaying.title === 'Liked Song 1');
        assert.equal(r.app.pipeline.nowPlaying.artist, 'Mika Ito');
    } finally { await r.close(); }
});

test('pause, resume, next and previous go to Spotify and finish only when the audio has changed', async () => {
    const r = await rig({ fake: { applyDelayMs: 250 } });
    try {
        await r.play({ id: 'album/alb002', type: 'album', startId: 'track/al002003', startIndex: 2 });
        const { pipeline, config } = r.app;
        assert.equal(r.fake.player.playing, true);
        const send = (action) => control(pipeline, config, action);
        const jumps = pipeline._jump.id;

        let finished = false;
        const pausing = send('pause').then((result) => { finished = true; return result; });
        await sleep(120);
        assert.equal(finished, false, 'Spotify accepted the command but has not paused yet');
        assert.equal(pipeline.status.paused, false);
        await pausing;
        assert.equal(r.fake.player.playing, false);
        assert.equal(pipeline.status.paused, true, 'the stream holds with what Spotify reports');
        assert.ok(r.fake.paths('PUT').includes('/me/player/pause'));
        await send('pause');
        assert.equal(pipeline.status.paused, true, 'pausing what is already paused is not an error');

        await send('play');
        assert.equal(r.fake.player.playing, true);
        assert.equal(pipeline.status.paused, false);
        assert.deepEqual(lastPlay(r.fake).body, {}, 'resume sends no new selection');

        await send('next');
        assert.equal(r.fake.player.index, 3);
        await waitFor(() => pipeline.nowPlaying.title === 'Low Tide Radio 4');
        await send('previous');
        assert.equal(r.fake.player.index, 2, 'previous right after a skip goes back a song');
        await send('previous');
        assert.equal(r.fake.player.index, 1);
        await waitFor(() => pipeline.nowPlaying.title === 'Low Tide Radio 2');
        assert.equal(r.runs(), 1);
        assert.equal(pipeline.activeSource, r.source());
        assert.ok(pipeline._jump.id > jumps, 'a skip is marked so listeners can jump');

        r.fake.player.index = r.fake.player.queue.length - 1;
        assert.deepEqual(await send('next'), { ok: true, endOfQueue: true });
    } finally { await r.close(); }
});

test('a track Spotify reports under its relinked uri still counts as the one selected', async () => {
    const r = await rig();
    try {
        r.fake.knobs.relink = true;
        await r.play({ id: 'album/alb001', type: 'album', startId: 'track/al001004', startIndex: 3 });
        assert.equal(r.fake.player.index, 3);
        assert.equal(r.app.pipeline.activeSource, r.source());
    } finally { await r.close(); }
});

test('Spotify owns the queue: its own advance and changes from another app are mirrored, never replayed locally', async () => {
    const r = await rig();
    try {
        await r.play({ id: 'playlist/plShared', type: 'playlist' });
        await waitFor(() => r.app.pipeline.nowPlaying.title === 'Shared 1');
        const before = r.fake.calls.length;
        // The Spotify app on a phone skips and then pauses.
        r.fake.player.index = 5;
        r.fake.player.playing = true;
        fs.writeFileSync(path.join(r.dir, 'player.json'), JSON.stringify({ playing: true, uri: r.fake.player.queue[5].uri, name: 'Shared 6', artists: 'Alma Reyes', album: 'Second Spring', cover: null, duration: 1, version: 900 }));
        await waitFor(() => r.app.pipeline.nowPlaying.title === 'Shared 6');
        r.fake.player.playing = false;
        await waitFor(() => r.app.pipeline.status.paused === true, 3000);
        assert.equal(r.fake.calls.slice(before).filter((call) => ['/me/player/play', '/me/player/next'].includes(call.path)).length, 0,
            'WiiJukebox sent nothing: it only watched');
        assert.equal(r.app.pipeline.activeSource.queue, undefined, 'there is no local queue to advance');
        assert.equal(r.runs(), 1);
    } finally { await r.close(); }
});

test('shuffle and repeat map to Spotify when they change and when a selection starts', async () => {
    const r = await rig();
    try {
        await r.app.pipeline.setMode('shuffle', true);
        await r.app.pipeline.setMode('repeat', 'one');
        await r.play({ id: 'album/alb001', type: 'album' });
        assert.deepEqual([r.fake.player.shuffle, r.fake.player.repeat], [true, 'track'], 'chosen ahead of time, applied once playing');
        await r.app.pipeline.setMode('repeat', 'all');
        assert.equal(r.fake.player.repeat, 'context');
        await r.app.pipeline.setMode('shuffle', false);
        await r.app.pipeline.setMode('repeat', 'off');
        assert.deepEqual([r.fake.player.shuffle, r.fake.player.repeat], [false, 'off']);
        assert.equal(r.app.pipeline.status.capabilities.shuffle, true);
        assert.equal(r.app.pipeline.status.capabilities.repeat, true);
    } finally { await r.close(); }
});

test('without an account the receiver keeps its old, Stop-only controls', async () => {
    const r = await rig({ signedIn: false });
    try {
        await r.play({ id: 'receiver', type: 'station', title: 'WiiJukebox' });
        assert.deepEqual(r.source().capabilities, { stop: true, browse: true });
        assert.deepEqual(r.app.pipeline.status.capabilities.pause, undefined);
        assert.equal((await control(r.app.pipeline, r.app.config, 'pause')).code, 400);
    } finally { await r.close(); }
});

test('a restart brings the receiver back and does not start music by itself', async () => {
    const r = await rig();
    try {
        const source = r.source();
        assert.deepEqual(source.restoreItem({ id: 'playlist/plRoadTrip', type: 'playlist', startIndex: 3 }), { id: 'receiver', type: 'station', title: 'WiiJukebox', subtitle: 'Start the receiver, then pick it in the Spotify app' });
        const station = { id: 'receiver', type: 'station', title: 'WiiJukebox' };
        assert.equal(source.restoreItem(station), station);
    } finally { await r.close(); }
});

test('plays are remembered for the home screen, the bare receiver is not', async () => {
    const r = await rig();
    try {
        await r.play({ id: 'receiver', type: 'station', title: 'WiiJukebox' });
        assert.equal(r.app.web.history.list().length, 0);
        await r.play({ id: 'playlist/plRoadTrip', type: 'playlist', title: 'Road Trip', artwork: 'https://i.scdn.co/image/x' });
        assert.deepEqual(r.app.web.history.list().map((entry) => [entry.source, entry.title]), [['spotify', 'Road Trip']]);
    } finally { await r.close(); }
});

test('failures say what is wrong: no receiver, Premium, development mode, rate limits and network', async () => {
    const lost = await rig({ spotify: { deviceName: 'Other Speaker' } });
    try {
        await assert.rejects(lost.play({ id: 'liked', type: 'playlist' }), /cannot see "Other Speaker".*pick "Other Speaker"/s);
        assert.equal(lost.source()._child, null, 'the receiver is not left running without a use');
    } finally { await lost.close(); }

    const late = await rig();
    try {
        late.fake.hideDeviceFor(400);
        await late.play({ id: 'liked', type: 'playlist' });
        assert.equal(late.fake.player.playing, true, 'a receiver that registers a moment late is waited for');
    } finally { await late.close(); }

    const slow = await rig();
    try {
        slow.fake.knobs.notReady = 2;
        await slow.play({ id: 'liked', type: 'playlist' });
        assert.equal(plays(slow.fake).length, 3, 'a receiver that is listed before it takes commands is tried again');
        assert.equal(slow.fake.player.playing, true);
    } finally { await slow.close(); }

    const free = await rig({ fake: { premium: false } });
    try {
        await assert.rejects(free.play({ id: 'liked', type: 'playlist' }), /Premium is required/);
    } finally { await free.close(); }

    const dev = await rig({ fake: { allowlisted: false } });
    try {
        const source = await dev.app.registry.connect('spotify');
        await assert.rejects(source.browse({ path: 'liked' }), /User Management.*Premium/s);
        assert.equal((await dev.app.get('/api/sources/spotify/info')).web.state, 'connected', 'the sign-in itself is not blamed');
    } finally { await dev.close(); }

    const busy = await rig();
    try {
        const source = await busy.app.registry.connect('spotify');
        busy.fake.rateLimit(1, 1);
        const started = Date.now();
        assert.equal((await source.browse({ path: 'liked', limit: 12 })).items.length, 12, 'a short Retry-After is waited out once');
        assert.ok(Date.now() - started >= 900);
        busy.fake.rateLimit(3, 30);
        await assert.rejects(source.browse({ path: 'liked', offset: 12, limit: 12 }), /rate limiting.*30 s/);
        const hits = busy.fake.calls.length;
        await assert.rejects(source.browse({ path: 'liked', offset: 24, limit: 12 }), /try again in (29|30) s/);
        assert.equal(busy.fake.calls.length, hits, 'while backing off nothing more is sent');

    } finally { await busy.close(); }
});

test('an error from Spotify never echoes a token', async () => {
    const r = await rig();
    try {
        const source = await r.app.registry.connect('spotify');
        await source.browse({ path: 'liked', limit: 12 });
        const token = r.fake.calls.findLast((call) => call.auth).auth.replace('Bearer ', '');
        r.fake.inject(502, `bad gateway for ${token} and Bearer ${token}`);
        await assert.rejects(source.browse({ path: 'liked', offset: 12, limit: 12 }), (err) => {
            assert.ok(!err.message.includes(token), err.message);
            return /bad gateway/.test(err.message);
        });
        assert.ok(!r.warnings.some((message) => message.includes(token)));
    } finally { await r.close(); }
});

test('the Wii browses and plays Spotify through its 12-item pages', async () => {
    const r = await rig();
    try {
        const rows = async (query) => (await (await fetch(`${r.app.base}/api/wii/${query}`)).text()).trim().split('\n').slice(1)
            .map((line) => line.split('\t').map(decodeURIComponent));
        const browse = (ref = '', offset = 0) => rows(`browse?source=spotify&ref=${ref}&offset=${offset}`);
        const wiiPlay = async (ref) => {
            assert.equal((await fetch(`${r.app.base}/api/wii/play?source=spotify&ref=${ref}`, { method: 'POST' })).status, 200);
            await waitFor(async () => (await rows('status')).find((row) => row[0] === 'command')[3] !== 'pending');
            return (await rows('status')).find((row) => row[0] === 'command');
        };

        const root = await browse();
        assert.deepEqual(root.slice(1).map((row) => [row[2], row[3]]), [['playlist', 'Liked Songs'], ['folder', 'Playlists'], ['folder', 'Albums'], ['station', 'WiiJukebox']]);
        const playlists = await browse(root[2][1]);
        const trip = playlists[1];
        assert.equal(trip[3], 'Road Trip');
        const second = await browse(trip[1], 24);
        assert.deepEqual(second[0], ['page', '24', '130']);
        assert.equal(second.length, 13);
        const song = second[3];
        assert.equal(song[3], 'Road Trip 27');

        const command = await wiiPlay(song[1]);
        assert.deepEqual(lastPlay(r.fake).body, { context_uri: 'spotify:playlist:plRoadTrip', offset: { position: 26 } }, 'a track on page two keeps its absolute position');
        assert.equal(command[1], 'Audio ready');
        assert.equal(command[3], 'complete');
        assert.equal(r.fake.player.playing, true, 'the Wii was told Audio ready only once Spotify was playing');

        const whole = await wiiPlay(playlists[1][1]);
        assert.equal(whole[3], 'complete');
        assert.deepEqual(lastPlay(r.fake).body, { context_uri: 'spotify:playlist:plRoadTrip' });
        const liked = await browse(root[1][1], 12);
        assert.equal(liked[1][3], 'Liked Song 13');
        await wiiPlay(liked[2][1]);
        assert.equal(lastPlay(r.fake).body.uris[0], 'spotify:track:lk014');
        assert.equal(r.runs(), 1);

        const status = await rows('status');
        assert.match(status[0][5], /pause/);
        const paused = await fetch(`${r.app.base}/api/wii/control?action=pause`, { method: 'POST' });
        assert.equal(paused.status, 200);
        await waitFor(async () => (await rows('status')).find((row) => row[0] === 'command')[3] === 'complete');
        assert.equal(r.fake.player.playing, false);
        assert.equal((await rows('status')).find((row) => row[0] === 'command')[1], 'Paused');

        const blocked = await browse(playlists[4][1]);
        assert.equal(blocked[1][2], 'track', 'unreadable contents arrive as one explaining row');
        assert.match(blocked[1][3], /not shared/);
    } finally { await r.close(); }
});

test('the settings form never hands the sign-in back, and the page cannot write it', async () => {
    const r = await rig();
    try {
        const settings = await r.app.get('/api/sources/spotify/settings');
        assert.deepEqual([settings.values.clientId, settings.values.account, settings.secrets.refreshToken], [r.fake.clientId, 'Jaxi', true]);
        assert.equal(JSON.stringify(settings).includes('ref-'), false);

        const saved = r.app.config.sourceConfig('spotify').refreshToken;
        await r.app.post('/api/sources/spotify/config', { deviceName: 'Living Room', refreshToken: 'planted', account: 'Someone' });
        const now = r.app.config.sourceConfig('spotify');
        assert.deepEqual([now.refreshToken, now.account, now.deviceName], [saved, 'Jaxi', 'Living Room']);
        assert.equal(r.source().auth, 'connected', 'other settings keep the account');
    } finally { await r.close(); }
});

test('a new Client ID drops the account tied to the old one, and Disconnect forgets the sign-in', async () => {
    const r = await rig();
    try {
        await r.app.post('/api/sources/spotify/config', { clientId: ' another-client ' });
        const now = r.app.config.sourceConfig('spotify');
        assert.deepEqual([now.clientId, now.refreshToken, now.account], ['another-client', null, '']);
        assert.equal(r.source().auth, 'not-connected');
    } finally { await r.close(); }

    const again = await rig();
    try {
        const out = await again.app.post('/api/sources/spotify/action/disconnect-account', {});
        assert.equal(out.status, 200);
        const saved = again.app.config.sourceConfig('spotify');
        assert.deepEqual([saved.refreshToken, saved.account], [null, '']);
        assert.equal(again.source().auth, 'not-connected');
    } finally { await again.close(); }
});

test('covers are chosen by size', () => {
    const images = [{ url: 'big', width: 640 }, { url: 'mid', width: 300 }, { url: 'small', width: 64 }];
    assert.equal(pickImage(images), 'mid');
    assert.equal(pickImage([{ url: 'a', width: 64 }, { url: 'b', width: 200 }]), 'b');
    assert.equal(pickImage([]), null);
    assert.equal(pickImage(undefined), null);
});
