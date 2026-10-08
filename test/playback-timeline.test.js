// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PlaybackTimeline, MP3_DELAY_MS } = require('../src/core/playback-timeline');
const { Pipeline } = require('../src/core/pipeline');
const { Broadcaster } = require('../src/core/broadcaster');
const { BYTES_PER_SECOND } = require('../src/core/format');

test('audible timeline follows buffered silence, track changes, pauses and underruns', async () => {
    const pipeline = new Pipeline();
    pipeline._source = { id: 'fixture', label: 'Fixture', capabilities: {}, off() {}, async close() {} };
    pipeline._generation = 2;
    pipeline._nowPlaying = { title: 'New song', duration: 100 };
    const write = (seconds, generation, state, position) => pipeline.timeline.write(seconds * BYTES_PER_SECOND,
        { generation, state, position, metadata: { title: generation === 2 ? 'New song' : 'Old song', duration: 100 } });
    write(4, 1, 'playing', 10);
    write(2, 2, 'buffering', 0);
    write(3, 2, 'playing', 0);
    write(2, 2, 'paused', 3);
    write(1, 2, 'buffering', 3);
    write(2, 2, 'playing', 3);
    const at = (seconds) => pipeline.playbackAt(pipeline.broadcaster.epoch, 0, seconds * 1000 + MP3_DELAY_MS);
    try {
        assert.equal(at(3).playbackState, 'queued');
        assert.equal(at(3).nowPlaying.position, 0);
        assert.equal(at(5).playbackState, 'buffering');
        assert.equal(at(5).nowPlaying.position, 0);
        assert.equal(at(6).nowPlaying.position, 0);
        assert.equal(at(7).playbackState, 'playing');
        assert.equal(at(7).nowPlaying.position, 1);
        assert.equal(at(10).playbackState, 'paused');
        assert.equal(at(10).nowPlaying.position, 3);
        assert.equal(at(11.5).nowPlaying.position, 3);
        assert.equal(at(13).nowPlaying.position, 4);
        assert.equal(pipeline.playbackAt(-1, 0, 0).playbackState, 'queued');
        // Joining an already running stream uses its absolute byte offset.
        const joined = pipeline.playbackAt(pipeline.broadcaster.epoch, 6 * 16000, 1000 + MP3_DELAY_MS);
        assert.equal(joined.nowPlaying.position, 1);
        pipeline.broadcaster.bitrate = 320;
        assert.equal(pipeline.playbackAt(pipeline.broadcaster.epoch, 6 * 40000, 1000 + MP3_DELAY_MS).nowPlaying.position, 1);
        await pipeline.detach();
        assert.equal(at(7).playbackState, 'playing', 'last buffered audio can outlive the server source');
    } finally { await pipeline.shutdown(); }
});

test('timeline compacts continuous audio and bounds old transition history', () => {
    const timeline = new PlaybackTimeline();
    for (let i = 0; i < 10000; i++) timeline.write(BYTES_PER_SECOND / 50,
        { generation: 1, position: i / 50, state: 'playing', metadata: { title: 'Song' } });
    assert.equal(timeline.segments.length, 1);
    assert.ok(Math.abs(timeline.at(100000 + MP3_DELAY_MS).position - 100) < 0.0001);
    for (let i = 0; i < 8000; i++) timeline.write(BYTES_PER_SECOND / 50,
        { generation: i + 2, position: 0, state: 'playing', metadata: { title: 'Song' } });
    assert.ok(timeline.segments.length <= 6000);
    assert.equal(timeline.at(1000), null);
});

test('stream headers anchor the exact burst start and encoder resets invalidate old clocks', () => {
    const broadcaster = new Broadcaster();
    broadcaster.write(Buffer.alloc(40000));
    broadcaster.write(Buffer.alloc(40000));
    let headers;
    broadcaster.handleRequest({ method: 'HEAD', headers: {} }, {
        writeHead(code, value) { assert.equal(code, 200); headers = value; }, end() {},
    });
    assert.equal(headers['X-WiiJukebox-Byte-Start'], '40000');
    assert.equal(headers['X-WiiJukebox-Epoch'], String(broadcaster.epoch));
    const epoch = broadcaster.epoch;
    broadcaster.resetClock();
    assert.notEqual(broadcaster.epoch, epoch);
    assert.equal(broadcaster._audioBytes, 0);
    assert.equal(broadcaster._burstBytes, 0);
});
