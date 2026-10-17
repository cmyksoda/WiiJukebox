// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PlexSource } = require('../src/sources/plex');

test('Plex music browsing, paged queues, search, headers and token containment', async () => {
    let hostile = false;
    const requests = [];
    const server = http.createServer((req, res) => {
        assert.equal(req.headers['x-plex-token'], 'fixture-token');
        requests.push(req.url);
        const url = new URL(req.url, 'http://localhost');
        let data;
        if (url.pathname === '/library/sections') data = { Directory: [
            { key: '1', type: 'artist', title: 'Music' }, { key: '2', type: 'movie', title: 'Movies' }] };
        else if (url.pathname === '/library/sections/1/all') data = { Metadata: [{ ratingKey: '10', type: 'artist', title: 'Artist' }] };
        else if (url.pathname === '/library/metadata/10/children') data = { Metadata: [{ ratingKey: '20', type: 'album', title: 'Album', thumb: '/library/metadata/20/thumb/1' }] };
        else if (url.pathname === '/library/metadata/20/children') {
            const offset = Number(req.headers['x-plex-container-start']);
            data = { offset, totalSize: 2, Metadata: [{ ratingKey: String(30 + offset), type: 'track', title: 'Song' }] };
        } else if (/\/library\/metadata\/3[01]$/.test(url.pathname)) data = { Metadata: [{ ratingKey: url.pathname.split('/').pop(), type: 'track', title: 'Song', grandparentTitle: 'Artist', parentTitle: 'Album', parentThumb: hostile ? 'https://evil.invalid/art' : '/library/metadata/20/thumb/1', Media: [{ Part: [{ key: hostile ? 'https://evil.invalid/song' : '/library/parts/1/file.mp3' }] }] }] };
        else if (url.pathname === '/hubs/search') data = { Hub: [{ Metadata: [{ type: 'track', ratingKey: '30', title: 'Song' }, { type: 'movie', ratingKey: '2' }] }] };
        else if (url.pathname === '/playlists') data = { Metadata: [{ type: 'playlist', ratingKey: '40', title: 'Playlist', composite: '/playlists/40/composite/1' }] };
        else { res.writeHead(404); return res.end(); }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ MediaContainer: data }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const source = new PlexSource({ url: `http://127.0.0.1:${server.address().port}`, token: 'fixture-token' });
    try {
        await source.connect();
        assert.equal((await source.browse()).items.length, 2);
        assert.equal((await source.browse({ path: 'section/1' })).items[0].type, 'artist');
        const album = (await source.browse({ path: 'artist/10' })).items[0];
        assert.equal(album.id, 'album/20');
        assert.equal(album.artwork, `http://127.0.0.1:${server.address().port}/library/metadata/20/thumb/1?X-Plex-Token=fixture-token`);
        const nowPlaying = [];
        source.on('metadata', (meta) => nowPlaying.push(meta));
        const handle = await source.open({ type: 'album', id: 'album/20' });
        assert.equal(nowPlaying.at(-1).artwork, album.artwork);
        assert.equal(handle.headers['X-Plex-Token'], 'fixture-token');
        assert.ok(!handle.uri.includes('fixture-token'));
        assert.equal(source._queue.length, 2);
        assert.ok(await source.next());
        assert.equal(await source.next(), null);
        assert.ok(await source.previous());
        await source.open({ type: 'album', id: 'album/20', startId: 'track/31', startIndex: 1 });
        assert.equal(source.queue.index, 1);
        assert.equal(source._queue.length, 2);
        assert.equal(await source.next(), null);
        assert.equal((await source.search('Song')).items.length, 1);
        const playlist = (await source.browse({ path: 'playlists' })).items[0];
        assert.equal(playlist.type, 'playlist');
        assert.match(playlist.artwork, /\/playlists\/40\/composite\/1\?X-Plex-Token=fixture-token$/);
        hostile = true;
        await assert.rejects(source.open({ type: 'track', id: 'track/30' }), /invalid media path/);
        await assert.rejects(source.browse({ path: 'album/../../token' }), /invalid Plex item/);
        assert.ok(requests.length >= 10);
    } finally { await source.disconnect(); server.close(); }
});
