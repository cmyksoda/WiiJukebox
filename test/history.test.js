// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { Pipeline } = require('../src/core/pipeline');
const { PlayHistory } = require('../src/core/history');
const { Source } = require('../src/sources/base');
const { DesktopSource } = require('../src/sources/desktop');
const { SpotifySource } = require('../src/sources/spotify');
const { tempDir } = require('./helpers/fake-binary');

const album = (n) => ({ id: `album/${n}`, type: 'album', title: `Album ${n}`, subtitle: 'Artist' });

test('history lists the newest first, merges repeats, keeps a cap and survives a restart', () => {
    const file = path.join(tempDir(), 'history.json');
    const history = new PlayHistory({ file, limit: 5 });
    for (let n = 1; n <= 8; n++) history.record('subsonic', album(n));
    assert.deepEqual(history.list().map((entry) => entry.title), ['Album 8', 'Album 7', 'Album 6', 'Album 5', 'Album 4']);

    // The same album again moves up and keeps the track it was last started on.
    history.record('subsonic', { ...album(5), startId: 't9', startIndex: 8 });
    history.record('jellyfin', album(5));
    const [jellyfin, again] = history.list();
    assert.equal(jellyfin.source, 'jellyfin');
    assert.equal(again.title, 'Album 5');
    assert.equal(again.item.startId, 't9');
    assert.equal(history.list().filter((entry) => entry.title === 'Album 5').length, 2, 'one per service');
    assert.deepEqual(history.list({ source: 'subsonic', limit: 2 }).map((entry) => entry.title), ['Album 5', 'Album 8']);

    history.flush();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'art links may hold a token');
    const reopened = new PlayHistory({ file, limit: 5 });
    assert.deepEqual(reopened.list(), history.list());
    assert.equal(reopened.list()[1].item.startIndex, 8, 'enough is kept to replay it');
});

test('history ignores a damaged file and entries it cannot keep', () => {
    const file = path.join(tempDir(), 'history.json');
    const warnings = [];
    fs.writeFileSync(file, '{ not json');
    const history = new PlayHistory({ file, warn: (message) => warnings.push(message) });
    assert.deepEqual(history.list(), []);
    assert.match(warnings[0], /unreadable/);

    const circular = { id: 'album/c', type: 'album', title: 'Loop' };
    circular.self = circular;
    assert.equal(history.record('subsonic', circular), null);
    assert.equal(history.record('subsonic', { id: 'album/big', type: 'album', title: 'Big', note: 'x'.repeat(9000) }), null);
    assert.equal(history.record('subsonic', { type: 'album', title: 'No id' }), null);
    assert.equal(history.record('subsonic', null), null);
    assert.deepEqual(history.list(), []);

    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [{ key: 'a' }, null, { key: 'k', source: 's', title: 't', item: {} }] }));
    assert.equal(new PlayHistory({ file }).list().length, 1);
});

test('history names pasted links and stations, and skips sources that cannot be replayed', () => {
    const history = new PlayHistory();
    const pipeline = Object.assign(new EventEmitter(), {
        nowPlaying: { title: 'Song Title', artist: 'The Band', artwork: 'https://img.example/cover.png' },
    });
    history.listen(pipeline);
    const start = (source, item) => pipeline.emit('attached', { source, item });

    const link = 'https://youtu.be/abc';
    start({ id: 'ytdlp', constructor: {} }, { id: link, title: link, type: 'track' });
    start({ id: 'ytmusic', constructor: {}, listTitle: 'Road Trip Mix' }, { id: 'list/https://music.youtube.com/playlist?list=PL1', title: 'https://music.youtube.com/playlist?list=PL1', type: 'playlist' });
    start({ id: 'radio', constructor: {} }, { url: 'http://radio.example/live', title: 'http://radio.example/live', type: 'station' });
    start({ id: 'radio', constructor: {} }, { url: 'http://soma.example/groove', title: 'Groove Salad', type: 'station' });
    start({ id: 'podcasts', constructor: {} }, { id: 'g1', type: 'track', title: 'Episode One', artist: 'The Show', subtitle: 'Mar 1, 2024', url: 'https://cdn.example/1.mp3' });
    start({ id: 'desktop', constructor: DesktopSource }, { id: 'alsa.monitor', type: 'station', title: 'Speakers' });
    start({ id: 'spotify', constructor: SpotifySource }, { id: 'receiver', type: 'station', title: 'WiiJukebox' });
    start({ id: 'ytdlp', constructor: {} }, undefined);

    const byTitle = Object.fromEntries(history.list().map((entry) => [entry.title, entry]));
    assert.deepEqual(Object.keys(byTitle).sort(), ['Episode One', 'Groove Salad', 'Road Trip Mix', 'Song Title', 'radio.example']);
    assert.equal(byTitle['Song Title'].subtitle, 'The Band');
    assert.equal(byTitle['Song Title'].art, 'https://img.example/cover.png');
    assert.equal(byTitle['Road Trip Mix'].subtitle, '', 'the first track is not the playlist');
    assert.equal(byTitle['Episode One'].subtitle, 'The Show');
    assert.equal(byTitle['Groove Salad'].type, 'station');
});

test('the pipeline announces a source as attached only once it has opened', async () => {
    class Quiet extends Source {
        static id = 'quiet';
        constructor(fail) { super(); this.fail = fail; }
        async open() {
            if (this.fail) throw new Error('cannot open');
            return { type: 'pcm', stream: new PassThrough() };
        }
    }
    const pipeline = new Pipeline();
    pipeline.pacer._write = () => true;
    pipeline.pacer.start();
    const attached = [];
    pipeline.on('attached', (event) => attached.push(event));
    pipeline.on('warning', () => {});
    try {
        await assert.rejects(pipeline.attach(new Quiet(true), { id: 'x' }), /cannot open/);
        assert.equal(attached.length, 0);
        const source = new Quiet(false);
        await pipeline.attach(source, { id: 'y' });
        assert.deepEqual(attached.map((event) => [event.source, event.item]), [[source, { id: 'y' }]]);
    } finally {
        await pipeline.shutdown();
    }
});
