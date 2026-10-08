// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');
const { Listening } = require('../src/core/listening');
const { Pipeline } = require('../src/core/pipeline');
const { Source } = require('../src/sources/base');
const { SubsonicSource } = require('../src/sources/subsonic');
const { BYTES_PER_SECOND } = require('../src/core/format');

const tick = () => new Promise((resolve) => setImmediate(resolve));

function recorder() {
    const calls = [];
    const source = { id: 'fake' };
    for (const method of ['reportPlaying', 'reportPlayed', 'reportStopped']) {
        source[method] = async (track, details) => { calls.push([method, track.id, details]); };
    }
    return { source, calls, names: () => calls.map(([method, id]) => `${method}:${id}`) };
}

function listen(listening, seconds, position = seconds) {
    listening.heard(seconds * BYTES_PER_SECOND, position);
}

test('a track counts as played after half its length, or 4 minutes, of listening', async () => {
    const { source, calls, names } = recorder();
    const listening = new Listening();

    listening.start(source, { id: 'a', duration: 200 });
    listen(listening, 99);
    await tick();
    assert.deepEqual(names(), ['reportPlaying:a']);
    assert.ok(Math.abs(calls[0][2].startedAt - Date.now()) < 1000);
    listen(listening, 2);
    listen(listening, 50);
    await tick();
    assert.deepEqual(names(), ['reportPlaying:a', 'reportPlayed:a'], 'reported once');

    listening.start(source, { id: 'long', duration: 600 });
    listen(listening, 239);
    await tick();
    assert.ok(!names().includes('reportPlayed:long'));
    listen(listening, 2);
    await tick();
    assert.ok(names().includes('reportPlayed:long'), 'four minutes is enough for a long track');
    assert.ok(names().includes('reportStopped:a'), 'starting a track stops the previous one');

    listening.start(source, { id: 'short', duration: 20 });
    listen(listening, 20);
    listening.start(source, { id: 'unknown' });
    listen(listening, 200);
    await tick();
    assert.ok(names().includes('reportPlaying:short') && !names().includes('reportPlayed:short'), 'Last.fm ignores tracks under 30 s');
    assert.ok(!names().includes('reportPlayed:unknown'));
    listen(listening, 41);
    await tick();
    assert.ok(names().includes('reportPlayed:unknown'), 'an unknown length needs four minutes');
});

test('a play that never reached the stream is not reported, and report failures only warn', async () => {
    const warnings = [];
    const listening = new Listening({ warn: (message) => warnings.push(message) });
    const { source, names } = recorder();
    listening.start(source, { id: 'skipped', duration: 100 });
    listening.start(source, { id: 'next', duration: 100 });
    await tick();
    assert.deepEqual(names(), [], 'nothing was heard, so nothing started or stopped');

    listening.start({ id: 'down', reportPlaying: async () => { throw new Error('offline'); } }, { id: 'x', duration: 100 });
    listen(listening, 1);
    await tick();
    assert.match(warnings[0], /down: could not report listening \(offline\)/);
});

class Pcm extends Source {
    static id = 'pcm';
    get capabilities() { return { play: true, stop: true }; }
    async open() {
        this.stream = new PassThrough();
        this._startTrack({ id: 'track-1', duration: 100 });
        return { type: 'pcm', stream: this.stream };
    }
}

test('the pipeline reports what reaches the stream and stops reporting on detach', async () => {
    const pipeline = new Pipeline();
    pipeline.start();
    const source = new Pcm();
    const seen = [];
    source.reportPlaying = async (track) => seen.push(`playing:${track.id}`);
    source.reportStopped = async (track, { position }) => seen.push(`stopped:${track.id}:${position > 0}`);
    try {
        await pipeline.attach(source);
        source.stream.write(Buffer.alloc(BYTES_PER_SECOND * 2));
        await new Promise((resolve) => setTimeout(resolve, 1200));
        assert.deepEqual(seen, ['playing:track-1']);
        await pipeline.detach();
        await tick();
        assert.deepEqual(seen, ['playing:track-1', 'stopped:track-1:true']);
    } finally { await pipeline.shutdown(); }
});

test('Navidrome reports now playing, then the scrobble with the time the track started', async () => {
    const password = 'fixture';
    const scrobbles = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://fixture');
        const q = url.searchParams;
        assert.equal(q.get('t'), crypto.createHash('md5').update(password + q.get('s')).digest('hex'));
        if (url.pathname.endsWith('/scrobble.view')) {
            scrobbles.push({ id: q.get('id'), submission: q.get('submission'), time: q.get('time') });
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1' } }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const source = new SubsonicSource({ url: `http://127.0.0.1:${server.address().port}`, username: 'u', password });
    try {
        await source.reportPlaying({ id: 'song-1' });
        await source.reportPlayed({ id: 'song-1' }, { startedAt: 1700000000123 });
        assert.deepEqual(scrobbles, [
            { id: 'song-1', submission: 'false', time: null },
            { id: 'song-1', submission: 'true', time: '1700000000123' },
        ]);
    } finally { server.close(); }
});

function recordingServer(reply = '') {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            const url = new URL(req.url, 'http://fixture');
            requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
                body: body ? JSON.parse(body) : null, headers: req.headers });
            res.statusCode = reply ? 200 : 204;
            res.end(reply);
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
        resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

test('Jellyfin gets the start and stop reports its own apps send', async () => {
    const { JellyfinSource } = require('../src/sources/jellyfin');
    const { server, requests, url } = await recordingServer();
    const source = new JellyfinSource({ url, token: 'fixture-token', userId: 'user-1' });
    try {
        await source.reportPlaying({ id: 'item-9' });
        await source.reportStopped({ id: 'item-9' }, { position: 183.4 });
        assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), ['POST /Sessions/Playing', 'POST /Sessions/Playing/Stopped']);
        assert.equal(requests[0].body.ItemId, 'item-9');
        assert.equal(requests[1].body.PositionTicks, 1834000000);
        assert.match(requests[0].headers.authorization, /fixture-token/);
    } finally { server.close(); }
});

test('Plex gets timeline reports and a scrobble once the track counts as played', async () => {
    const { PlexSource } = require('../src/sources/plex');
    const { server, requests, url } = await recordingServer('<MediaContainer/>');
    const source = new PlexSource({ url, token: 'fixture-token' }, { serverId: 'wii-1' });
    const track = { ratingKey: '42', duration: 200 };
    try {
        await source.reportPlaying(track);
        await source.reportPlayed(track);
        await source.reportStopped(track, { position: 150.5 });
        assert.deepEqual(requests.map((r) => r.path), ['/:/timeline', '/:/scrobble', '/:/timeline']);
        assert.deepEqual(requests[0].query, { ratingKey: '42', key: '/library/metadata/42', state: 'playing', time: '0', duration: '200000' });
        assert.deepEqual(requests[1].query, { key: '42', identifier: 'com.plexapp.plugins.library' });
        assert.equal(requests[2].query.state, 'stopped');
        assert.equal(requests[2].query.time, '150500');
        assert.equal(requests[0].headers['x-plex-token'], 'fixture-token');
    } finally { server.close(); }
});

test('YouTube plays are marked watched only for signed-in users, so YouTube history sees them', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { YtdlpSource } = require('../src/sources/ytdlp');
    const { tempDir, fakeBinary } = require('./helpers/fake-binary');
    const dir = tempDir();
    const log = path.join(dir, 'calls.jsonl');
    const bin = fakeBinary(dir, 'yt-dlp', `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`);
    const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
    const song = { url: 'https://music.youtube.com/watch?v=abc123' };

    await new YtdlpSource({ binary: bin }).reportPlayed(song);
    const signedIn = new YtdlpSource({ binary: bin, extraArgs: ['--cookies-from-browser', 'firefox'] });
    await signedIn.reportPlayed({ url: 'https://soundcloud.com/artist/track' });
    assert.deepEqual(calls(), [], 'no cookies, or not YouTube: nothing to mark');

    await signedIn.reportPlayed(song);
    const [args] = calls();
    assert.deepEqual(args.slice(0, 2), ['--mark-watched', '--simulate']);
    assert.ok(args.includes('--cookies-from-browser') && args.includes('firefox'));
    assert.equal(args.at(-1), song.url);
});
