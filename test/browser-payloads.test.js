// SPDX-License-Identifier: GPL-3.0-only
// Everything the web server sends a browser, in a run over fake services: no service link, token or
// auth pair may be in it, and every cover has to arrive through the art proxy.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fakeSubsonic, fakeJellyfin, fakePlex, fakePodcasts } = require('./helpers/fake-services');
const { harness } = require('./helpers/app-harness');

const PROXY_PATH = /^\/api\/art\/[0-9a-f]{20}$/;
const LEAKS = [
    ['a Subsonic auth pair', /[?&](t|s)=/i],
    ['a Plex token', /X-Plex-Token/i],
    ['an api_key', /api_key/i],
    ['a token parameter', /token=/i],
    ['a getCoverArt link', /getCoverArt/],
];

/** Keeps the text of every response and event stream so one scan can cover the whole run. */
function recorder(base) {
    const seen = [];
    return {
        seen,
        async call(route, { method = 'GET', body } = {}) {
            const res = await fetch(`${base}${route}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
            const text = await res.text();
            seen.push({ route, text });
            return { status: res.status, body: text ? JSON.parse(text) : null };
        },
        async events() {
            const abort = new AbortController();
            const res = await fetch(`${base}/events`, { signal: abort.signal });
            const feed = { route: '/events', text: '' };
            seen.push(feed);
            (async () => {
                const decoder = new TextDecoder();
                try { for await (const chunk of res.body) feed.text += decoder.decode(chunk, { stream: true }); } catch { /* closed */ }
            })();
            return { feed, close: () => abort.abort() };
        },
    };
}

const artworks = (value, found = []) => {
    if (Array.isArray(value)) value.forEach((entry) => artworks(entry, found));
    else if (value && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) {
            if (key === 'artwork') found.push(entry);
            else artworks(entry, found);
        }
    }
    return found;
};

const until = async (check, what) => {
    for (let i = 0; i < 100; i++) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`timed out waiting for ${what}`);
};

test('no browser-facing response carries a service link or credential, and every cover loads by proxy', async () => {
    const navidrome = await fakeSubsonic({ password: 'hunter2' });
    const jellyfin = await fakeJellyfin();
    const plex = await fakePlex({ token: 'plex-secret-token' });
    const podcasts = await fakePodcasts();
    const app = await harness({
        subsonic: navidrome.config, jellyfin: jellyfin.config, plex: plex.config,
        podcasts: { subscriptions: [{ feedUrl: podcasts.feeds.morning, title: 'Morning Pages', author: 'Team',
            artwork: `${podcasts.url}/show/Morning Pages.png` }] },
    });
    const { seen, call, events } = recorder(app.base);
    const stream = await events();
    try {
        const get = async (route) => {
            const { status, body } = await call(route);
            assert.equal(status, 200, route);
            return body;
        };
        const browse = (id, path = '') => get(`/api/sources/${id}/browse?path=${encodeURIComponent(path)}&limit=100`);
        const play = (id, item) => call(`/api/sources/${id}/play`, { method: 'POST', body: item });

        // Idle state, every source's library, search and settings form.
        await get('/api/status');
        await get('/api/settings');
        await get('/api/sources');
        await get('/api/ui/hidden-sources');
        for (const id of ['subsonic', 'jellyfin', 'plex', 'podcasts']) {
            await get(`/api/sources/${id}/settings`);
            await get(`/api/sources/${id}/info`);
        }
        const albums = await browse('subsonic', 'albums');
        await browse('subsonic');
        await browse('subsonic', 'artists');
        await browse('subsonic', 'playlists');
        await browse('subsonic', 'playlist/p1');
        await browse('subsonic', 'starred');
        await browse('subsonic', 'album/n1');
        const found = await get('/api/sources/subsonic/search?q=lantern');
        await browse('jellyfin', 'artists');
        await browse('jellyfin', 'albums');
        await browse('jellyfin', 'album/j1');
        await get('/api/sources/jellyfin/search?q=harbor');
        await browse('plex');
        await get('/api/sources/plex/search?q=tide');
        await browse('podcasts', 'subscriptions');
        const show = await browse('podcasts', `show/${podcasts.feeds.morning}`);
        const [maker] = (await get(`/api/sources/podcasts/search?q=${encodeURIComponent(podcasts.feeds.maker)}`)).items;
        assert.match(maker.artwork, PROXY_PATH);
        const subscribed = await call('/api/sources/podcasts/action/subscribe', { method: 'POST', body: {
            feedUrl: maker.feedUrl, title: maker.title, author: maker.subtitle, artwork: maker.artwork } });
        assert.equal(subscribed.status, 200);
        assert.equal(app.config.sourceConfig('podcasts').subscriptions.at(-1).artwork, `${podcasts.url}/show/Maker%20Hour.png`,
            'a saved show keeps the real cover link, not the proxy path');
        for (const id of ['subsonic', 'jellyfin', 'plex']) {
            assert.equal((await call('/api/home/primary', { method: 'POST', body: { id } })).status, 200);
            await get(`/api/home/${id}`);
        }
        await get('/api/home/podcasts');

        // Playing: what comes back from the page is a proxy path, and playing still works.
        const [album] = albums.items;
        assert.match(album.artwork, PROXY_PATH);
        assert.equal((await play('subsonic', album)).status, 200);
        const track = found.items.find((item) => item.type === 'track');
        assert.equal((await play('subsonic', track)).status, 200);
        assert.ok(app.pipeline.nowPlaying.artwork.includes('getCoverArt'), 'the server keeps the real link, for the Wii');
        const { body: status } = await call('/api/status');
        assert.match(status.nowPlaying.artwork, PROXY_PATH);
        await until(() => stream.feed.text.includes('event: metadata'), 'a metadata event');
        await call('/api/control/pause', { method: 'POST', body: {} });
        assert.equal((await play('jellyfin', (await browse('jellyfin', 'albums')).items[0])).status, 200);
        assert.equal((await play('podcasts', show.items[0])).status, 200);
        await call('/api/control/play', { method: 'POST', body: {} });
        await call('/api/control/next', { method: 'POST', body: {} });
        const { body: settings } = await call('/api/settings');
        assert.match(settings.lastPlayed.item.artwork, PROXY_PATH, 'lastPlayed does not hand out the saved link');
        assert.match(app.config.data.lastPlayed.item.artwork, /^https?:/, 'but it is saved as the real link');
        await call('/api/home');
        stream.close();

        // Everything above, scanned together.
        const origins = [navidrome.url, jellyfin.url, plex.url];
        const covers = [];
        for (const { route, text } of seen) {
            for (const [what, pattern] of LEAKS) assert.ok(!pattern.test(text), `${route} carries ${what}`);
            for (const secret of ['hunter2', 'plex-secret-token', ...origins]) {
                // The settings form shows the address the user typed so it can be edited.
                if (/\/settings$/.test(route) && origins.includes(secret)) continue;
                assert.ok(!text.includes(secret), `${route} carries ${secret}`);
            }
            for (const art of artworks(text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : [])) {
                if (art === null) continue;
                assert.ok(PROXY_PATH.test(art) || art.startsWith('data:image/'), `${route} has artwork ${art}`);
                covers.push(art);
            }
        }
        assert.ok(seen.length > 35 && covers.length > 40, `walked ${seen.length} responses with ${covers.length} covers`);
        for (const { text } of seen.filter((entry) => entry.route === '/events')) {
            assert.match(text, /event: status/);
            assert.ok(!/api_key|t=|getCoverArt/.test(text));
        }

        // A cover from each service loads, including the Navidrome at a loopback address.
        const wanted = { subsonic: (await browse('subsonic', 'albums')).items[0], jellyfin: (await browse('jellyfin', 'albums')).items[0],
            plex: (await get('/api/home/plex')).rows[0].items[0], podcasts: show.show };
        for (const [id, item] of Object.entries(wanted)) {
            const image = await fetch(`${app.base}${item.artwork}`);
            assert.equal(image.status, 200, id);
            assert.equal(image.headers.get('content-type'), 'image/png', id);
        }
    } finally {
        stream.close();
        await app.close();
        await Promise.all([navidrome.close(), jellyfin.close(), plex.close(), podcasts.close()]);
    }
});

test('art keys come back after the server forgets them, and a stale key never breaks a play', async () => {
    const navidrome = await fakeSubsonic();
    const app = await harness({ subsonic: navidrome.config });
    try {
        const { items } = await app.get('/api/sources/subsonic/search?q=lantern');
        const track = items.find((item) => item.type === 'track');
        assert.equal((await app.post('/api/sources/subsonic/play', track)).status, 200);
        assert.equal((await fetch(`${app.base}${track.artwork}`)).status, 200);

        // What a restart does: every key is gone until something hands it out again.
        app.web.art.urls.clear();
        assert.equal((await fetch(`${app.base}${track.artwork}`)).status, 404);
        const { nowPlaying } = await app.get('/api/status');
        assert.equal(nowPlaying.artwork, track.artwork, 'a status poll registers the same key again');
        assert.equal((await fetch(`${app.base}${nowPlaying.artwork}`)).status, 200);

        app.web.art.urls.clear();
        assert.equal((await app.post('/api/sources/subsonic/play', track)).status, 200, 'a page that predates the restart can still play');
        assert.equal(app.pipeline.nowPlaying.artwork, null, 'only the cover is lost');
    } finally {
        await app.close();
        await navidrome.close();
    }
});
