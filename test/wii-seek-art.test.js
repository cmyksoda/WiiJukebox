// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Pipeline } = require('../src/core/pipeline');
const { Source } = require('../src/sources/base');
const { Config } = require('../src/config');
const { WiiProtocol } = require('../src/client/protocol');
const { Artwork, tileRgb565 } = require('../src/client/artwork');
const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FileSource extends Source {
    static id = 'file';
    constructor(file, { seekable = true, artwork = null } = {}) {
        super();
        this.file = file;
        this.seekable = seekable;
        this.artwork = artwork;
    }
    get capabilities() { return { play: true, pause: true, stop: true }; }
    async open() {
        this._emitMetadata({ title: 'Half silent', duration: 10, artwork: this.artwork });
        return { type: 'uri', uri: this.file, seekable: this.seekable };
    }
}

async function fixture() {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wiijukebox-seek-'));
    const file = path.join(tmp, 'half.wav');
    // Five seconds of silence, then five of tone: a seek lands on audible audio.
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=5', '-f', 'lavfi',
        '-i', 'sine=frequency=440:duration=5:sample_rate=44100', '-filter_complex',
        '[1]aformat=channel_layouts=stereo[t];[0][t]concat=n=2:v=0:a=1', file]);
    return { tmp, file };
}

test('seeking reopens a finite track at the offset and keeps the pause state', { timeout: 20000 }, async () => {
    const { tmp, file } = await fixture();
    const pipeline = new Pipeline();
    const heard = [];
    pipeline.pacer._write = (chunk, timing) => {
        if (timing.audio) heard.push({ position: timing.position, peak: Math.max(...new Int16Array(
            chunk.buffer, chunk.byteOffset, chunk.length / 2).map(Math.abs)) });
        return true;
    };
    pipeline.pacer.start();
    try {
        await pipeline.attach(new FileSource(file));
        await pipeline.waitForAudio();
        assert.equal(pipeline.status.capabilities.seek, true);
        await sleep(1200);
        assert.ok(heard.length && heard.every((entry) => entry.peak === 0), 'starts in the silent half');
        pipeline.setPaused(true);
        heard.length = 0;
        assert.equal(await pipeline.seek(6), 6);
        assert.equal(pipeline.pacer.paused, true);
        pipeline.setPaused(false);
        await pipeline.waitForAudio();
        await sleep(1200);
        assert.ok(heard.length && heard[0].position >= 6 && heard[0].position < 6.1);
        assert.ok(heard.every((entry) => entry.peak > 1000), 'the first audio after seeking is the tone');
        assert.ok(pipeline.status.nowPlaying.position >= 6.5 && pipeline.status.nowPlaying.position < 8);
        assert.equal(await pipeline.seek(99), 9.5);
        await assert.rejects(pipeline.seek(Number.NaN), /invalid seek position/);

        await pipeline.attach(new FileSource(file, { seekable: false }));
        assert.equal(pipeline.status.capabilities.seek, false);
        await assert.rejects(pipeline.seek(2), /cannot seek/);
    } finally {
        await pipeline.shutdown();
        await fs.rm(tmp, { recursive: true, force: true });
    }
});

test('Wii seek commands validate the position and complete after audio', { timeout: 20000 }, async () => {
    const { tmp, file } = await fixture();
    const pipeline = new Pipeline();
    const config = new Config('/unused-test-config');
    config.save = () => {};
    const protocol = new WiiProtocol({ config, pipeline });
    const call = async (method, query) => {
        let status, body;
        await protocol.handle({ method }, { writeHead(code) { status = code; }, end(text) { body = String(text); } },
            new URL(`http://fixture/api/wii/${query}`));
        return { status, body };
    };
    pipeline.pacer.start();
    try {
        await pipeline.attach(new FileSource(file));
        await pipeline.waitForAudio();
        assert.match((await call("GET", "status")).body, /%2Cseek\n/);
        assert.equal((await call('POST', 'control?action=seek&position=-1')).status, 400);
        assert.equal((await call('POST', 'control?action=seek&position=abc')).status, 400);
        const accepted = await call('POST', 'control?action=seek&position=7000');
        assert.match(accepted.body, /ok\taccepted\t\d+/);
        for (let i = 0; i < 50 && protocol.commandState === 'pending'; i++) await sleep(50);
        assert.equal(protocol.commandState, 'complete');
        assert.equal(protocol.commandStatus, 'Seeked');
        assert.ok(pipeline.pacer.position >= 7);
    } finally {
        await pipeline.shutdown();
        await fs.rm(tmp, { recursive: true, force: true });
    }
});

test('GX tiling places each 4x4 block contiguously', () => {
    const size = 8;
    const pixels = Buffer.alloc(size * size * 2);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) pixels.writeUInt16BE(y * 16 + x, (y * size + x) * 2);
    const tiled = tileRgb565(pixels, size);
    const at = (index) => tiled.readUInt16BE(index * 2);
    assert.deepEqual([at(0), at(3), at(4), at(15)], [0x00, 0x03, 0x10, 0x33]);
    assert.deepEqual([at(16), at(32), at(63)], [0x04, 0x40, 0x77]);
});

test('artwork is served by key as tiled RGB565 and failures stay quiet', { timeout: 20000 }, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wiijukebox-art-'));
    const png = path.join(tmp, 'cover.png');
    // Wide red-left/blue-right cover: the square crop keeps red on the left edge.
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=300x200', '-f', 'lavfi', '-i',
        'color=blue:s=300x200', '-filter_complex', '[0][1]hstack', '-frames:v', '1', '-threads', '1', png]);
    const bytes = await fs.readFile(png);
    let requests = 0;
    const server = http.createServer((req, res) => {
        requests++;
        if (req.url.startsWith('/cover.png?')) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(bytes); }
        else { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/cover.png?u=secret`;
    const config = new Config('/unused-test-config');
    config.save = () => {};
    const pipeline = { status: { nowPlaying: { title: 'Song', artwork: url }, capabilities: {} } };
    const protocol = new WiiProtocol({ config, pipeline, artwork: new Artwork() });
    const call = async (query) => {
        let status, body, headers;
        await protocol.handle({ method: 'GET' }, {
            writeHead(code, values) { status = code; headers = values; }, end(data) { body = data; },
        }, new URL(`http://fixture/api/wii/${query}`));
        return { status, body, headers };
    };
    try {
        const statusBody = String((await call('status')).body);
        assert.ok(!statusBody.includes('secret'), 'artwork URLs and credentials stay on the server');
        const key = /\nart\t([0-9a-f]{16})\n/.exec(statusBody)[1];
        const art = await call(`art?key=${key}&size=160`);
        assert.equal(art.status, 200);
        assert.equal(art.body.length, 160 * 160 * 2);
        assert.equal(art.headers['Content-Length'], 160 * 160 * 2);
        assert.equal(art.body.readUInt16BE(0) & 0xf800, 0xf800, 'top-left texel is red');
        const lastTile = art.body.length - 32;
        assert.equal(art.body.readUInt16BE(lastTile + 30) & 0x001f, 0x001f, 'bottom-right texel is blue');
        await call(`art?key=${key}&size=160`);
        assert.equal(requests, 1, 'rendered artwork is cached');
        assert.equal((await call('art?key=0123456789abcdef&size=160')).status, 404);
        assert.equal((await call(`art?key=${key}&size=100`)).status, 404);
        pipeline.status.nowPlaying.artwork = `http://127.0.0.1:${server.address().port}/missing.png`;
        const missing = /\nart\t([0-9a-f]{16})\n/.exec(String((await call('status')).body))[1];
        assert.equal((await call(`art?key=${missing}&size=128`)).status, 404);
        pipeline.status.nowPlaying.artwork = null;
        assert.match(String((await call('status')).body), /\nart\t\n$/);
    } finally {
        server.close();
        await fs.rm(tmp, { recursive: true, force: true });
    }
});
