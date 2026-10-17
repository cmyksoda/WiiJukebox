// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Decoder } = require('../src/core/decoder');
const { DesktopSource } = require('../src/sources/desktop');

test('desktop source only opens a user-selected available output monitor', async () => {
    const source = new DesktopSource({}, { execFile: async (command, args) => {
        assert.equal(command, 'pactl');
        assert.deepEqual(args, ['--format=json', 'list', 'sources']);
        return { stdout: JSON.stringify([
            { name: 'microphone', description: 'Mic' },
            { name: 'music.monitor', description: 'Music output' },
        ]) };
    } });
    await source.connect();
    const page = await source.browse();
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].id, 'music.monitor');
    await assert.rejects(source.open({ id: 'microphone' }), /available output monitor/);
    assert.deepEqual(await source.open({ id: 'music.monitor' }), {
        type: 'device', format: 'pulse', device: 'music.monitor',
    });
    assert.equal(source.capabilities.pause, undefined);
    await source.close();
    assert.equal(source.state, 'ready');
});

test('desktop dependencies failing produce a useful error', async () => {
    const source = new DesktopSource({}, { execFile: async () => { throw new Error('ENOENT'); } });
    await assert.rejects(source.connect(), /pactl/);
    assert.equal(source.state, 'error');
});

test('a selected monitor is recorded with parec in the interchange format', async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wiijukebox-parec-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const parec = path.join(tmp, 'parec');
    fs.writeFileSync(parec, `#!${process.execPath}\nprocess.stderr.write(JSON.stringify(process.argv.slice(2)));\n`
        + 'process.stdout.write(Buffer.alloc(4096));\n', { mode: 0o755 });

    const decoder = new Decoder({ device: 'music.monitor', format: 'pulse', parecPath: parec, ffmpegPath: '/nonexistent' });
    const result = await new Promise((resolve, reject) => {
        let bytes = 0;
        let args = '';
        decoder.on('data', (chunk) => { bytes += chunk.length; });
        decoder.on('log', (text) => { args += text; });
        decoder.on('ended', () => resolve({ bytes, args: JSON.parse(args) }));
        decoder.on('error', reject);
        decoder.start();
    });
    assert.equal(result.bytes, 4096);
    assert.deepEqual(result.args, ['--device=music.monitor', '--raw', '--format=s16le', '--rate=44100',
        '--channels=2', '--latency-msec=50']);
});
