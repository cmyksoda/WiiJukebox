// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Config } = require('../src/config');
const { Pipeline } = require('../src/core/pipeline');
const { SourceRegistry } = require('../src/sources');
const { WebServer } = require('../src/web/server');
const { WiiProtocol } = require('../src/client/protocol');

async function fixture(work) {
    const config = new Config('/unused-test-config');
    config.save = () => {};
    const registry = new SourceRegistry(config);
    const pipeline = new Pipeline();
    const web = new WebServer({ config, registry, pipeline });
    const address = await web.listen(0, '127.0.0.1');
    const url = `http://127.0.0.1:${address.port}`;
    try { await work({ config, registry, pipeline, web, url }); }
    finally { web.close(); await pipeline.shutdown(); await registry.disconnectAll(); }
}

test('saved stations and yt-dlp links persist and appear in Wii browsing', async () => fixture(async ({ url, registry, config }) => {
    for (const source of ['radio', 'ytdlp']) {
        const endpoint = `${url}/api/sources/${source}/favorites`;
        let response = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ url: 'https://example.com/music', name: 'Song\t♪' }) });
        assert.equal(response.status, 200);
        const saved = (await response.json()).items[0];
        assert.equal(saved.name, 'Song\t♪');
        const list = await registry.get(source).browse();
        assert.equal(list.items[0].title, 'Song\t♪');
        assert.equal(config.sourceConfig(source)[source === 'radio' ? 'stations' : 'links'].length, 1);
        response = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ url: 'file:///etc/passwd' }) });
        assert.equal(response.status, 400);
        response = await fetch(endpoint, { method: 'DELETE', body: JSON.stringify({ id: saved.id }) });
        assert.equal((await response.json()).items.length, 0);
    }
}));

test('Wii protocol rejects expired/wrong-source refs and paginates saved radio', async () => fixture(async ({ url, config, web }) => {
    config.sourceConfig('radio').stations = Array.from({ length: 25 }, (_, i) => ({ name: `Station ${i}`, url: `https://example.com/${i}` }));
    const response = await fetch(`${url}/api/wii/browse?source=radio&offset=12`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /page\t12\t25/);
    assert.match(body, /Station%2012/);
    assert.equal(body.split('\n').filter((line) => line.startsWith('item\t')).length, 12);
    const ref = body.split('\n')[2].split('\t')[1];
    let rejected = await fetch(`${url}/api/wii/play?source=plex&ref=${ref}`, { method: 'POST' });
    assert.equal(rejected.status, 400);
    web.wii.items.get(ref).expires = 0;
    rejected = await fetch(`${url}/api/wii/play?source=radio&ref=${ref}`, { method: 'POST' });
    assert.equal(rejected.status, 400);
    assert.match(await rejected.text(), /expired/);
    assert.equal((await fetch(`${url}/api/wii/browse?source=radio&offset=-1`)).status, 400);
}));

test('Wii long-running selections acknowledge promptly and report failures through status', async () => {
    const config = new Config('/unused-test-config'); config.save = () => {};
    let reject;
    const protocol = new WiiProtocol({ config, registry: {}, pipeline: {} });
    protocol._command(new Promise((_, no) => { reject = no; }));
    assert.equal(protocol.commandStatus, 'Working...');
    reject(new Error('provider unavailable'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(protocol.commandStatus, 'provider unavailable');
});

test('wire output escapes delimiters, repairs lone surrogates and strips NUL', () => {
    const config = new Config('/unused-test-config'); config.save = () => {};
    const protocol = new WiiProtocol({ config });
    let result;
    protocol._send({ writeHead() {}, end(body) { result = body; } }, 200, [['item', 'a\tb\nc\0\ud800']]);
    assert.match(result, /a%09b%0Ac%EF%BF%BD/);
});

test('Wii tracks retain their full album context across pages; the album ref starts at the beginning', async () => fixture(async ({ url, registry, pipeline }) => {
    const album = { id: 'album/fixture', type: 'album', title: 'Fixture album' };
    const songs = Array.from({ length: 25 }, (_, i) => ({ id: `song-${i}`, type: 'track', title: `Track ${i}` }));
    const source = { browse: async ({ path, offset, limit }) => path
        ? { items: songs.slice(offset, offset + limit), total: songs.length }
        : { items: [album], total: 1 } };
    registry.connect = async () => source;
    const selections = [];
    pipeline.attach = async (_, item) => { selections.push(item); };
    pipeline.waitForAudio = async () => {};
    const browse = async (query) => (await (await fetch(`${url}/api/wii/browse?source=subsonic${query}`)).text())
        .trim().split('\n').slice(2).map((line) => line.split('\t').map(decodeURIComponent));
    const albumRef = (await browse(''))[0][1];
    const tracks = await browse(`&ref=${albumRef}&offset=12`);
    const select = async (ref) => {
        assert.equal((await fetch(`${url}/api/wii/play?source=subsonic&ref=${ref}`, { method: 'POST' })).status, 200);
        await new Promise(resolve => setImmediate(resolve));
    };
    await select(tracks[2][1]);
    assert.deepEqual(selections[0], { ...album, startId: 'song-14', startIndex: 14 });
    await select(albumRef);
    assert.deepEqual(selections[1], album);
    pipeline._nowPlaying.duration = 120;
    pipeline.pacer._write = () => {};
    pipeline.pacer.push(Buffer.alloc(176400));
    pipeline.pacer._drain(176400);
    const status = await (await fetch(`${url}/api/wii/status`)).text();
    assert.match(status, /progress\t1000\t120000/);
}));
