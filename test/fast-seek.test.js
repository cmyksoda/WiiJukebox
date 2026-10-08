// SPDX-License-Identifier: GPL-3.0-only
// Measures seek and next latency as heard by a real-time playout of the Wii's
// audio buffer, with the tracks decoded by FFmpeg from an HTTP server that
// honors Range requests, as Navidrome does.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { Pipeline } = require('../src/core/pipeline');
const { Source } = require('../src/sources/base');
const { Config } = require('../src/config');
const { WiiProtocol } = require('../src/client/protocol');
const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TONES = [300, 1500, 3000];

class Tracks extends Source {
    static id = 'tracks';
    constructor(urls) { super(); this.urls = urls; this.index = 0; }
    get capabilities() {
        return { play: true, pause: true, stop: true, next: this.index + 1 < this.urls.length, previous: this.index > 0 };
    }
    _handle() {
        this._emitMetadata({ title: `Track ${this.index}`, duration: 60 });
        return { type: 'uri', uri: this.urls[this.index], seekable: true };
    }
    async open() { this.index = 0; return this._handle(); }
    async next() { if (this.index + 1 >= this.urls.length) return null; this.index++; return this._handle(); }
    async previous() { if (!this.index) return null; this.index--; return this._handle(); }
}

function rangeServer(files) {
    return http.createServer(async (req, res) => {
        const data = files[req.url];
        if (!data) { res.writeHead(404); return res.end(); }
        const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
        if (!match) {
            res.writeHead(200, { 'Content-Length': data.length, 'Accept-Ranges': 'bytes', 'Content-Type': 'audio/mpeg' });
            return res.end(data);
        }
        const start = Number(match[1]), end = match[2] ? Number(match[2]) : data.length - 1;
        res.writeHead(206, { 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Content-Type': 'audio/mpeg',
            'Content-Range': `bytes ${start}-${end}/${data.length}` });
        res.end(data.subarray(start, end + 1));
    });
}

function capture(port) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write('GET /stream HTTP/1.0\r\n\r\n'));
        const state = { socket, start: -1, chunks: [] };
        let head = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            if (state.start >= 0) return state.chunks.push(chunk);
            head = Buffer.concat([head, chunk]);
            const end = head.indexOf('\r\n\r\n');
            if (end < 0) return;
            state.start = Number(/X-WiiJukebox-Byte-Start: (\d+)/i.exec(head.subarray(0, end).toString())[1]);
            state.chunks.push(head.subarray(end + 4));
            resolve(state);
        });
        socket.on('error', reject);
    });
}

function goertzel(samples, from, count, frequency) {
    const k = 2 * Math.cos(2 * Math.PI * frequency / 48000);
    let a = 0, b = 0;
    for (let i = from; i < from + count; i++) { const c = samples[i] + k * a - b; b = a; a = c; }
    return a * a + b * b - k * a * b;
}

/* Stream bytes where each tone first dominates the decoded capture. */
async function onsets(tmp, captured, bitrate) {
    const file = path.join(tmp, 'capture.mp3');
    await fs.writeFile(file, Buffer.concat(captured.chunks));
    const { stdout } = await run('ffmpeg', ['-v', 'error', '-threads', '1', '-i', file, '-ac', '1', '-ar', '48000',
        '-f', 's16le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
    const samples = new Int16Array(stdout.buffer, stdout.byteOffset, stdout.length / 2);
    const found = {};
    for (let at = 0; at + 960 <= samples.length; at += 480) {
        const powers = TONES.map((f) => goertzel(samples, at, 960, f));
        const best = powers.indexOf(Math.max(...powers));
        if (powers[best] < 1e12 || powers[best] < 20 * Math.max(...powers.filter((_, i) => i !== best))) continue;
        if (!(TONES[best] in found)) found[TONES[best]] = captured.start + Math.round((at - 1105) * bitrate * 125 / 48000);
    }
    return found;
}

async function heardAt(logFile, byte) {
    for (const line of (await fs.readFile(logFile, 'utf8')).split('\n')) {
        const [wall, cursor] = line.split(' ').map(Number);
        if (cursor >= byte) return wall;
    }
    return null;
}

async function measure(mode, tmp, files) {
    const media = rangeServer(files);
    await new Promise((resolve) => media.listen(0, '127.0.0.1', resolve));
    const pipeline = new Pipeline();
    const config = new Config('/unused-test-config');
    config.save = () => {};
    const protocol = new WiiProtocol({ config, pipeline });
    const web = http.createServer((req, res) => {
        if (pipeline.broadcaster.handles(req)) return pipeline.broadcaster.handleRequest(req, res);
        protocol.handle(req, res, new URL(req.url, 'http://fixture'));
    });
    await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
    const port = web.address().port;
    const base = `http://127.0.0.1:${media.address().port}`;
    const control = (query) => fetch(`http://127.0.0.1:${port}/api/wii/control?${query}`, { method: 'POST' });
    pipeline.start();
    try {
        await pipeline.attach(new Tracks([`${base}/a.mp3`, `${base}/b.mp3`]));
        // A Wii joins a running stream, so its connect burst fills its usual buffer.
        await sleep(5000);
        const captured = await capture(port);
        const log = path.join(tmp, `${mode}.log`);
        const probe = run('./client/build/seek_probe', [String(port), mode, log, '18000'], { timeout: 30000 });
        await sleep(7000);
        const seekAt = Date.now();
        assert.equal((await control('action=seek&position=40000')).status, 200);
        await sleep(6000);
        const nextAt = Date.now();
        assert.equal((await control('action=next')).status, 200);
        await probe;
        captured.socket.destroy();
        const found = await onsets(tmp, captured, pipeline.broadcaster.bitrate);
        const seekHeard = await heardAt(log, found[1500]);
        const nextHeard = await heardAt(log, found[3000]);
        assert.ok(seekHeard && nextHeard, `${mode}: both changes were heard`);
        return { seek: seekHeard - seekAt, next: nextHeard - nextAt, jump: pipeline.jump, onset: found[3000] };
    } finally {
        web.close(); media.close();
        await pipeline.shutdown();
    }
}

test('seek and next reach the speakers quickly when the client follows jump markers', { timeout: 120000 }, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wiijukebox-fast-seek-'));
    try {
        const encode = (filter, name) => run('ffmpeg', ['-v', 'error', '-threads', '1', '-f', 'lavfi', '-i', filter,
            '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k', path.join(tmp, name)]);
        await encode('sine=frequency=300:duration=30:sample_rate=44100[a];sine=frequency=1500:duration=30:sample_rate=44100[b];[a][b]concat=n=2:v=0:a=1', 'a.mp3');
        await encode('sine=frequency=3000:duration=60:sample_rate=44100', 'b.mp3');
        const files = { '/a.mp3': await fs.readFile(path.join(tmp, 'a.mp3')), '/b.mp3': await fs.readFile(path.join(tmp, 'b.mp3')) };
        const slow = await measure('slow', tmp, files);
        const fast = await measure('fast', tmp, files);
        console.log(`seek-to-audible: before ${slow.seek} ms, after ${fast.seek} ms; ` +
            `next-to-audible: before ${slow.next} ms, after ${fast.next} ms`);
        assert.ok(fast.seek < 2500 && fast.next < 2500, 'a change is heard within 2.5 s');
        assert.ok(slow.seek - fast.seek > 1500 && slow.next - fast.next > 1500, 'following jumps saves the buffered seconds');
        // The marker points at the change itself, within a couple of MP3 frames.
        assert.ok(Math.abs(fast.jump.byte - fast.onset) < 2 * 768 + 400, `jump ${fast.jump.byte} near onset ${fast.onset}`);
    } finally {
        await fs.rm(tmp, { recursive: true, force: true });
    }
});
