// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('a track click sends the album or playlist with the place to start', async () => {
    const { playRequest, isContainer } = await import('../public/play-request.mjs');
    const tracks = [{ id: 'a', type: 'track', title: 'A' }, { id: 'b', type: 'track', title: 'B' }, { id: 'a', type: 'track', title: 'A again' }];
    const playlist = { id: 'playlist/p1', type: 'playlist', title: 'Mix', artwork: 'https://x.example/m.png' };

    assert.deepEqual(playRequest(tracks[1], { container: playlist, offset: 0, index: 1 }),
        { ...playlist, startId: 'b', startIndex: 1 }, 'the same shape the Wii sends');
    assert.equal(playRequest(tracks[2], { container: playlist, offset: 100, index: 2 }).startIndex, 102, 'later pages count from their offset');
    assert.equal(playRequest(tracks[0], { container: { ...playlist, type: 'album' } }).type, 'album');
    assert.equal(playRequest(tracks[0], { container: null }), tracks[0], 'search results and loose tracks play alone');
    assert.equal(playRequest(tracks[0], { container: { id: 'artists', type: 'folder' } }), tracks[0], 'folders are not queues');
    assert.deepEqual([isContainer(playlist), isContainer(tracks[0]), isContainer(null)], [true, false, false]);
});
