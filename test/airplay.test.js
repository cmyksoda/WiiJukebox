// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { AirplaySource, MetadataParser } = require('../src/sources/airplay');
const { tempDir, fakeBinary, waitFor } = require('./helpers/fake-binary');

const hex = (text) => Buffer.from(text, 'latin1').toString('hex');
const item = (type, code, data) => {
    const body = data === undefined ? null : Buffer.from(data);
    return `<item><type>${hex(type)}</type><code>${hex(code)}</code><length>${body ? body.length : 0}</length>` +
        (body ? `\n<data encoding="base64">\n${body.toString('base64')}</data>` : '') + '</item>\n';
};

test('metadata parser reads items split at arbitrary points and ignores noise', () => {
    const seen = [];
    const parser = new MetadataParser((entry) => seen.push(`${entry.type}/${entry.code}/${entry.data.toString()}`));
    const stream = `junk${item('core', 'minm', 'Voyager')}${item('ssnc', 'pbeg')}${item('core', 'asar', 'Daft Punk')}`;
    for (let i = 0; i < stream.length; i += 11) parser.write(Buffer.from(stream.slice(i, i + 11)));
    assert.deepEqual(seen, ['core/minm/Voyager', 'ssnc/pbeg/', 'core/asar/Daft Punk']);
});

// Pretends to be shairport-sync: reads the generated config, writes PCM to
// stdout and metadata to the pipe named there, as the real program does.
const FAKE_SHAIRPORT = (dir, items) => `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('-V')) { console.log('5.5.2-fake'); process.exit(0); }
const conf = fs.readFileSync(args[args.indexOf('-c') + 1], 'utf8');
fs.writeFileSync(${JSON.stringify(path.join(dir, 'conf.txt'))}, conf);
const pipe = /pipe_name = "([^"]+)"/.exec(conf)[1];
const fd = fs.openSync(pipe, fs.constants.O_WRONLY);
process.stdout.write(Buffer.alloc(8000, 5));
(async () => {
    for (const text of ${JSON.stringify(items)}) {
        fs.writeSync(fd, Buffer.from(text, 'latin1'));
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
})();
setInterval(() => {}, 1000);
`;

test('AirPlay receiver relays PCM, now-playing text and downscaled cover art', async (t) => {
    const dir = tempDir();
    const png = path.join(dir, 'cover.png');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x4a7bd0:s=900x900',
        '-frames:v', '1', '-y', png]);
    const items = [
        item('ssnc', 'snam', "Jaxi's iPhone"), item('ssnc', 'pbeg'),
        item('ssnc', 'mdst', '1234'), item('core', 'minm', 'Night Tone'), item('core', 'asar', 'Test Artist'),
        item('core', 'asal', 'Test Album'), item('ssnc', 'mden', '1234'),
        item('ssnc', 'PICT', fs.readFileSync(png)),
    ];
    fakeBinary(dir, 'shairport-sync', FAKE_SHAIRPORT(dir, items));
    const source = new AirplaySource({ binary: path.join(dir, 'shairport-sync'), deviceName: 'Test "Speaker"',
        password: 'p\\w', latencyMs: 0 }, {});
    const metadata = [];
    source.on('metadata', (meta) => metadata.push(meta));
    try {
        await source.connect();
        const handle = await source.open();
        const chunks = [];
        handle.stream.on('data', (chunk) => chunks.push(chunk));
        await waitFor(() => metadata.some((m) => m.title === 'Night Tone' && m.artwork), 8000);
        const done = metadata.findLast((m) => m.title === 'Night Tone');
        assert.equal(done.artist, 'Test Artist');
        assert.equal(done.album, 'Test Album');
        assert.equal(done.duration, null);
        assert.match(done.artwork, /^data:image\/jpeg;base64,/);
        assert.ok(done.artwork.length < 60000, 'cover is shrunk before it reaches status updates');
        assert.equal(source.info().client, "Jaxi's iPhone");
        assert.equal(source.info().playing, true);

        await waitFor(() => chunks.reduce((sum, c) => sum + c.length, 0) >= 8000);
        const conf = fs.readFileSync(path.join(dir, 'conf.txt'), 'utf8');
        assert.match(conf, /name = "Test \\"Speaker\\""/);
        assert.match(conf, /output_backend = "stdout"/);
        assert.match(conf, /output_format = "S16_LE"/);
        assert.match(conf, /password = "p\\\\w"/);
        assert.match(conf, /include_cover_art = "yes"/);
        assert.deepEqual(source.capabilities, { stop: true, browse: true });
    } finally { await source.disconnect(); }
    t.diagnostic(`artwork bytes: ${metadata.at(-1).artwork?.length}`);
});

test('AirPlay reports a missing shairport-sync, and Wii browsing shows one start entry', async () => {
    const source = new AirplaySource({ binary: '/nonexistent/shairport-sync' }, {});
    await assert.rejects(source.connect(), /shairport-sync not found/);
    const page = await source.browse();
    assert.equal(page.items[0].type, 'station');
});

test('pend clears the track and returns to the waiting message', async () => {
    const dir = tempDir();
    const items = [item('ssnc', 'mdst'), item('core', 'minm', 'Song'), item('ssnc', 'mden'), item('ssnc', 'pend')];
    fakeBinary(dir, 'shairport-sync', FAKE_SHAIRPORT(dir, items));
    const source = new AirplaySource({ binary: path.join(dir, 'shairport-sync'), latencyMs: 0 }, {});
    const titles = [];
    source.on('metadata', (meta) => titles.push(meta.title));
    try {
        await source.open();
        await waitFor(() => titles.includes('Song') && titles.at(-1) === 'Waiting for AirPlay' && titles.length >= 3);
    } finally { await source.disconnect(); }
});
