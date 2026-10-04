// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
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
