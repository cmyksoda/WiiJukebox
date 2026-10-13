// SPDX-License-Identifier: GPL-3.0-only
// A URL that names a host makes FFmpeg resolve it, which crashed the old static Linux build. This
// decodes from "localhost" with the FFmpeg named by WIIJUKEBOX_FFMPEG, or else the one on PATH.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const { Decoder } = require('../src/core/decoder');
const { BYTES_PER_SECOND } = require('../src/core/format');

const ffmpegPath = process.env.WIIJUKEBOX_FFMPEG || 'ffmpeg';
const SECONDS = 3;

function toneMp3() {
    return execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', `sine=frequency=440:duration=${SECONDS}`, '-c:a', 'libmp3lame', '-f', 'mp3', '-'], { maxBuffer: 1 << 24 });
}

function decode(uri) {
    const decoder = new Decoder({ uri, ffmpegPath });
    return new Promise((resolve, reject) => {
        const chunks = [];
        decoder.on('data', (chunk) => chunks.push(chunk));
        decoder.on('ended', () => resolve(Buffer.concat(chunks)));
        decoder.on('error', reject);
        decoder.start();
    }).finally(() => decoder.stop());
}

test('FFmpeg decodes a stream addressed by hostname', { timeout: 60000 }, async () => {
    const audio = toneMp3();
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length });
        res.end(audio);
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
        const pcm = await decode(`http://localhost:${server.address().port}/tone.mp3`);
        assert.ok(pcm.length > BYTES_PER_SECOND * (SECONDS - 0.5), `${pcm.length} bytes of PCM`);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});
