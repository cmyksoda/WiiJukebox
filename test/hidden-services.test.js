// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fakeSubsonic, fakeJellyfin, fakePlex } = require('./helpers/fake-services');
const { Config } = require('../src/config');
const { harness } = require('./helpers/app-harness');

const LIBRARIES = ['subsonic', 'jellyfin', 'plex'];

async function withApp(work) {
    const navidrome = await fakeSubsonic();
    const jellyfin = await fakeJellyfin();
    const plex = await fakePlex();
    const app = await harness({ subsonic: navidrome.config, jellyfin: jellyfin.config, plex: plex.config });
    const hidden = () => app.get('/api/ui/hidden-sources').then((answer) => answer.hidden);
    const change = (body) => app.post('/api/ui/hidden-sources', body);
    try {
        await work({ app, hidden, change, navidrome });
    } finally {
        await app.close();
        await Promise.all([navidrome.close(), jellyfin.close(), plex.close()]);
        fs.rmSync(app.dir, { recursive: true, force: true });
    }
}

test('hiding is a list of known service ids the server keeps in the order the sidebar lists them', () => withApp(async ({ app, hidden, change }) => {
    assert.deepEqual(await hidden(), []);
    assert.ok((await app.get('/api/sources')).sources.every((source) => source.hidden === false));

    let res = await change({ hide: ['plex', 'radio', 'plex'] });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).hidden, ['radio', 'plex'], 'registry order, no duplicates');
    assert.deepEqual(await hidden(), ['radio', 'plex']);
    const flags = Object.fromEntries((await app.get('/api/sources')).sources.map((source) => [source.id, source.hidden]));
    assert.deepEqual([flags.radio, flags.plex, flags.subsonic], [true, true, false], 'the sources list says which are hidden');

    res = await change({ show: ['radio'], hide: ['spotify'] });
    assert.deepEqual((await res.json()).hidden, ['plex', 'spotify'], 'a request can show and hide together');
    assert.deepEqual((await (await change({})).json()).hidden, ['plex', 'spotify'], 'an empty request changes nothing');
    assert.deepEqual((await (await change({ show: ['plex', 'spotify', 'airplay'] })).json()).hidden, [], 'showing one that is not hidden is fine');

    await change({ hide: ['podcasts'] });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(new Config(app.dir).load().ui.hiddenSources, ['podcasts'], 'it is in the config file');
}));

test('a request naming something that is not a service changes nothing', () => withApp(async ({ app, hidden, change }) => {
    await change({ hide: ['radio'] });
    for (const body of [{ hide: ['nowhere'] }, { show: ['radio', 7] }, { hide: 'radio' }, { hide: [{ id: 'radio' }] }, { show: null }]) {
        const res = await change(body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.match((await res.json()).error, /known service ids/);
    }
    assert.deepEqual(await hidden(), ['radio']);
    assert.equal((await fetch(`${app.base}/api/ui/hidden-sources`, { method: 'DELETE' })).status, 404);
}));

test('ids a saved config or a stray settings write got wrong are ignored, never trusted', () => withApp(async ({ app, hidden }) => {
    app.config.data.ui = { hiddenSources: ['nowhere', 'radio', 9, null, '__proto__'] };
    assert.deepEqual(await hidden(), ['radio']);
    app.config.data.ui = { hiddenSources: 'radio' };
    assert.deepEqual(await hidden(), []);
    delete app.config.data.ui;
    assert.deepEqual(await hidden(), []);
    assert.deepEqual(new Config('/unused-test-config').data.ui, { hiddenSources: [] }, 'a fresh config hides nothing');
}));

test('a hidden service leaves the home screen and its recent plays, and its saved choice waits for it', () => withApp(async ({ app, change }) => {
    const shown = async () => (await app.get('/api/home')).services.map((service) => service.id);
    assert.ok((await shown()).includes('podcasts') && (await shown()).includes('radio'));

    await change({ hide: ['podcasts'] });
    assert.ok(!(await shown()).includes('podcasts'));
    assert.equal((await fetch(`${app.base}/api/home/podcasts`)).status, 404, 'no rows for it either');
    assert.ok((await shown()).includes('radio'), 'the others stay');

    // What was played from it stops being offered, and comes back with it.
    const { rows } = await app.get('/api/home/subsonic');
    const album = rows[0].items[0];
    await app.post('/api/sources/subsonic/play', album);
    assert.equal((await app.get('/api/home')).recent.length, 1);
    await change({ hide: ['subsonic'] });
    assert.deepEqual((await app.get('/api/home')).recent, []);
    assert.equal((await fetch(`${app.base}/api/home/subsonic`)).status, 404);
    await change({ show: ['subsonic', 'podcasts'] });
    assert.equal((await app.get('/api/home')).recent.length, 1);
    assert.ok((await shown()).includes('podcasts'));
}));

test('a hidden primary gives way to the automatic one, and a hidden service cannot be chosen', () => withApp(async ({ app, change }) => {
    const primary = () => app.get('/api/home/primary');
    assert.equal((await app.post('/api/home/primary', { id: 'plex' })).status, 200);
    assert.deepEqual([(await primary()).id, (await primary()).auto], ['plex', false]);

    await change({ hide: ['plex'] });
    const fallback = await primary();
    assert.deepEqual([fallback.id, fallback.auto], ['subsonic', true], 'the first library still showing');
    assert.deepEqual(fallback.eligible.map((entry) => entry.id), ['subsonic', 'jellyfin'], 'and Set as primary is not offered for it');
    assert.equal((await fetch(`${app.base}/api/home/plex`)).status, 404);
    assert.equal(app.config.data.home.primary, 'plex', 'the choice is kept');

    const refused = await app.post('/api/home/primary', { id: 'plex' });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /hidden.*Sidebar settings/);

    await change({ hide: ['subsonic', 'jellyfin'] });
    assert.deepEqual(await primary(), { id: null, auto: true, eligible: [] }, 'with every library hidden there is nobody');
    assert.ok((await app.get('/api/home')).services.every((service) => !LIBRARIES.includes(service.id)));

    await change({ show: ['plex', 'subsonic', 'jellyfin'] });
    assert.deepEqual([(await primary()).id, (await primary()).auto], ['plex', false], 'unhiding brings the choice back');
}));

test('hiding the service that is playing leaves the music alone', () => withApp(async ({ app, change }) => {
    const { rows } = await app.get('/api/home/subsonic');
    assert.equal((await app.post('/api/sources/subsonic/play', rows[0].items[0])).status, 200);
    assert.equal(app.pipeline.activeSource.id, 'subsonic');
    const before = (await app.get('/api/status')).nowPlaying.title;

    await change({ hide: ['subsonic'] });
    const status = await app.get('/api/status');
    assert.equal(app.pipeline.activeSource.id, 'subsonic', 'still attached');
    assert.equal(status.source.id, 'subsonic');
    assert.equal(status.nowPlaying.title, before);
    assert.ok(!status.paused);
    assert.equal((await app.post('/api/control/pause', {})).status, 200, 'and still controllable');
    assert.equal((await app.get('/api/sources')).sources.find((source) => source.id === 'subsonic').hidden, true);
}));

test('every open page hears about a change as it happens', () => withApp(async ({ app, change }) => {
    const abort = new AbortController();
    const res = await fetch(`${app.base}/events`, { signal: abort.signal });
    let text = '';
    (async () => {
        const decoder = new TextDecoder();
        try { for await (const chunk of res.body) text += decoder.decode(chunk, { stream: true }); } catch { /* closed */ }
    })();
    try {
        await change({ hide: ['plex'] });
        for (let i = 0; i < 100 && !text.includes('event: sources'); i++) await new Promise((resolve) => setTimeout(resolve, 20));
        assert.match(text, /event: sources\ndata: \{"hidden":\["plex"\]\}/);
    } finally {
        abort.abort();
    }
}));
