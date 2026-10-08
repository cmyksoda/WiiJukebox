// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');
const { Pipeline } = require('../src/core/pipeline');
const { Source } = require('../src/sources/base');
const { Config } = require('../src/config');
const { SourceRegistry } = require('../src/sources');
const { WebServer } = require('../src/web/server');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Track extends Source {
    static id = 'test';
    get capabilities() { return { play: true, pause: true, stop: true, seek: true }; }
    async open() {
        this.stream = new PassThrough();
        return { type: 'pcm', stream: this.stream };
    }
}

test('short track drains every PCM byte before advancing', async () => {
    const pipeline = new Pipeline();
    let heard = 0;
    pipeline.pacer._write = (chunk) => {
        for (let i = 0; i < chunk.length; i++) if (chunk[i] === 42) heard++;
    };
    const source = new Track();
    pipeline.pacer.start();
    try {
        await pipeline.attach(source);
        const ended = once(pipeline, 'track-ended');
        source.stream.end(Buffer.alloc(17640, 42)); // 100ms, below 600ms prebuffer.
        await Promise.race([ended, sleep(1000).then(() => { throw new Error('did not drain'); })]);
        assert.equal(heard, 17640);
        assert.equal(pipeline.status.nowPlaying.position, 0.1);
    } finally { await pipeline.shutdown(); }
});

test('pause retains buffered audio and resume drains it', async () => {
    const pipeline = new Pipeline();
    pipeline.pacer._write = () => {};
    pipeline.pacer.start();
    try {
        pipeline.pacer.push(Buffer.alloc(120000));
        pipeline.setPaused(true);
        const position = pipeline.status.nowPlaying.position;
        await sleep(100);
        assert.equal(pipeline.pacer.buffered, 120000);
        assert.equal(pipeline.status.nowPlaying.position, position);
        pipeline.setPaused(false);
        await sleep(100);
        assert.ok(pipeline.pacer.buffered < 120000);
        assert.ok(pipeline.status.nowPlaying.position > position);
        await pipeline.detach();
        assert.equal(pipeline.status.nowPlaying.position, 0);
    } finally { await pipeline.shutdown(); }
});

test('HTTP controls stop, pause and resume the pipeline', async () => {
    const pipeline = new Pipeline();
    const config = new Config('/unused-test-config');
    config.save = () => {};
    const web = new WebServer({ pipeline, config });
    const address = await web.listen(0, '127.0.0.1');
    const control = (name) => fetch(`http://127.0.0.1:${address.port}/api/control/${name}`, { method: 'POST' });
    try {
        await pipeline.attach(new Track());
        assert.equal((await control('pause')).status, 200);
        assert.equal(pipeline.status.paused, true);
        assert.equal((await control('play')).status, 200);
        assert.equal(pipeline.status.paused, false);
        assert.equal((await control('seek')).status, 400);
        assert.equal((await control('stop')).status, 200);
        assert.equal(pipeline.activeSource, null);
        assert.equal((await control('play')).status, 409);
    } finally { web.close(); await pipeline.shutdown(); }
});

test('serialized commands recover after failures', async () => {
    const pipeline = new Pipeline();
    const order = [];
    const a = pipeline.command(async () => { await sleep(20); order.push(1); throw new Error('expected'); });
    const b = pipeline.command(() => order.push(2));
    await assert.rejects(a, /expected/);
    await b;
    assert.deepEqual(order, [1, 2]);
});

test('source reconfiguration replaces cached credentials and defaults are isolated', async () => {
    const config = new Config('/unused-test-config');
    config.save = () => {};
    const other = new Config('/unused-test-config');
    config.updateSource('jellyfin', { url: 'http://old', token: 'stale' });
    const registry = new SourceRegistry(config);
    const old = registry.get('jellyfin');
    await registry.configure('jellyfin', { url: 'http://new', username: 'new' });
    assert.notEqual(registry.get('jellyfin'), old);
    assert.equal(registry.get('jellyfin').config.token, null);
    assert.equal(other.sourceConfig('jellyfin').url, '');
    assert.throws(() => config.updateSource('__proto__', {}), /unknown source/);
});

test('an old track completion cannot skip the replacement track', async () => {
    const pipeline = new Pipeline();
    const source = new Track();
    let advances = 0;
    source.advance = async () => { advances++; return null; };
    try {
        await pipeline.attach(source);
        const oldEvent = { source, generation: pipeline._generation };
        const replacement = new PassThrough();
        await pipeline.playHandle({ type: 'pcm', stream: replacement });
        await pipeline.advanceEnded(oldEvent);
        assert.equal(advances, 0);
        assert.equal(pipeline.activeSource, source);
        assert.equal(pipeline._pcmStream, replacement);
    } finally { await pipeline.shutdown(); }
});
