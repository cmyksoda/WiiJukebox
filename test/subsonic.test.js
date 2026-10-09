// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Config } = require('../src/config');
const { SubsonicSource } = require('../src/sources/subsonic');

test('Navidrome auth preserves password whitespace, pages libraries and queues complete playlists', async () => {
    const password = '  fixture secret  ';
    const salts = new Set();
    const songs = Array.from({ length: 151 }, (_, i) => ({ id: `song-uuid-${i}`, title: `Track ${i}`, artist: 'Artist', album: 'Album', duration: 2 }));
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://fixture');
        assert.ok(url.pathname.startsWith('/music/rest/'));
        const q = url.searchParams;
        assert.equal(q.get('u'), 'fixture');
        assert.equal(q.get('v'), '1.16.1');
        assert.equal(q.get('c'), 'WiiJukebox');
        assert.equal(q.get('p'), null);
        const token = crypto.createHash('md5').update(password + q.get('s')).digest('hex');
        let response = { status: 'ok', version: '1.16.1' };
        if (q.get('t') !== token) response = { status: 'failed', error: { code: 40, message: 'Wrong credentials' } };
        else {
            assert.ok(!salts.has(q.get('s')), 'fresh salt for each request');
            salts.add(q.get('s'));
            const endpoint = url.pathname.split('/').pop();
            if (endpoint === 'getAlbum.view') response.album = { song: songs };
            if (endpoint === 'getPlaylist.view') response.playlist = { entry: [...songs].reverse() };
            if (endpoint === 'getArtist.view') response.artist = { album: songs.map((s) => ({ id: s.id, name: s.album })) };
            if (endpoint === 'getPlaylists.view') response.playlists = { playlist: songs.map((s) => ({ id: s.id, name: s.title })) };
            if (endpoint === 'getStarred2.view') response.starred2 = { song: songs };
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ 'subsonic-response': response }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const config = { url: `http://127.0.0.1:${server.address().port}/music/`, username: 'fixture', password };
    const source = new SubsonicSource(config);
    try {
        await source.connect();
        const bad = new SubsonicSource({ ...config, password: password.trim() });
        await assert.rejects(bad.connect(), /wrong username or password/);
        for (const path of ['album/album-uuid', 'playlist/list-uuid', 'artist/artist-uuid', 'playlists', 'starred']) {
            const page = await source.browse({ path, offset: 144, limit: 12 });
            assert.equal(page.total, 151);
            assert.equal(page.items.length, 7);
        }
        await source.open({ id: 'playlist/list-uuid', type: 'playlist' });
        assert.equal(source.queue.items.length, 151);
        assert.equal(source.queue.items[0].id, 'song-uuid-150');
        assert.equal(source.capabilities.previous, false);
        await source.next();
        assert.equal(source.queue.index, 1);
        const handle = await source.previous();
        assert.equal(new URL(handle.uri).searchParams.get('id'), 'song-uuid-150');
        assert.equal(new URL(handle.uri).searchParams.get('format'), 'raw');
        await source.open({ id: 'album/album-uuid', type: 'album', startId: songs[144].id, startIndex: 144 });
        assert.equal(source.queue.items.length, 151);
        assert.equal(source.queue.index, 144);
        assert.equal(new URL((await source.next()).uri).searchParams.get('id'), songs[145].id);
        await assert.rejects(source.open({ id: 'album/album-uuid', type: 'album', startId: 'removed' }), /no longer/);
        await assert.rejects(source.browse({ offset: -1 }), /invalid library page/);
        await source.close();
        assert.equal(source.queue.items.length, 0);
    } finally { await source.disconnect(); server.close(); }
});

test('an old second Navidrome address becomes the one address, used for requests and covers', async () => {
    const password = 'fixture';
    const server = http.createServer((req, res) => {
        const q = new URL(req.url, 'http://fixture').searchParams;
        const token = crypto.createHash('md5').update(password + q.get('s')).digest('hex');
        const response = q.get('t') === token
            ? { status: 'ok', version: '1.16.1', album: { song: [{ id: 's1', title: 'One', coverArt: 'c1', duration: 2 }] } }
            : { status: 'failed', error: { code: 40, message: 'Wrong credentials' } };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ 'subsonic-response': response }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const local = `http://127.0.0.1:${server.address().port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiijukebox-test-'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ sources: { subsonic: {
        url: 'https://music.example.invalid', serverUrl: local, username: 'u', password } } }));
    const migrated = new Config(dir).load().sources.subsonic;
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(migrated.url, local);
    assert.ok(!('serverUrl' in migrated));
    // The public URL is unreachable here, so every request that works used the carried-over address.
    const source = new SubsonicSource(migrated);
    try {
        await source.connect();
        const page = await source.browse({ path: 'album/a1', offset: 0, limit: 12 });
        assert.ok(page.items[0].artwork.startsWith(`${local}/rest/getCoverArt.view?`), 'the art proxy fetches it from here');
        const handle = await source.open({ id: 's1', type: 'track' });
        assert.ok(handle.uri.startsWith(`${local}/rest/stream.view?`));
    } finally { await source.disconnect(); server.close(); }
});
