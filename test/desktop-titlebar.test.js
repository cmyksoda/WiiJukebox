// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const lib = path.join(__dirname, '..', 'packaging', 'desktop', 'lib');
const { windowTitle, TitleFeed } = require(path.join(lib, 'window-title'));
const { layoutViews, BAR_HEIGHT } = require(path.join(lib, 'window-layout'));
const { Settings } = require(path.join(lib, 'settings'));
const { tempDir } = require('./helpers/fake-binary');

const playing = (extra = {}) => ({
    source: { id: 'subsonic', label: 'Navidrome' },
    nowPlaying: { title: 'SPITFIRE', artist: 'Skrillex & Hawaii Slim' },
    paused: false,
    queue: { position: 2, total: 34 },
    ...extra,
});

test('the window title names the song, the artist and the place in the list, like Feishin', () => {
    assert.equal(windowTitle(playing()), '(2 / 34) SPITFIRE — Skrillex & Hawaii Slim — WiiJukebox');
    assert.equal(windowTitle(playing({ paused: true })), '(Paused) (2 / 34) SPITFIRE — Skrillex & Hawaii Slim — WiiJukebox');
});

test('the title leaves out what the server does not know and falls back to the plain name', () => {
    assert.equal(windowTitle(playing({ queue: null })), 'SPITFIRE — Skrillex & Hawaii Slim — WiiJukebox', 'a station has no list');
    assert.equal(windowTitle(playing({ queue: undefined })), 'SPITFIRE — Skrillex & Hawaii Slim — WiiJukebox', 'an older server has no queue field');
    assert.equal(windowTitle(playing({ nowPlaying: { title: 'SPITFIRE', artist: '' } })), '(2 / 34) SPITFIRE — WiiJukebox');
    assert.equal(windowTitle(playing({ nowPlaying: { title: '  Intro  ' } })), '(2 / 34) Intro — WiiJukebox');
    for (const queue of [{ position: 0, total: 5 }, { position: 6, total: 5 }, { position: 1, total: 0 }, { position: 1.5, total: 5 }, { position: '1', total: '5' }, {}]) {
        assert.equal(windowTitle(playing({ queue })), 'SPITFIRE — Skrillex & Hawaii Slim — WiiJukebox', `${JSON.stringify(queue)} is not a place`);
    }
    for (const status of [null, undefined, {}, playing({ source: null }), playing({ nowPlaying: { title: '' } }), playing({ nowPlaying: null }), playing({ nowPlaying: { title: 42 } })]) {
        assert.equal(windowTitle(status), 'WiiJukebox');
    }
    assert.equal(windowTitle({ ...playing({ source: null }), paused: true }), 'WiiJukebox', 'nothing playing is never "paused"');
});

test('the title feed reports changes only, shows the plain name without a server and stops while paused', async () => {
    const answers = [playing(), playing(), playing({ paused: true })];
    const seen = [];
    const asked = [];
    let url = 'http://127.0.0.1:4980/';
    let broken = false;
    const feed = new TitleFeed({
        getUrl: () => url,
        onTitle: (title) => seen.push(title),
        fetchImpl: async (target) => {
            asked.push(target);
            if (broken) throw new Error('connection refused');
            return { ok: true, json: async () => answers.shift() };
        },
    });
    await feed.poll();
    await feed.poll();
    await feed.poll();
    assert.deepEqual(seen, ['(2 / 34) SPITFIRE — Skrillex & Hawaii Slim — WiiJukebox', '(Paused) (2 / 34) SPITFIRE — Skrillex & Hawaii Slim — WiiJukebox']);
    assert.equal(asked[0], 'http://127.0.0.1:4980/api/status');

    broken = true;
    await feed.poll();
    assert.equal(seen.at(-1), 'WiiJukebox', 'a server that does not answer shows the plain name');

    feed.pause();
    url = null;
    asked.length = 0;
    await feed.poll();
    assert.deepEqual(asked, []);
    assert.equal(seen.at(-1), 'WiiJukebox');
    feed.resume();
    await feed.poll();
    assert.deepEqual(asked, [], 'with no server there is nothing to ask');
});

test('the title feed starts and stops its own timer', async () => {
    const feed = new TitleFeed({ getUrl: () => null, onTitle: () => {}, intervalMs: 5 });
    feed.start();
    const timer = feed.timer;
    feed.start();
    assert.equal(feed.timer, timer, 'starting twice keeps one timer');
    feed.stop();
    assert.equal(feed.timer, null);
});

test('the page sits under the bar, and fills the window when the bar steps aside', () => {
    assert.deepEqual(layoutViews({ width: 1280, height: 820, showBar: true }), {
        bar: { x: 0, y: 0, width: 1280, height: BAR_HEIGHT },
        page: { x: 0, y: BAR_HEIGHT, width: 1280, height: 820 - BAR_HEIGHT },
    });
    assert.deepEqual(layoutViews({ width: 1920, height: 1080, showBar: false }), {
        bar: null,
        page: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    const squashed = layoutViews({ width: 100, height: 10, showBar: true });
    assert.equal(squashed.bar.height, 10, 'a window shorter than the bar is all bar');
    assert.equal(squashed.page.height, 0);
});

test('the system title bar is off until chosen, and a mistyped value is ignored', () => {
    const file = path.join(tempDir(), 'settings.json');
    const fresh = new Settings(file);
    assert.equal(fresh.get('systemTitleBar'), false);
    fresh.set('systemTitleBar', true);
    assert.equal(new Settings(file).get('systemTitleBar'), true);
    require('node:fs').writeFileSync(file, JSON.stringify({ systemTitleBar: 'yes' }));
    assert.equal(new Settings(file).get('systemTitleBar'), false);
});
