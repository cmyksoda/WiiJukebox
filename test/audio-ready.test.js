// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { Pipeline } = require('../src/core/pipeline');
const { Config } = require('../src/config');
const { WiiProtocol } = require('../src/client/protocol');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Wii completion waits for decoded audio and carries the accepted command id', async () => {
    const pipeline = new Pipeline();
    const config = new Config('/unused-test-config');
    const protocol = new WiiProtocol({ config, pipeline });
    const stream = new PassThrough();
    try {
        pipeline._consume({ type: 'pcm', stream });
        const id = protocol._command(Promise.resolve(), { audio: true, message: 'Audio ready' });
        await tick();
        assert.equal(id, 1);
        assert.equal(protocol.commandState, 'pending');
        assert.equal(protocol.commandStatus, 'Waiting for audio...');
        stream.write(Buffer.alloc(512));
        await tick();
        assert.equal(protocol.commandState, 'complete');
        assert.equal(protocol.commandStatus, 'Audio ready');
        assert.equal(pipeline.listenerCount('audio-readiness'), 0);
        let body;
        await protocol.handle({ method: 'GET' }, { writeHead() {}, end(text) { body = text; } },
            new URL('http://fixture/api/wii/status'));
        assert.match(body, /command\tAudio%20ready\t1\tcomplete/);
    } finally { await pipeline.shutdown(); }
});

test('decode failure and replaced input reject readiness without leaving listeners', async () => {
    const pipeline = new Pipeline();
    try {
        pipeline._consume({ type: 'pcm', stream: new PassThrough() });
        const failed = assert.rejects(pipeline.waitForAudio(), /decode failed/);
        pipeline._audioFailed(new Error('decode failed'));
        await failed;
        assert.equal(pipeline.listenerCount('audio-readiness'), 0);
        pipeline._consume({ type: 'pcm', stream: new PassThrough() });
        const replaced = assert.rejects(pipeline.waitForAudio(), /selection replaced/);
        await pipeline.detach();
        await replaced;
        assert.equal(pipeline.listenerCount('audio-readiness'), 0);
    } finally { await pipeline.shutdown(); }
});

test('a delayed old completion cannot overwrite a newer command result', async () => {
    const config = new Config('/unused-test-config');
    const protocol = new WiiProtocol({ config, pipeline: {} });
    let done;
    protocol._command(new Promise(resolve => { done = resolve; }), { message: 'Old' });
    protocol._command(Promise.resolve(), { message: 'New' });
    await tick();
    done();
    await tick();
    assert.equal(protocol.commandId, 2);
    assert.equal(protocol.commandStatus, 'New');
});

test('stop can cancel a pending wait for first audio', async () => {
    const pipeline = new Pipeline();
    const config = new Config('/unused-test-config');
    config.save = () => {};
    const protocol = new WiiProtocol({ config, pipeline });
    pipeline._source = { id: 'fixture', label: 'Fixture', capabilities: { stop: true }, off() {}, async close() {} };
    pipeline._consume({ type: 'pcm', stream: new PassThrough() });
    protocol._command(Promise.resolve(), { audio: true });
    await tick();
    assert.equal(protocol.commandState, 'pending');
    let status, body;
    await protocol.handle({ method: 'POST' }, { writeHead(code) { status = code; }, end(text) { body = text; } },
        new URL('http://fixture/api/wii/control?action=stop'));
    assert.equal(status, 200);
    assert.match(body, /ok\taccepted\t2/);
    await tick();
    assert.equal(protocol.commandStatus, 'Stopped');
    assert.equal(protocol.commandState, 'complete');
    assert.equal(pipeline.listenerCount('audio-readiness'), 0);
    await pipeline.shutdown();
});
