// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { Pipeline } = require('../src/core/pipeline');
const { Pacer } = require('../src/core/pacer');
const { Source } = require('../src/sources/base');
const { Config } = require('../src/config');
const { WiiProtocol } = require('../src/client/protocol');
const { control } = require('../src/core/transport');
const { BYTES_PER_SECOND } = require('../src/core/format');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Pcm extends Source {
    static id = 'pcm';
    get capabilities() { return { play: true, stop: true, next: true }; }
    async open() { this.stream = new PassThrough(); return { type: 'pcm', stream: this.stream }; }
    async next() { this.stream = new PassThrough(); return { type: 'pcm', stream: this.stream }; }
}

function listener(pipeline, url) {
    const res = new EventEmitter();
    Object.assign(res, { writableLength: 0, writeHead() {}, write() { return true; }, end() {}, destroy() {} });
    const socket = { setNoDelay() {}, setTimeout() {}, setKeepAlive() {} };
    pipeline.broadcaster.handleRequest({ method: 'GET', url, headers: {}, socket }, res);
}

test('a burst emits audio ahead of the clock once, then keeps real-time pacing', async () => {
    let audio = 0;
    const pacer = new Pacer({ write: (chunk, timing) => { if (timing.audio) audio += chunk.length; return true; } });
    pacer.start();
    try {
        pacer.push(Buffer.alloc(BYTES_PER_SECOND * 3));
        pacer.burst(2000);
        await sleep(300);
        assert.ok(audio >= BYTES_PER_SECOND * 2, `burst sent ${audio} bytes in 0.3 s`);
        const after = audio;
        await sleep(400);
        const rate = (audio - after) / 0.4;
        assert.ok(rate > BYTES_PER_SECOND * 0.8 && rate < BYTES_PER_SECOND * 1.2, `real-time afterwards (${rate} B/s)`);
        pacer.reset();
        assert.equal(pacer._burstBytes, 0, 'a reset cancels an unfinished burst');
    } finally { pacer.stop(); }
});

test('transport changes mark the byte where new audio starts; only jump listeners get a burst', async () => {
    const pipeline = new Pipeline();
    const writes = [];
    const write = pipeline.pacer._write;
    pipeline.pacer._write = (chunk, timing) => { writes.push(timing.audio); return write(chunk, timing); };
    pipeline.start();
    try {
        const source = new Pcm();
        await pipeline.attach(source);
        assert.equal(pipeline.jump, null, 'unknown until the new audio is written');
        assert.equal(pipeline.pacer._burstBytes, 0, 'no jump listener, so no burst');
        await sleep(200);
        source.stream.write(Buffer.alloc(BYTES_PER_SECOND));
        await sleep(200);
        const first = pipeline.jump;
        assert.ok(first && first.id === 1 && first.epoch === pipeline.broadcaster.epoch && first.byte > 0);
        assert.ok(first.byte <= pipeline.timeline.time * pipeline.broadcaster.bitrate / 8);

        listener(pipeline, '/stream?v=2');
        assert.equal(pipeline.broadcaster.jumpListeners, 1);
        const announced = [];
        pipeline.on('status', (status) => { if (status.jump) announced.push(status.jump.id); });
        await control(pipeline, { data: {}, save() {} }, 'next');
        assert.ok(pipeline.pacer._burstBytes > 0, 'a jump listener gets a burst');
        assert.equal(pipeline.jump, null, 'the next marker waits for its audio');
        source.stream.write(Buffer.alloc(BYTES_PER_SECOND * 5));
        await sleep(300);
        assert.equal(pipeline.jump.id, 2);
        assert.ok(pipeline.jump.byte > first.byte);
        assert.ok(announced.includes(2), 'a status event announces the marker once its byte is known');

        // A track ending on its own is continuous, so it is never marked.
        await pipeline.playHandle({ type: 'pcm', stream: new PassThrough() });
        assert.equal(pipeline.jump.id, 2);

        await control(pipeline, { data: {}, save() {} }, 'stop');
        await sleep(100);
        assert.equal(pipeline.jump.id, 3, 'stop marks the first byte after it');
        assert.ok(pipeline.jump.byte >= first.byte);
        assert.deepEqual(pipeline.status.jump, pipeline.jump);
    } finally { await pipeline.shutdown(); }
});

test('the Wii status carries the jump marker for clients that follow it', async () => {
    const config = new Config('/unused-test-config');
    config.save = () => {};
    const pipeline = { status: { nowPlaying: { title: 'Song' }, capabilities: {}, jump: { id: 4, epoch: 77, byte: 123456 } } };
    const protocol = new WiiProtocol({ config, pipeline });
    let body;
    await protocol.handle({ method: 'GET' }, { writeHead() {}, end(text) { body = String(text); } },
        new URL('http://fixture/api/wii/status'));
    assert.match(body, /\njump\t4\t77\t123456\n/);
    pipeline.status.jump = null;
    await protocol.handle({ method: 'GET' }, { writeHead() {}, end(text) { body = String(text); } },
        new URL('http://fixture/api/wii/status'));
    assert.doesNotMatch(body, /jump/);
});
