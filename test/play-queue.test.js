// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PlayQueue } = require('../src/sources/queue');
const { SubsonicSource } = require('../src/sources/subsonic');
const { YtdlpSource } = require('../src/sources/ytdlp');
const { Listening } = require('../src/core/listening');
const { BYTES_PER_SECOND } = require('../src/core/format');
const { tempDir, fakeBinary } = require('./helpers/fake-binary');

function seeded(seed) {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const tracks = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `Track ${i}` }));
const ids = (queue, count) => {
    const out = [queue.current.id];
    while (out.length < count && queue.next()) out.push(queue.current.id);
    return out;
};

test('an ordered queue walks forward and back and stops at both ends', () => {
    const queue = new PlayQueue();
    queue.load(tracks(3));
    assert.equal(queue.current.id, 't0');
    assert.deepEqual([queue.canNext, queue.canPrevious], [true, false]);
    assert.equal(queue.previous(), null);
    assert.equal(queue.next().id, 't1');
    assert.equal(queue.next().id, 't2');
    assert.deepEqual([queue.canNext, queue.canPrevious], [false, true]);
    assert.equal(queue.next(), null);
    assert.equal(queue.current.id, 't2', 'a refused move keeps the current track');
    assert.equal(queue.previous().id, 't1');
});

test('repeat-one replays a track that ends, while explicit Next and Previous still move', () => {
    const queue = new PlayQueue();
    queue.load(tracks(3), { startId: 't1' });
    queue.setRepeat('one');
    assert.equal(queue.advance().id, 't1');
    assert.equal(queue.advance().id, 't1');
    assert.equal(queue.next().id, 't2');
    assert.equal(queue.advance().id, 't2');
    assert.equal(queue.next(), null, 'repeat-one does not wrap the list');
    assert.equal(queue.previous().id, 't1');
    queue.setRepeat('off');
    assert.equal(queue.advance().id, 't2', 'with repeat off a finished track moves on');
    assert.equal(queue.advance(), null);
});

test('repeat-all wraps after the last track and Previous crosses the wrap', () => {
    const queue = new PlayQueue();
    queue.load(tracks(3), { startId: 't2' });
    assert.equal(queue.canNext, false);
    queue.setRepeat('all');
    assert.equal(queue.canNext, true);
    assert.equal(queue.advance().id, 't0');
    assert.equal(queue.index, 0);
    assert.equal(queue.previous().id, 't2');
    assert.equal(queue.next().id, 't0');
    assert.deepEqual(ids(queue, 7), ['t0', 't1', 't2', 't0', 't1', 't2', 't0']);
    assert.equal(queue.previous().id, 't2');
    assert.equal(queue.previous().id, 't1');
});

test('a one-track queue repeats itself under repeat-all and only then', () => {
    const queue = new PlayQueue();
    queue.load(tracks(1));
    assert.equal(queue.advance(), null);
    queue.setRepeat('all');
    assert.equal(queue.advance().id, 't0');
    assert.equal(queue.advance().id, 't0');
    queue.setShuffle(true);
    assert.equal(queue.next().id, 't0');
});

test('shuffle plays a picked track first and every other track once', () => {
    for (let seed = 1; seed <= 25; seed++) {
        const queue = new PlayQueue({ random: seeded(seed) });
        queue.setShuffle(true);
        queue.load(tracks(8), { startId: 't5', startIndex: 5 });
        assert.equal(queue.current.id, 't5');
        const order = ids(queue, 20);
        assert.equal(order.length, 8);
        assert.deepEqual([...order].sort(), tracks(8).map((t) => t.id).sort());
        assert.equal(queue.index, queue.items.findIndex((t) => t.id === order.at(-1)), 'index is the original position');
    }
});

test('shuffling a whole list starts on a random track', () => {
    const starts = new Set();
    for (let seed = 1; seed <= 40; seed++) {
        const queue = new PlayQueue({ random: seeded(seed) });
        queue.setShuffle(true);
        queue.load(tracks(6));
        starts.add(queue.current.id);
    }
    assert.ok(starts.size >= 4, `started on ${starts.size} different tracks`);
    const last = new PlayQueue({ random: () => 0.999 });
    last.setShuffle(true);
    last.load(tracks(6));
    assert.equal(last.current.id, 't5');
});

test('Previous walks back through what played under shuffle, and Next replays the same order', () => {
    const queue = new PlayQueue({ random: seeded(7) });
    queue.setShuffle(true);
    queue.load(tracks(6), { startId: 't3', startIndex: 3 });
    assert.equal(queue.canPrevious, false);
    const played = [queue.current.id, queue.next().id, queue.next().id, queue.next().id];
    assert.deepEqual([queue.previous().id, queue.previous().id, queue.previous().id], played.slice(0, 3).reverse());
    assert.equal(queue.previous(), null);
    assert.deepEqual([queue.next().id, queue.next().id, queue.next().id], played.slice(1));
});

test('turning shuffle on mid-queue keeps what played and shuffles what is left; off continues in order', () => {
    const queue = new PlayQueue({ random: seeded(3) });
    queue.load(tracks(8));
    queue.next();
    queue.next();
    queue.setShuffle(true);
    assert.equal(queue.current.id, 't2');
    assert.equal(queue.previous().id, 't1');
    assert.equal(queue.previous().id, 't0');
    queue.next();
    queue.next();
    const rest = ids(queue, 20).slice(1);
    assert.equal(rest.length, 5);
    assert.deepEqual([...rest].sort(), ['t3', 't4', 't5', 't6', 't7']);
    assert.notDeepEqual(rest, ['t3', 't4', 't5', 't6', 't7']);

    const again = new PlayQueue({ random: seeded(11) });
    again.setShuffle(true);
    again.load(tracks(8), { startId: 't5', startIndex: 5 });
    again.next();
    const current = again.current.id;
    again.setShuffle(false);
    assert.equal(again.current.id, current);
    const following = ids(again, 20).slice(1);
    const expected = tracks(8).map((t) => t.id).slice(Number(current.slice(1)) + 1);
    assert.deepEqual(following, expected, 'the rest follows the original order');
    assert.equal(again.previous().id, expected.at(-2) ?? current);
});

test('shuffled repeat-all reshuffles each pass and never repeats a track across the boundary', () => {
    for (let seed = 1; seed <= 60; seed++) {
        const queue = new PlayQueue({ random: seeded(seed) });
        queue.setShuffle(true);
        queue.setRepeat('all');
        queue.load(tracks(4));
        const order = ids(queue, 40);
        assert.equal(order.length, 40);
        for (let pass = 0; pass < 10; pass++) {
            assert.deepEqual(order.slice(pass * 4, pass * 4 + 4).sort(), ['t0', 't1', 't2', 't3'], 'each pass plays everything once');
        }
        for (let i = 1; i < order.length; i++) assert.notEqual(order[i], order[i - 1], `seed ${seed} position ${i}`);
    }
    const passes = new Set();
    const queue = new PlayQueue({ random: seeded(5) });
    queue.setShuffle(true);
    queue.setRepeat('all');
    queue.load(tracks(6));
    const order = ids(queue, 60);
    for (let pass = 0; pass < 10; pass++) passes.add(order.slice(pass * 6, pass * 6 + 6).join());
    assert.ok(passes.size > 5, 'passes differ from each other');
});

test('the boundary rule compares track ids, so a duplicated song does not play twice running', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'a' }];
    for (let seed = 1; seed <= 60; seed++) {
        const queue = new PlayQueue({ random: seeded(seed) });
        queue.setShuffle(true);
        queue.setRepeat('all');
        queue.load(items);
        const order = ids(queue, 30);
        for (let at = 3; at < order.length; at += 3) assert.notEqual(order[at], order[at - 1], `seed ${seed} pass ${at / 3}`);
    }
});

test('repeat-all history stays bounded to the last two passes', () => {
    const queue = new PlayQueue();
    queue.setRepeat('all');
    queue.load(tracks(3));
    ids(queue, 300);
    assert.ok(queue.save().order.length <= 6);
    assert.equal(queue.previous().id, queue.items[queue.index].id);
    assert.ok(queue.canPrevious);
});

test('a failed move can be put back', () => {
    const queue = new PlayQueue();
    queue.setRepeat('all');
    queue.load(tracks(3), { startId: 't2' });
    const before = queue.save();
    queue.next();
    queue.restore(before);
    assert.equal(queue.current.id, 't2');
    assert.equal(queue.next().id, 't0');
});

test('expanding the current entry splices its tracks in and respects the limit', () => {
    const queue = new PlayQueue();
    queue.load([{ id: 'a' }, { id: 'tab' }, { id: 'z' }], { startId: 'tab' });
    queue.expandCurrent([{ id: 'x' }, { id: 'y' }], 10);
    assert.deepEqual(queue.items.map((t) => t.id), ['a', 'x', 'y', 'z']);
    assert.equal(queue.current.id, 'x');
    assert.equal(queue.next().id, 'y');
    assert.equal(queue.next().id, 'z');
    assert.equal(queue.previous().id, 'y');

    const capped = new PlayQueue();
    capped.load([{ id: 'tab' }, { id: 'z' }]);
    capped.expandCurrent([{ id: 'x' }, { id: 'y' }, { id: 'w' }], 3);
    assert.deepEqual(capped.items.map((t) => t.id), ['x', 'y', 'w']);
    assert.deepEqual(ids(capped, 5), ['x', 'y', 'w']);

    const shuffled = new PlayQueue({ random: seeded(2) });
    shuffled.setShuffle(true);
    shuffled.load([{ id: 'a' }, { id: 'tab' }, { id: 'z' }], { startId: 'tab' });
    shuffled.expandCurrent([{ id: 'x' }, { id: 'y' }], 10);
    assert.equal(shuffled.current.id, 'x');
    assert.deepEqual([...ids(shuffled, 9)].sort(), ['a', 'x', 'y', 'z']);
});

test('a stale selection leaves the existing queue untouched', () => {
    const queue = new PlayQueue();
    queue.load(tracks(3), { startId: 't1' });
    assert.throws(() => queue.load(tracks(2), { startId: 'gone' }), /no longer/);
    assert.equal(queue.length, 3);
    assert.equal(queue.current.id, 't1');
});

// --- sources ---------------------------------------------------------------

function subsonic(songs) {
    const source = new SubsonicSource({ url: 'http://music.test', username: 'u', password: 'p' });
    source._call = async () => ({ album: { song: songs }, playlist: { entry: songs } });
    return source;
}

const songs = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, title: `Song ${i}`, artist: 'Artist', album: 'Album', duration: 100 }));
const streamId = (handle) => new URL(handle.uri).searchParams.get('id');

test('Navidrome reports shuffle and repeat support and applies them to its queue', async () => {
    const source = subsonic(songs);
    assert.equal(source.capabilities.shuffle, true);
    assert.equal(source.capabilities.repeat, true);
    await source.setRepeat('one');
    await source.setShuffle(true);
    source._queue._random = seeded(4);
    const first = await source.open({ type: 'album', id: 'album/a', startId: 's2', startIndex: 2 });
    assert.equal(streamId(first), 's2');
    assert.equal(streamId(await source.advance()), 's2', 'repeat-one replays');
    const next = await source.next();
    assert.notEqual(streamId(next), 's2');
    await source.setRepeat('all');
    await source.setShuffle(false);
    assert.equal(source.queue.index, Number(streamId(next).slice(1)));
    const seen = [];
    for (let i = 0; i < 12; i++) seen.push(streamId(await source.advance()));
    assert.ok(seen.includes('s0') && seen.includes('s4'), 'repeat-all wraps past the end');
});

test('every repeat-one replay is announced as a new track, so each counts as a listen', async () => {
    const source = subsonic(songs);
    await source.setRepeat('one');
    const reports = [];
    source.reportPlaying = async (track) => { reports.push(['playing', track.id]); };
    source.reportPlayed = async (track) => { reports.push(['played', track.id]); };
    source.reportStopped = async () => {};
    const listening = new Listening();
    source.on('track', (track) => listening.start(source, track));
    await source.open({ type: 'album', id: 'album/a' });
    for (let play = 0; play < 3; play++) {
        listening.heard(60 * BYTES_PER_SECOND, 60);
        await new Promise((resolve) => setImmediate(resolve));
        await source.advance();
    }
    listening.stop();
    assert.deepEqual(reports.filter(([kind]) => kind === 'played').map(([, id]) => id), ['s0', 's0', 's0']);
    assert.equal(reports.filter(([kind]) => kind === 'playing').length, 3);
});

test('a queue-based source that fails to open the next track stays where it was', async () => {
    const source = subsonic(songs);
    await source.open({ type: 'album', id: 'album/a' });
    const original = source._openQueueItem;
    source._openQueueItem = () => { throw new Error('boom'); };
    await assert.rejects(source.next(), /boom/);
    source._openQueueItem = original;
    assert.equal(source.queue.index, 0);
    assert.equal(streamId(await source.next()), 's1');
});

const FAKE_YTDLP = `
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2026.01.01'); process.exit(0); }
const url = args.at(-1);
const entry = (id) => ({ _type: 'url', ie_key: 'Youtube', id, title: 'Video ' + id, url: 'https://example.invalid/watch?v=' + id, duration: 200 });
if (url.endsWith('/playlist')) {
    console.log(JSON.stringify({ _type: 'playlist', title: 'List', entries: ['a', 'b', 'dead', 'c'].map(entry) }));
} else if (url.includes('dead')) {
    console.error('ERROR: Video unavailable');
    process.exit(1);
} else {
    const id = url.split('v=')[1];
    console.log(JSON.stringify({ id, title: 'Video ' + id, duration: 200, url: 'https://media.invalid/' + id }));
}
`;

test('yt-dlp playlists shuffle and repeat, and skip an unplayable video without looping forever', async () => {
    const dir = tempDir();
    const binary = fakeBinary(dir, 'yt-dlp', FAKE_YTDLP);
    const source = new YtdlpSource({ binary });
    await source.connect();
    await source.setRepeat('all');
    const warnings = [];
    source.on('warning', (message) => warnings.push(message));

    const first = await source.open({ id: 'https://example.invalid/playlist', type: 'playlist', startId: 'https://example.invalid/watch?v=b' });
    assert.equal(first.uri, 'https://media.invalid/b');
    const walked = [];
    for (let i = 0; i < 4; i++) walked.push((await source.advance()).uri.split('/').pop());
    assert.deepEqual(walked, ['c', 'a', 'b', 'c'], 'the dead video is skipped on every pass');
    assert.equal(warnings.length, 2);
    assert.equal(source.capabilities.shuffle, true);

    await source.setShuffle(true);
    const seen = new Set();
    for (let i = 0; i < 8; i++) seen.add((await source.advance()).uri.split('/').pop());
    assert.deepEqual([...seen].sort(), ['a', 'b', 'c']);

    const dead = new YtdlpSource({ binary });
    await dead.setRepeat('all');
    await dead.open({ id: 'https://example.invalid/playlist', type: 'playlist', startId: 'https://example.invalid/watch?v=c' });
    dead._queue.load([{ id: 'https://example.invalid/watch?v=dead1' }, { id: 'https://example.invalid/watch?v=dead2' }]);
    assert.equal(await dead.advance(), null, 'a queue where nothing plays gives up');
    await source.disconnect();
});
