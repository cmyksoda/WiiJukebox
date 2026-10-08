// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SpotifySource } = require('../src/sources/spotify');
const { SourceRegistry } = require('../src/sources/index');
const { Config } = require('../src/config');
const { tempDir, fakeBinary, waitFor } = require('./helpers/fake-binary');

// Pretends to be librespot: records its arguments, emits a little PCM, and
// reports player events through the --onevent program like the real one.
const FAKE_LIBRESPOT = (dir, { crashFirst = false } = {}) => `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('librespot 0.8.0 (fake)'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(path.join(dir, 'runs.json'))}, JSON.stringify({ pid: process.pid, args }) + '\\n');
${crashFirst ? `if (!fs.existsSync(${JSON.stringify(path.join(dir, 'crashed'))})) {
    fs.writeFileSync(${JSON.stringify(path.join(dir, 'crashed'))}, '1');
    console.error('Authentication failed');
    process.exit(1);
}` : ''}
const hook = args[args.indexOf('--onevent') + 1];
const emit = (env) => hook && spawnSync(hook, [], { env: { ...process.env, ...env } });
process.stdout.write(Buffer.alloc(4000, 7));
emit({ PLAYER_EVENT: 'session_connected', USER_NAME: 'jaxi' });
emit({ PLAYER_EVENT: 'track_changed', NAME: 'Voyager', ARTISTS: 'Daft Punk\\nSomeone', ALBUM: 'Discovery',
    COVERS: 'https://i.scdn.co/image/large\\nhttps://i.scdn.co/image/small', DURATION_MS: '227000', ITEM_TYPE: 'Track' });
emit({ PLAYER_EVENT: 'playing', TRACK_ID: 'abc', POSITION_MS: '0' });
process.stdout.write(Buffer.alloc(1001, 9));
setInterval(() => {}, 1000);
`;

const makeSource = (dir, extra = {}) => new SpotifySource(
    { binary: path.join(dir, 'librespot'), deviceName: 'Test Speaker', ...extra },
    { configDir: dir });

test('a missing librespot is reported with how to install it', async () => {
    const source = new SpotifySource({ binary: '/nonexistent/librespot' }, { configDir: tempDir() });
    await assert.rejects(source.connect(), /librespot not found.*cargo install librespot/s);
    assert.equal(source.state, 'error');
    const registry = new SourceRegistry(new Config(tempDir()));
    registry.config.updateSource('spotify', { binary: '/nonexistent/librespot' });
    assert.equal(registry.describe().find((s) => s.id === 'spotify').configured, false);
});

test('receiver starts librespot with the pipe backend and relays PCM and track details', async () => {
    const dir = tempDir();
    fakeBinary(dir, 'librespot', FAKE_LIBRESPOT(dir));
    const source = makeSource(dir, { bitrate: 160, extraArgs: ['--zeroconf-port', '5555'] });
    const metadata = [];
    source.on('metadata', (meta) => metadata.push(meta));
    try {
        await source.connect();
        assert.equal(source.version, 'librespot 0.8.0 (fake)');
        const handle = await source.open();
        assert.equal(handle.type, 'pcm');
        const chunks = [];
        handle.stream.on('data', (chunk) => chunks.push(chunk));

        await waitFor(() => metadata.some((m) => m.title === 'Voyager'));
        const track = metadata.find((m) => m.title === 'Voyager');
        assert.deepEqual(track, {
            title: 'Voyager', artist: 'Daft Punk, Someone', album: 'Discovery',
            artwork: 'https://i.scdn.co/image/large', duration: null,
        });
        assert.match(metadata[0].title, /Waiting for Spotify/);
        assert.match(metadata[0].artist, /Test Speaker/);
        assert.equal(source.info().user, 'jaxi');

        const total = await waitFor(() => {
            const bytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            return bytes >= 5000 + 1000 ? bytes : 0;
        });
        assert.equal(total % 4, 0, 'only whole stereo frames reach the pacer');

        const run = JSON.parse(fs.readFileSync(path.join(dir, 'runs.json'), 'utf8').trim().split('\n')[0]);
        const arg = (name) => run.args[run.args.indexOf(name) + 1];
        assert.equal(arg('--name'), 'Test Speaker');
        assert.equal(arg('--backend'), 'pipe');
        assert.equal(arg('--format'), 'S16');
        assert.equal(arg('--bitrate'), '160');
        assert.equal(arg('--volume-ctrl'), 'fixed');
        assert.equal(arg('--zeroconf-port'), '5555');
        assert.ok(run.args.includes('--disable-audio-cache'));
        assert.doesNotMatch(arg('--onevent'), /\s/);

        await source.close();
        await waitFor(() => { try { process.kill(run.pid, 0); return false; } catch { return true; } });
        assert.equal(source.state, 'ready');
        assert.equal(fs.existsSync(path.dirname(arg('--onevent'))), false, 'runtime files removed');
    } finally { await source.disconnect(); }
});

test('only Stop is offered, and the Wii browser gets one start entry', async () => {
    const dir = tempDir();
    fakeBinary(dir, 'librespot', FAKE_LIBRESPOT(dir));
    const source = makeSource(dir);
    assert.deepEqual(source.capabilities, { stop: true, browse: true });
    const page = await source.browse();
    assert.equal(page.total, 1);
    assert.equal(page.items[0].type, 'station');
    assert.equal(page.items[0].title, 'Test Speaker');
});

test('a receiver that dies is restarted and the pipeline stream stays open', async () => {
    const dir = tempDir();
    fakeBinary(dir, 'librespot', FAKE_LIBRESPOT(dir, { crashFirst: true }));
    const source = makeSource(dir);
    const warnings = [];
    source.on('warning', (message) => warnings.push(message));
    try {
        const handle = await source.open();
        await waitFor(() => fs.existsSync(path.join(dir, 'runs.json'))
            && fs.readFileSync(path.join(dir, 'runs.json'), 'utf8').trim().split('\n').length >= 2, 8000);
        assert.ok(warnings.some((m) => /restarting/.test(m)));
        assert.equal(handle.stream.destroyed, false);
    } finally { await source.disconnect(); }
});
