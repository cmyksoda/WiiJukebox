// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { queueStart } = require('../src/sources/queue');
const { JellyfinSource } = require('../src/sources/jellyfin');

test('queue start preserves duplicate playlist positions and handles changed lists', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'a' }];
    assert.equal(queueStart(items, {}), 0);
    assert.equal(queueStart(items, { startId: 'a', startIndex: 2 }), 2);
    assert.equal(queueStart(items, { startId: 'b', startIndex: 0 }), 1);
    assert.throws(() => queueStart(items, { startId: 'gone' }), /no longer/);
});

test('Jellyfin album selection keeps the queue and starts at the selected track', async () => {
    const source = new JellyfinSource();
    source.browse = async () => ({ items: [{ type: 'track', id: 'one' }, { type: 'track', id: 'two' }] });
    source._openQueueItem = () => source._queue[source._queueIndex];
    assert.equal((await source.open({ type: 'album', id: 'album/test', startId: 'two', startIndex: 1 })).id, 'two');
    assert.equal(source._queue.length, 2);
    assert.equal((await source.open({ type: 'album', id: 'album/test' })).id, 'one');
});
