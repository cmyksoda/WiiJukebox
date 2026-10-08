// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Encoder } = require('../src/core/encoder');
const { BYTES_PER_SECOND, mp3Output } = require('../src/core/format');
const run = promisify(execFile);

async function encode(settings) {
    const encoder = new Encoder(settings);
    const chunks = [];
    encoder.on('data', (chunk) => chunks.push(chunk));
    encoder.start();
    const pcm = Buffer.alloc(BYTES_PER_SECOND * 2);
    for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 0.05) * 8000), i * 2);
    encoder.write(pcm);
    encoder._proc.stdin.end();
    await new Promise((resolve) => encoder._proc.on('exit', resolve));
    encoder.stop();
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wiijukebox-encoder-'));
    try {
        const file = path.join(tmp, 'out.mp3');
        await fs.writeFile(file, Buffer.concat(chunks));
        const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate,bit_rate',
            '-of', 'json', file]);
        return { ...JSON.parse(stdout).streams[0], bytes: Buffer.concat(chunks).length };
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
}

test('the default stream is 48 kHz at 256 kbps and the old format remains a setting', async () => {
    assert.deepEqual(mp3Output(), { bitrate: 256, sampleRate: 48000 });
    assert.deepEqual(mp3Output({ bitrate: 999, sampleRate: 22050 }), { bitrate: 256, sampleRate: 48000 });
    const current = await encode({});
    assert.equal(current.sample_rate, '48000');
    assert.equal(current.bit_rate, '256000');
    // MPEG-1 Layer III at 48 kHz has fixed 768-byte frames at 256 kbps.
    assert.equal(current.bytes % 768, 0);
    const fallback = await encode({ bitrate: 128, sampleRate: 44100 });
    assert.equal(fallback.sample_rate, '44100');
    assert.equal(fallback.bit_rate, '128000');
});
