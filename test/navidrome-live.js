// SPDX-License-Identifier: GPL-3.0-only
// This test deliberately writes a playlist and a star in an isolated fixture.
// See client/README.md. Never point it at a personal music server.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { SubsonicSource } = require('../src/sources/subsonic');
const { Pipeline } = require('../src/core/pipeline');
const { Config } = require('../src/config');
const { SourceRegistry } = require('../src/sources');
const { WebServer } = require('../src/web/server');
const { Discovery } = require('../src/client/discovery');
const run = promisify(execFile);

async function main() {
    const url = process.env.NAVIDROME_TEST_URL;
    assert.equal(process.env.NAVIDROME_FIXTURE, '1', 'requires NAVIDROME_FIXTURE=1 and a disposable fixture');
    assert.equal(new URL(url).hostname, '127.0.0.1', 'fixture must bind to loopback');
    const credentials = { url, username: 'fixture', password: 'fixture-pass-2026' };
    const source = new SubsonicSource(credentials);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wj-navidrome-stream-'));
    let playlistId;
    let songId;
    let pipeline, web, discovery, registry;
    try {
        await source.connect();
        const bad = new SubsonicSource({ ...credentials, password: 'wrong' });
        await assert.rejects(bad.connect(), /wrong username or password/);
        console.log('PASS: salted-token authentication and wrong-password rejection');
        const artists = await source.browse({ path: 'artists' });
        assert.equal(artists.items[0].title, 'WiiJukebox Test Artist');
        const albums = await source.browse({ path: artists.items[0].id });
        const album = albums.items.find((i) => i.title === 'Test Album');
        assert.ok(album);
        const first = await source.browse({ path: album.id, offset: 0, limit: 12 });
        const last = await source.browse({ path: album.id, offset: 12, limit: 12 });
        assert.equal(first.items.length, 12); assert.equal(last.items.length, 1);
        assert.equal(last.items[0].title, 'Tone 13');
        songId = first.items[0].id;
        assert.equal((await source.search('Tone')).items.filter((i) => i.type === 'track').length, 13);
        await source.open(album);
        assert.equal(source.queue.items.length, 13);
        assert.equal(source.capabilities.previous, false);
        await source.next(); assert.equal(source.queue.index, 1);
        await source.previous(); assert.equal(source.queue.index, 0);
        console.log('PASS: artists, albums, search, Wii-sized pages and album queue');
        const create = new URL(source._url('createPlaylist.view', { name: 'WiiJukebox disposable fixture' }));
        for (let i = 0; i < 151; i++) create.searchParams.append('songId', first.items[i % first.items.length].id);
        const created = (await (await fetch(create)).json())['subsonic-response'];
        assert.equal(created.status, 'ok');
        playlistId = created.playlist.id;
        const playlists = await source.browse({ path: 'playlists' });
        const playlist = playlists.items.find((i) => i.id === `playlist/${playlistId}`);
        assert.ok(playlist);
        assert.equal((await source.browse({ path: playlist.id, offset: 144, limit: 12 })).items.length, 7);
        await source.open(playlist);
        assert.equal(source.queue.items.length, 151);
        await source._call('star.view', { id: songId });
        assert.ok((await source.browse({ path: 'starred' })).items.some((i) => i.id === songId));
        console.log('PASS: 151-track playlist queues in full, paging and starred tracks');
        const art = await fetch(first.items[0].artwork);
        assert.equal(art.status, 200);
        assert.ok((await art.arrayBuffer()).byteLength > 0);
        console.log('PASS: cover-art URL authenticates and returns image bytes');

        const plays = async () => (await source._call('getSong.view', { id: songId })).song.playCount || 0;
        const before = await plays();
        await source.reportPlaying({ id: songId });
        await source.reportPlayed({ id: songId }, { startedAt: Date.now() - 60000 });
        for (let i = 0; i < 50 && await plays() === before; i++) await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(await plays(), before + 1);
        console.log('PASS: now-playing and scrobble reports count the play in Navidrome');

        const config = new Config(tmp); config.save = () => {};
        config.updateSource('subsonic', credentials);
        pipeline = new Pipeline();
        const titles = [];
        pipeline.on('metadata', (meta) => titles.push(meta.title));
        pipeline.on('track-ended', (event) => pipeline.advanceEnded(event));
        registry = new SourceRegistry(config);
        web = new WebServer({ config, pipeline, registry });
        const address = await web.listen(0, '127.0.0.1');
        discovery = new Discovery({ config, port: address.port });
        const udp = await discovery.start(0, '127.0.0.1');
        pipeline.start();
        const output = path.join(tmp, 'stream.mp3');
        const result = await run('./client/build/network_probe', [String(udp.port), output, 'subsonic'], { timeout: 15000 });
        assert.match(result.stdout, /MP3 stream, exact resume and stop passed/);
        const pcm = await run('ffmpeg', ['-v', 'error', '-i', output, '-f', 's16le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
        let peak = 0;
        for (let i = 0; i + 1 < pcm.stdout.length; i += 2) peak = Math.max(peak, Math.abs(pcm.stdout.readInt16LE(i)));
        assert.ok(peak > 500);
        assert.ok(titles.includes('Tone 01'));
        assert.ok(titles.includes('Tone 02'), 'album automatically advances after the first track drains');
        assert.equal(pipeline.activeSource, null);
        console.log('PASS: native C discovery -> Navidrome album -> non-silent decoded MP3 -> stop');
        console.log(`Navidrome live fixture passed; ${titles.length} track metadata events, decoded peak ${peak}`);
    } finally {
        discovery?.close(); web?.close();
        if (pipeline) await pipeline.shutdown();
        if (registry) await registry.disconnectAll();
        if (playlistId) await source._call('deletePlaylist.view', { id: playlistId });
        if (songId) await source._call('unstar.view', { id: songId });
        await source.disconnect();
        await fs.rm(tmp, { recursive: true, force: true });
    }
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
