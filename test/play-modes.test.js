// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');
const { Pipeline } = require('../src/core/pipeline');
const { Config } = require('../src/config');
const { Source } = require('../src/sources/base');
const { QueueSource } = require('../src/sources/queue');
const { WebServer } = require('../src/web/server');
const { WiiProtocol } = require('../src/client/protocol');
const { control } = require('../src/core/transport');
const { playModes, nextMode } = require('../src/core/play-modes');
const { tempDir } = require('./helpers/fake-binary');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The pipeline's own timers are unref'd, so a pending wait needs a live timer to hold the loop open.
async function within(promise, ms = 3000) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); })]);
    } finally { clearTimeout(timer); }
}

class Library extends QueueSource {
    static id = 'library';
    static label = 'Library';
    constructor() {
        super();
        this.calls = [];
        this.streams = [];
    }
    get capabilities() { return { play: true, pause: true, stop: true, ...this.queueCapabilities }; }
    async setShuffle(on) { this.calls.push(['shuffle', on]); await super.setShuffle(on); }
    async setRepeat(mode) { this.calls.push(['repeat', mode]); await super.setRepeat(mode); }
    async open() {
        this.calls.push(['open']);
        this._queue.load(['one', 'two', 'three'].map((id) => ({ id, title: id })));
        return this._openQueueItem();
    }
    _openQueueItem() {
        this.opened = this._queue.current.id;
        this.streams.push(new PassThrough());
        return { type: 'pcm', stream: this.streams.at(-1) };
    }
}

class Radio extends Source {
    static id = 'radio';
    static label = 'Radio';
    get capabilities() { return { play: true, stop: true }; }
    async open() { return { type: 'pcm', stream: new PassThrough() }; }
}

const fakeConfig = () => {
    const config = new Config('/unused-test-config');
    config.save = () => {};
    return config;
};

test('mode values are validated, and a missing value flips shuffle or cycles repeat', () => {
    assert.deepEqual(playModes({ shuffle: 'yes', repeat: 'sometimes' }), { shuffle: false, repeat: 'off' });
    assert.deepEqual(playModes({ shuffle: true, repeat: 'one' }), { shuffle: true, repeat: 'one' });
    assert.deepEqual(playModes(undefined), { shuffle: false, repeat: 'off' });
    const modes = { shuffle: false, repeat: 'off' };
    assert.equal(nextMode('shuffle', undefined, modes), true);
    assert.equal(nextMode('shuffle', 'on', modes), true);
    assert.equal(nextMode('shuffle', false, modes), false);
    assert.throws(() => nextMode('shuffle', 'maybe', modes), /on or off/);
    assert.deepEqual(['off', 'all', 'one', 'off'].map((_, i, all) => nextMode('repeat', undefined, { repeat: all[i] })), ['all', 'one', 'off', 'all']);
    assert.equal(nextMode('repeat', 'one', modes), 'one');
    assert.throws(() => nextMode('repeat', 'twice', modes), /off, all or one/);
});

test('status reports the modes and which of them the active source supports', async () => {
    const pipeline = new Pipeline({ modes: { shuffle: true, repeat: 'all' } });
    try {
        assert.deepEqual(pipeline.status.modes, { shuffle: true, repeat: 'all' });
        assert.deepEqual(pipeline.status.capabilities, { shuffle: true, repeat: true }, 'with nothing playing they can be preset');
        await pipeline.attach(new Library());
        assert.equal(pipeline.status.capabilities.shuffle, true);
        assert.equal(pipeline.status.capabilities.repeat, true);
        await pipeline.attach(new Radio());
        assert.equal(pipeline.status.capabilities.shuffle, false);
        assert.equal(pipeline.status.capabilities.repeat, false);
        assert.deepEqual(pipeline.status.modes, { shuffle: true, repeat: 'all' }, 'a source that cannot use the modes does not reset them');
    } finally { await pipeline.shutdown(); }
});

test('a source is given the saved modes before it opens anything', async () => {
    const pipeline = new Pipeline({ modes: { shuffle: true, repeat: 'one' } });
    const source = new Library();
    try {
        await pipeline.attach(source);
        assert.deepEqual(source.calls, [['shuffle', true], ['repeat', 'one'], ['open']]);
        assert.equal(source._queue.shuffle, true);
        assert.equal(source._queue.repeat, 'one');
    } finally { await pipeline.shutdown(); }
});

test('control sets, toggles and cycles the modes, tells the active source and saves them', async () => {
    const pipeline = new Pipeline();
    const config = fakeConfig();
    let saves = 0;
    config.save = () => { saves++; };
    const source = new Library();
    const events = [];
    pipeline.on('status', (status) => events.push(status.modes));
    try {
        let result = await control(pipeline, config, 'shuffle', { value: 'on' });
        assert.equal(result.ok, true, 'modes can be chosen before anything plays');
        assert.deepEqual(config.data.playModes, { shuffle: true, repeat: 'off' });

        await pipeline.attach(source);
        assert.equal(source._queue.shuffle, true);
        result = await control(pipeline, config, 'repeat', {});
        assert.equal(result.status.modes.repeat, 'all');
        assert.equal(source._queue.repeat, 'all');
        await control(pipeline, config, 'repeat', {});
        assert.equal(pipeline.modes.repeat, 'one');
        await control(pipeline, config, 'repeat', {});
        assert.equal(pipeline.modes.repeat, 'off');
        await control(pipeline, config, 'shuffle', {});
        assert.equal(pipeline.modes.shuffle, false);
        assert.equal(source._queue.shuffle, false);
        assert.deepEqual(config.data.playModes, { shuffle: false, repeat: 'off' });
        assert.equal(saves, 5);
        assert.ok(events.some((modes) => modes.repeat === 'one'), 'every change is pushed as a status event');

        const bad = await control(pipeline, config, 'repeat', { value: 'twice' });
        assert.equal(bad.code, 400);
        assert.match(bad.error, /off, all or one/);
        assert.equal(saves, 5, 'a refused change is not saved');
    } finally { await pipeline.shutdown(); }
});

test('control refuses the modes for a source that cannot honor them', async () => {
    const pipeline = new Pipeline();
    const config = fakeConfig();
    try {
        await pipeline.attach(new Radio());
        for (const action of ['shuffle', 'repeat']) {
            const result = await control(pipeline, config, action, { value: action === 'shuffle' ? 'on' : 'all' });
            assert.equal(result.code, 400);
            assert.match(result.error, /Radio does not support/);
        }
        assert.deepEqual(pipeline.modes, { shuffle: false, repeat: 'off' });
    } finally { await pipeline.shutdown(); }
});

test('the modes survive a restart through the saved config', async () => {
    const dir = tempDir('wiijukebox-modes-');
    const pipeline = new Pipeline();
    const config = new Config(dir);
    try {
        await control(pipeline, config, 'shuffle', { value: true });
        await control(pipeline, config, 'repeat', { value: 'one' });
        await sleep(400);
        assert.deepEqual(JSON.parse(fs.readFileSync(config.file, 'utf8')).playModes, { shuffle: true, repeat: 'one' });
        const reloaded = new Config(dir);
        reloaded.load();
        const restarted = new Pipeline({ modes: reloaded.data.playModes });
        assert.deepEqual(restarted.status.modes, { shuffle: true, repeat: 'one' });
        await restarted.shutdown();
    } finally { await pipeline.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('repeat-one replays the track that ended, repeat-all wraps and a plain end detaches', async () => {
    const pipeline = new Pipeline();
    pipeline.pacer._write = () => {};
    pipeline.pacer.start();
    pipeline.on('track-ended', (event) => pipeline.advanceEnded(event));
    const source = new Library();
    const finish = async (index) => {
        const ended = once(pipeline, 'track-ended');
        source.streams[index].end(Buffer.alloc(17640));
        await within(ended);
        await pipeline.command(async () => {});
    };
    try {
        await control(pipeline, fakeConfig(), 'repeat', { value: 'one' });
        await pipeline.attach(source);
        assert.equal(source.opened, 'one');
        await finish(0);
        assert.equal(source.opened, 'one', 'repeat-one plays the same track again');
        assert.equal(source.streams.length, 2);
        assert.equal(pipeline.activeSource, source);

        await control(pipeline, fakeConfig(), 'repeat', { value: 'all' });
        await control(pipeline, fakeConfig(), 'next');
        await control(pipeline, fakeConfig(), 'next');
        assert.equal(source.opened, 'three');
        await finish(source.streams.length - 1);
        assert.equal(source.opened, 'one', 'repeat-all wraps to the start');

        await control(pipeline, fakeConfig(), 'repeat', { value: 'off' });
        await control(pipeline, fakeConfig(), 'next');
        await control(pipeline, fakeConfig(), 'next');
        assert.equal(source.opened, 'three');
        await finish(source.streams.length - 1);
        assert.equal(pipeline.activeSource, null, 'without repeat the last track ends playback');
    } finally { await pipeline.shutdown(); }
});

test('the web API sets the modes and reports them in status', async () => {
    const pipeline = new Pipeline();
    const config = fakeConfig();
    const web = new WebServer({ pipeline, config });
    const address = await web.listen(0, '127.0.0.1');
    const post = (name, body) => fetch(`http://127.0.0.1:${address.port}/api/control/${name}`, { method: 'POST', body: JSON.stringify(body) });
    try {
        await pipeline.attach(new Library());
        assert.equal((await post('shuffle', { value: true })).status, 200);
        assert.equal((await post('repeat', { value: 'all' })).status, 200);
        const status = await (await fetch(`http://127.0.0.1:${address.port}/api/status`)).json();
        assert.deepEqual(status.modes, { shuffle: true, repeat: 'all' });
        assert.equal(status.capabilities.shuffle, true);
        assert.equal((await post('repeat', { value: 'sometimes' })).status, 400);
        assert.equal((await post('repeat', {})).status, 200, 'no value cycles to the next mode');
        assert.equal(pipeline.modes.repeat, 'one');
        await pipeline.attach(new Radio());
        assert.equal((await post('shuffle', { value: false })).status, 400);
    } finally { web.close(); await pipeline.shutdown(); }
});

test('the Wii status carries the modes and its controls change them', async () => {
    const pipeline = new Pipeline();
    const config = fakeConfig();
    const protocol = new WiiProtocol({ config, pipeline });
    const call = async (method, path) => {
        let body;
        await protocol.handle({ method }, { writeHead() {}, end(text) { body = String(text); } }, new URL(`http://fixture/api/wii/${path}`));
        return body;
    };
    const settle = async () => { while (protocol.commandState === 'pending') await sleep(5); };
    try {
        await pipeline.attach(new Library());
        assert.match(await call('GET', 'status'), /\nmodes\t0\toff\n/);
        assert.match(await call('GET', 'status'), /\n(status\t[^\n]*)shuffle%2Crepeat[^\n]*\n/, 'both appear in the controls list');

        assert.match(await call('POST', 'control?action=shuffle&value=on'), /\nok\taccepted\t1\n/);
        await settle();
        assert.equal(protocol.commandStatus, 'Shuffle on');
        assert.equal(protocol.commandState, 'complete');
        await call('POST', 'control?action=repeat&value=one');
        await settle();
        assert.equal(protocol.commandStatus, 'Repeat one');
        assert.match(await call('GET', 'status'), /\nmodes\t1\tone\n/);
        await call('POST', 'control?action=repeat&value=sideways');
        await settle();
        assert.equal(protocol.commandState, 'failed');
        assert.match(protocol.commandStatus, /repeat must be/);
        await call('POST', 'control?action=shuffle&value=off');
        await settle();
        assert.equal(protocol.commandStatus, 'Shuffle off');
        assert.equal(pipeline.modes.shuffle, false);
    } finally { await pipeline.shutdown(); }
});

test('status says which track of the list is playing, counted from 1, and nothing for sources without a list', async () => {
    const pipeline = new Pipeline();
    const config = fakeConfig();
    try {
        assert.equal(pipeline.status.queue, null, 'nothing is playing yet');
        await pipeline.attach(new Library());
        assert.deepEqual(pipeline.status.queue, { position: 1, total: 3 });
        await control(pipeline, config, 'next');
        assert.deepEqual(pipeline.status.queue, { position: 2, total: 3 });
        await pipeline.attach(new Radio());
        assert.equal(pipeline.status.queue, null);
    } finally { await pipeline.shutdown(); }
});
