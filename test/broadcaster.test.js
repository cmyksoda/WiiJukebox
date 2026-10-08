// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Broadcaster, BURST_SECONDS, RESUME_SECONDS, BACKLOG_SECONDS } = require('../src/core/broadcaster');

function listen(broadcaster, url = '/stream', { queued = () => 0 } = {}) {
    const res = new EventEmitter();
    const client = { headers: null, bytes: [], destroyed: false, res };
    Object.defineProperty(res, 'writableLength', { get: queued });
    Object.assign(res, {
        destroyed: false, writableEnded: false,
        writeHead(code, headers) { assert.equal(code, 200); client.headers = headers; },
        write(chunk) { client.bytes.push(...chunk); return queued() === 0; },
        end() {},
        destroy() { res.destroyed = client.destroyed = true; },
    });
    const socket = { remoteAddress: '192.0.2.8', setNoDelay() {}, setTimeout() {}, setKeepAlive() {} };
    broadcaster.handleRequest({ method: 'GET', url, headers: {}, socket }, res);
    return client;
}

function feed(broadcaster, chunks, size) {
    for (let i = 0; i < chunks; i++) {
        broadcaster.write(Buffer.alloc(size, (broadcaster._audioBytes / size) & 0xff));
    }
}

test('new listeners get a burst sized in seconds at the current bitrate', () => {
    const broadcaster = new Broadcaster({ bitrate: 256, sampleRate: 48000 });
    feed(broadcaster, 40, 8000); // 10 s at 256 kbps
    const client = listen(broadcaster);
    const start = Number(client.headers['X-WiiJukebox-Byte-Start']);
    assert.equal(client.headers['icy-br'], '256');
    assert.equal(client.headers['icy-sr'], '48000');
    assert.equal(start, 320000 - BURST_SECONDS * 32000);
    assert.equal(client.bytes.length, 320000 - start);
});

test('a reconnecting listener resumes at its exact byte within the same epoch', () => {
    const broadcaster = new Broadcaster({ bitrate: 128 });
    feed(broadcaster, 30, 4000); // 7.5 s at 128 kbps
    const from = 12345;
    const client = listen(broadcaster, `/stream?epoch=${broadcaster.epoch}&from=${from}`);
    assert.equal(client.headers['X-WiiJukebox-Byte-Start'], String(from));
    assert.equal(client.bytes.length, 120000 - from);
    assert.equal(client.bytes[0], Math.floor(from / 4000));
    assert.equal(client.bytes[4000 - (from % 4000)], Math.floor(from / 4000) + 1);
});

test('stale resumes fall back to the normal burst', () => {
    const broadcaster = new Broadcaster({ bitrate: 128 });
    feed(broadcaster, 200, 4000); // 50 s, beyond the resume history
    const burst = String(800000 - BURST_SECONDS * 16000);
    const old = listen(broadcaster, `/stream?epoch=${broadcaster.epoch}&from=1000`);
    assert.equal(old.headers['X-WiiJukebox-Byte-Start'], burst);
    const other = listen(broadcaster, `/stream?epoch=${broadcaster.epoch + 1}&from=790000`);
    assert.equal(other.headers['X-WiiJukebox-Byte-Start'], burst);
    const ahead = listen(broadcaster, `/stream?epoch=${broadcaster.epoch}&from=900000`);
    assert.equal(ahead.headers['X-WiiJukebox-Byte-Start'], burst);
    assert.ok(broadcaster._historyBytes <= RESUME_SECONDS * 16000);
    assert.equal(listen(broadcaster, `/stream?epoch=${broadcaster.epoch}&from=${800000 - RESUME_SECONDS * 16000}`)
        .headers['X-WiiJukebox-Byte-Start'], String(800000 - RESUME_SECONDS * 16000));
});

test('a steady small queue is never mistaken for a stalled listener', () => {
    const broadcaster = new Broadcaster({ bitrate: 128 });
    const client = listen(broadcaster, '/stream', { queued: () => 20000 });
    feed(broadcaster, 2000, 4000); // 8 MB written while write() keeps returning false
    assert.equal(client.destroyed, false);
    assert.equal(broadcaster.listenerCount, 1);
});

test('a listener with more than the backlog limit queued is dropped', () => {
    const broadcaster = new Broadcaster({ bitrate: 128 });
    let queued = 0;
    const client = listen(broadcaster, '/stream', { queued: () => queued });
    feed(broadcaster, 1, 4000);
    queued = BACKLOG_SECONDS * 16000 + 1;
    feed(broadcaster, 1, 4000);
    assert.equal(client.destroyed, true);
    assert.equal(broadcaster.listenerCount, 0);
});
