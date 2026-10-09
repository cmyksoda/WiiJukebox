// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PlayHistory } = require('../src/core/history');
const { fakeSubsonic, fakeJellyfin, fakePlex, fakePodcasts, listen } = require('./helpers/fake-services');
const { Config } = require('../src/config');
const { harness } = require('./helpers/app-harness');

const only = (rows, id) => rows.find((row) => row.id === id);
const choose = async (app, id) => assert.equal((await app.post('/api/home/primary', { id })).status, 200);

test('the overview lists configured services with their rows and hides what is not set up', async () => {
    const navidrome = await fakeSubsonic();
    const app = await harness({ subsonic: navidrome.config, jellyfin: { url: '' } });
    try {
        const { services, recent } = await app.get('/api/home');
        assert.deepEqual(recent, []);
        const ids = services.map((service) => service.id);
        assert.deepEqual(ids.slice(0, 1), ['subsonic']);
        assert.ok(ids.includes('radio') && ids.includes('podcasts'));
        assert.ok(!ids.includes('jellyfin') && !ids.includes('plex'), 'no row for a service that is not set up');
        assert.ok(!ids.includes('spotify') && !ids.includes('airplay') && !ids.includes('desktop'), 'receivers have tiles, not rows');
        assert.deepEqual(only(services, 'subsonic').rows.map((row) => row.id), ['newest', 'frequent', 'recent']);
        assert.equal((await fetch(`${app.base}/api/home/jellyfin`)).status, 404);
        assert.equal((await fetch(`${app.base}/api/home/nowhere`)).status, 404);
        assert.equal((await fetch(`${app.base}/api/home/desktop`)).status, 404);
    } finally {
        await app.close();
        await navidrome.close();
    }
});

test('service rows reach the browser with art by proxy and without any service link or token', async () => {
    const navidrome = await fakeSubsonic({ password: 'hunter2' });
    const jellyfin = await fakeJellyfin();
    const plex = await fakePlex({ token: 'plex-secret-token' });
    const app = await harness({ subsonic: navidrome.config, jellyfin: jellyfin.config, plex: plex.config });
    try {
        const subsonic = await app.get('/api/home/subsonic');
        assert.deepEqual(subsonic.rows.map((row) => row.id), ['newest', 'frequent', 'recent']);
        assert.deepEqual(subsonic.rows.map((row) => row.items.length), [6, 4, 3]);
        const first = only(subsonic.rows, 'newest').items[0];
        assert.deepEqual([first.id, first.type, first.title, first.subtitle], ['album/n1', 'album', 'Paper Lanterns', 'Mika Ito']);

        await choose(app, 'jellyfin');
        const latest = (await app.get('/api/home/jellyfin')).rows[0];
        assert.equal(latest.title, 'Latest');
        assert.equal(latest.items[0].id, 'album/j1');

        await choose(app, 'plex');
        const plexRows = (await app.get('/api/home/plex')).rows;
        assert.deepEqual(plexRows.map((row) => row.title), ['Recently added', 'On Deck']);
        assert.equal(only(plexRows, 'recent').items[0].id, 'album/101');
        assert.deepEqual(only(plexRows, 'ondeck').items.map((item) => item.title), ['Porch Light'], 'video is left out');

        const wire = JSON.stringify([subsonic, latest, plexRows]);
        for (const secret of ['hunter2', 'plex-secret-token', 'getCoverArt', 'X-Plex-Token', navidrome.url, plex.url, jellyfin.url]) {
            assert.ok(!wire.includes(secret), `${secret} stays on the server`);
        }
        const arts = [first, latest.items[0], only(plexRows, 'recent').items[0]].map((item) => item.artwork);
        assert.ok(arts.every((art) => /^\/api\/art\/[0-9a-f]{20}$/.test(art)), arts.join());

        for (const art of arts) {
            const image = await fetch(`${app.base}${art}`);
            assert.equal(image.status, 200);
            assert.equal(image.headers.get('content-type'), 'image/png');
            assert.deepEqual([...Buffer.from(await image.arrayBuffer()).subarray(1, 4)], [80, 78, 71]);
        }
        assert.ok(navidrome.hits.some((hit) => hit.includes('getCoverArt.view') && hit.includes('id=n1')));
        assert.ok(plex.hits.some((hit) => hit.includes('/thumb') && hit.includes('X-Plex-Token=plex-secret-token')),
            'the proxy, not the browser, sends the token');
    } finally {
        await app.close();
        await Promise.all([navidrome.close(), jellyfin.close(), plex.close()]);
    }
});

test('rows are cached for a minute and fetched again after the settings change', async () => {
    const navidrome = await fakeSubsonic();
    const app = await harness({ subsonic: navidrome.config });
    const lists = () => navidrome.hits.filter((hit) => hit.includes('getAlbumList2.view')).length;
    try {
        await app.get('/api/home/subsonic');
        assert.equal(lists(), 3);
        await app.get('/api/home/subsonic');
        assert.equal(lists(), 3, 'the second visit is answered from the cache');

        const later = Date.now() + 61 * 1000;
        app.web.home.now = () => later;
        await app.get('/api/home/subsonic');
        assert.equal(lists(), 6, 'a minute later it asks again');

        await app.get('/api/home/subsonic');
        assert.equal(lists(), 6);
        assert.equal((await app.post('/api/sources/subsonic/config', { url: navidrome.url })).status, 200);
        await app.get('/api/home/subsonic');
        assert.equal(lists(), 9, 'new settings drop what was cached for that service');
    } finally {
        await app.close();
        await navidrome.close();
    }
});

test('a service that fails shows its own error while the rest of the home screen loads', async () => {
    const unwell = await fakeSubsonic();
    unwell.state.fail = true;
    const gone = await fakeJellyfin();
    const gonePort = gone.config;
    await gone.close();
    const wrong = await fakeSubsonic({ password: 'right' });
    const plex = await fakePlex();
    const podcasts = await fakePodcasts();
    const app = await harness({
        subsonic: unwell.config, jellyfin: gonePort, plex: plex.config,
        podcasts: { subscriptions: [{ feedUrl: podcasts.feeds.morning, title: 'Morning Pages', author: 'Team' }] },
    });
    try {
        const sick = await app.get('/api/home/subsonic');
        assert.equal(sick.error, undefined, 'it answered the ping, so the service is connected');
        assert.ok(sick.rows.every((row) => /HTTP 500/.test(row.error) && !row.items), 'each row carries its own note');

        await choose(app, 'jellyfin');
        const down = await app.get('/api/home/jellyfin');
        assert.ok(down.error && !down.rows, 'a service that will not connect has one error');

        await choose(app, 'plex');
        const [ok, shows] = await Promise.all([app.get('/api/home/plex'), app.get('/api/home/podcasts')]);
        assert.equal(only(ok.rows, 'recent').items.length, 3);
        assert.equal(shows.rows[0].items.length, 2);

        await choose(app, 'subsonic');

        await app.registry.configure('subsonic', { ...wrong.config, password: 'nope' });
        const badLogin = await app.get('/api/home/subsonic');
        assert.match(badLogin.error, /wrong username or password/);
        assert.equal((await app.get('/api/home')).services.length >= 3, true, 'the overview never depends on a service');
    } finally {
        await app.close();
        await Promise.all([unwell.close(), wrong.close(), plex.close(), podcasts.close()]);
    }
});

test('playing from home queues the album from the chosen track, records it and replays it', async () => {
    const navidrome = await fakeSubsonic();
    const app = await harness({ subsonic: navidrome.config });
    const subsonic = () => app.registry.get('subsonic');
    try {
        const { rows } = await app.get('/api/home/subsonic');
        const [first, second] = only(rows, 'newest').items;

        // What the web sends for a click on the third track of an album.
        const play = (item) => app.post('/api/sources/subsonic/play', item);
        assert.equal((await play({ ...first, startId: 'n1-t3', startIndex: 2 })).status, 200);
        assert.equal(subsonic().queue.items.length, 4, 'the whole album is queued');
        assert.equal(subsonic().queue.index, 2, 'starting at the clicked track');
        assert.equal(app.pipeline.activeSource.id, 'subsonic');

        let { recent } = await app.get('/api/home');
        assert.equal(recent.length, 1);
        assert.deepEqual([recent[0].source, recent[0].sourceLabel, recent[0].type, recent[0].title, recent[0].subtitle],
            ['subsonic', 'Navidrome / Subsonic', 'album', 'Paper Lanterns', 'Mika Ito']);
        assert.equal(recent[0].item.startId, 'n1-t3');
        assert.match(recent[0].artwork, /^\/api\/art\//);
        assert.ok(!JSON.stringify(recent).includes('getCoverArt'));

        // Replay with exactly what the home screen served, then play something else.
        await play({ ...recent[0].item, startId: undefined, startIndex: undefined });
        assert.equal(subsonic().queue.index, 0);
        await play(recent[0].item);
        assert.equal(subsonic().queue.index, 2, 'replay starts where the entry says');
        await play(second);
        ({ recent } = await app.get('/api/home'));
        assert.deepEqual(recent.map((entry) => entry.title), ['Low Tide Radio', 'Paper Lanterns'], 'newest first, no duplicates');

        app.web.history.flush();
        const file = path.join(app.dir, 'history.json');
        const saved = fs.readFileSync(file, 'utf8');
        assert.ok(saved.includes('getCoverArt'), 'the file keeps the real link, which the proxy resolves');
        assert.ok(!saved.includes('/api/art/'));
        assert.deepEqual(new PlayHistory({ file }).list().map((entry) => entry.title), ['Low Tide Radio', 'Paper Lanterns']);

        // A service that is no longer set up stops appearing.
        app.config.updateSource('subsonic', { url: '' });
        assert.deepEqual((await app.get('/api/home')).recent, []);
        app.config.updateSource('subsonic', navidrome.config);

        // Clearing forgets it all, on disk too, and the next play starts a fresh list.
        assert.equal((await fetch(`${app.base}/api/home/recent`, { method: 'DELETE' })).status, 200);
        assert.deepEqual((await app.get('/api/home')).recent, []);
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).entries, []);
        await play(first);
        assert.deepEqual((await app.get('/api/home')).recent.map((entry) => entry.title), ['Paper Lanterns']);
    } finally {
        await app.close();
        await navidrome.close();
    }
});

test('the podcast row merges the newest episodes and skips a feed that will not load', async () => {
    const podcasts = await fakePodcasts();
    const subscriptions = ['morning', 'maker', 'broken'].map((name) => ({ feedUrl: podcasts.feeds[name], title: name, author: '' }));
    const app = await harness({ podcasts: { subscriptions } });
    try {
        const [row] = (await app.get('/api/home/podcasts')).rows;
        assert.equal(row.title, 'New episodes');
        assert.deepEqual(row.items.map((item) => item.title),
            ['Walking the dog in the rain', 'Soldering without tears', 'A short one about tea']);
        assert.deepEqual(row.items.map((item) => item.artist), ['Morning Pages', 'Maker Hour', 'Morning Pages']);
        assert.equal(row.items[0].type, 'track');
        assert.match(row.items[0].url, /episode\.wav$/);
        assert.match(row.items[0].artwork, /^\/api\/art\//);

        await app.registry.configure('podcasts', { subscriptions: [subscriptions[2]] });
        app.web.home.forget('podcasts');
        const failed = (await app.get('/api/home/podcasts')).rows[0];
        assert.match(failed.error, /could not load the feed/, 'only when every feed fails does the row report it');
    } finally {
        await app.close();
        await podcasts.close();
    }
});

test('saved stations and links show a change at once', async () => {
    const app = await harness({ radio: { stations: [{ id: 's1', name: 'Groove Salad', url: 'http://ice.example/groove' }] } });
    try {
        const stations = async () => only((await app.get('/api/home/radio')).rows, 'saved').items;
        assert.deepEqual((await stations()).map((station) => [station.title, station.subtitle, station.type]),
            [['Groove Salad', 'ice.example', 'station']]);
        await app.post('/api/sources/radio/favorites', { url: 'http://wfmu.example/live', name: 'WFMU' });
        assert.deepEqual((await stations()).map((station) => station.title), ['Groove Salad', 'WFMU']);

        app.config.updateSource('ytdlp', { links: [{ id: 'l1', name: 'Rain sounds', url: 'https://tube.example/watch?v=1' }] });
        const rows = (await app.get('/api/home/ytdlp')).rows;
        assert.deepEqual(rows.map((row) => row.title), ['Saved links'], 'plays are under Jump back in, not a row of their own');
        assert.deepEqual(only(rows, 'saved').items.map((item) => [item.id, item.title, item.subtitle]),
            [['https://tube.example/watch?v=1', 'Rain sounds', 'tube.example']]);
        assert.deepEqual((await app.get('/api/home/ytmusic')).rows.map((row) => row.title), ['Saved links']);
    } finally {
        await app.close();
    }
});

test('the art proxy serves only links the server made, and only pictures', async () => {
    const hosts = await listen((req, res) => {
        if (req.url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<script>1</script>'); }
        if (req.url === '/vector') { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end('<svg/>'); }
        if (req.url === '/missing') { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(Buffer.from([0xff, 0xd8, 0xff]));
    });
    const app = await harness();
    const art = app.web.art;
    try {
        const status = async (link) => (await fetch(`${app.base}${link}`)).status;
        assert.equal(await status(art.link(`${hosts.url}/photo.jpg`)), 200);
        assert.equal(await status(art.link(`${hosts.url}/page`)), 502, 'not an image');
        assert.equal(await status(art.link(`${hosts.url}/vector`)), 502, 'SVG can carry script');
        assert.equal(await status(art.link(`${hosts.url}/missing`)), 502);
        assert.equal(await status('/api/art/0123456789abcdef0123'), 404, 'an unknown key');
        assert.equal(art.link('file:///etc/passwd'), null);
        assert.equal(art.link('data:text/html,<script>1</script>'), null);
        assert.equal(art.link('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA', 'an inline picture holds no link to hide');
        assert.equal(art.link(undefined), null);

        const link = art.link('https://img.example/cover.png');
        assert.deepEqual(art.restore({ id: 1, artwork: link }), { id: 1, artwork: 'https://img.example/cover.png' });
        assert.deepEqual(art.restore({ id: 1, artwork: '/api/art/ffffffffffffffffffff' }), { id: 1 }, 'a stale key drops the art');
        assert.deepEqual(art.restore({ id: 1, artwork: 'https://x.example/a.png' }), { id: 1 }, 'a raw link from a browser is never fetched');
        assert.deepEqual(art.restore({ id: 1, artwork: 'data:image/png;base64,AAAA' }), { id: 1, artwork: 'data:image/png;base64,AAAA' });

        // Anywhere in a body, both ways, and again on what is already a proxy path.
        const body = { status: { nowPlaying: { artwork: 'https://img.example/cover.png', title: 'T' } }, items: [{ artwork: 'https://img.example/a.png' }] };
        const published = art.publish(body);
        assert.ok(published.status.nowPlaying.artwork.startsWith('/api/art/') && published.items[0].artwork.startsWith('/api/art/'));
        assert.equal(body.items[0].artwork, 'https://img.example/a.png', 'the original is left alone');
        assert.deepEqual(art.publish(published), published);
        assert.deepEqual(art.restore(published), body);
    } finally {
        await app.close();
        await hosts.close();
    }
});

test('the primary is the first library service set up until one is chosen, and the only one with rows', async () => {
    const navidrome = await fakeSubsonic();
    const jellyfin = await fakeJellyfin();
    const plex = await fakePlex();
    const app = await harness({ subsonic: navidrome.config, jellyfin: jellyfin.config, plex: plex.config });
    const primary = () => app.get('/api/home/primary');
    const shown = async () => (await app.get('/api/home')).services.map((service) => service.id);
    try {
        assert.deepEqual(await primary(), { id: 'subsonic', auto: true, eligible: [
            { id: 'subsonic', label: 'Navidrome / Subsonic' }, { id: 'jellyfin', label: 'Jellyfin' }, { id: 'plex', label: 'Plex' }] });
        assert.deepEqual((await app.get('/api/home')).primary, await primary(), 'the overview carries it too');
        assert.deepEqual((await app.get('/api/sources')).sources.filter((source) => source.suggests).map((source) => source.id),
            ['subsonic', 'jellyfin', 'plex'], 'radio, podcasts, yt-dlp, YouTube Music and the receivers have no suggestions');

        let ids = await shown();
        assert.deepEqual(ids.filter((id) => ['subsonic', 'jellyfin', 'plex'].includes(id)), ['subsonic']);
        assert.ok(ids.includes('podcasts') && ids.includes('radio'), 'the other kinds keep their rows');
        assert.equal((await fetch(`${app.base}/api/home/jellyfin`)).status, 404, 'a library that is not the primary has no rows');
        assert.equal((await fetch(`${app.base}/api/home/plex`)).status, 404);

        assert.deepEqual(await app.post('/api/home/primary', { id: 'plex' }).then((res) => res.json()),
            { id: 'plex', auto: false, eligible: (await primary()).eligible });
        ids = await shown();
        assert.deepEqual(ids.filter((id) => ['subsonic', 'jellyfin', 'plex'].includes(id)), ['plex']);
        assert.equal((await fetch(`${app.base}/api/home/subsonic`)).status, 404);
        assert.equal((await fetch(`${app.base}/api/home/plex`)).status, 200);
        assert.equal(app.config.data.home.primary, 'plex');
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.equal(new Config(app.dir).load().home.primary, 'plex', 'it is in the config file');

        // Gone from the setup, the choice gives way to the automatic one and comes back with the service.
        app.config.updateSource('plex', { token: '' });
        assert.deepEqual([(await primary()).id, (await primary()).auto], ['subsonic', true]);
        app.config.updateSource('plex', plex.config);
        assert.deepEqual([(await primary()).id, (await primary()).auto], ['plex', false]);

        const refuse = async (body, pattern) => {
            const res = await app.post('/api/home/primary', body);
            assert.equal(res.status, 400, JSON.stringify(body));
            assert.match((await res.json()).error, pattern);
        };
        for (const id of ['radio', 'podcasts', 'ytdlp', 'ytmusic', 'spotify', 'nowhere', 7]) await refuse({ id }, /no suggestions/);
        await refuse({}, /name a service/);
        app.config.updateSource('jellyfin', { url: '' });
        await refuse({ id: 'jellyfin' }, /not set up/);
        assert.equal((await primary()).id, 'plex', 'a refused request changes nothing');

        assert.deepEqual((await app.post('/api/home/primary', { id: null }).then((res) => res.json())).id, 'subsonic');
        assert.equal(app.config.data.home.primary, null);
        assert.equal((await primary()).auto, true);

        // With no library at all there is nobody to be primary.
        app.config.updateSource('subsonic', { url: '' });
        app.config.updateSource('plex', { token: '' });
        assert.deepEqual(await primary(), { id: null, auto: true, eligible: [] });
    } finally {
        await app.close();
        await Promise.all([navidrome.close(), jellyfin.close(), plex.close()]);
    }
});
