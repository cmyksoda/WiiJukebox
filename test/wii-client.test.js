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
const { Config } = require('../src/config');
const { SourceRegistry } = require('../src/sources');
const { WebServer } = require('../src/web/server');
const { Discovery } = require('../src/client/discovery');
const run = promisify(execFile);

test('native C networking talks to the live server and receives decodable MP3', { timeout: 20000 }, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wiijukebox-client-'));
    const tone = path.join(tmp, 'tone.wav');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', tone]);
    const bytes = await fs.readFile(tone);
    const media = http.createServer((req, res) => { res.setHeader('Content-Length', bytes.length); res.end(bytes); });
    await new Promise((resolve) => media.listen(0, '127.0.0.1', resolve));
    const config = new Config(tmp);
    config.save = () => {};
    config.data.sources.radio.stations = [{ name: 'Fixture station', url: `http://127.0.0.1:${media.address().port}/tone.wav` }];
    config.data.station.name = 'a'.repeat(79) + '🎶';
    const pipeline = new Pipeline({ station: config.data.station });
    const registry = new SourceRegistry(config);
    const web = new WebServer({ pipeline, registry, config });
    const address = await web.listen(0, '127.0.0.1');
    const discovery = new Discovery({ config, port: address.port });
    const udp = await discovery.start(0, '127.0.0.1');
    pipeline.start();
    try {
        const output = path.join(tmp, 'received.mp3');
        const { stdout } = await run('./client/build/network_probe', [String(udp.port), output], { timeout: 15000 });
        assert.match(stdout, /MP3 stream and stop passed/);
        const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json', output]);
        const audio = JSON.parse(probe.stdout).streams[0];
        assert.deepEqual(audio, { codec_name: 'mp3', sample_rate: '48000', channels: 2 });
        // Decode as well as inspecting headers; this catches HTTP framing bytes.
        const decoded = await run('ffmpeg', ['-v', 'error', '-i', output, '-f', 's16le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
        let peak = 0;
        for (let i = 0; i + 1 < decoded.stdout.length; i += 2) {
            peak = Math.max(peak, Math.abs(decoded.stdout.readInt16LE(i)));
        }
        assert.ok(peak > 500, `received actual generated audio, peak ${peak}`);
        assert.equal(pipeline.activeSource, null);
    } finally {
        discovery.close(); web.close(); media.close();
        await pipeline.shutdown(); await registry.disconnectAll();
        await fs.rm(tmp, { recursive: true, force: true });
    }
});
