// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { RadioSource, resolveStream } = require('../src/sources/radio');

async function stationServer(t, routes) {
    const hits = [];
    const server = http.createServer((req, res) => {
        hits.push(req.url);
        const route = routes[req.url];
        if (!route) return res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': route.type });
        if (route.endless) return res.write(Buffer.alloc(4096, 0xff));
        res.end(route.body.replaceAll('BASE', base));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    return { base, hits };
}

const PLS = '[playlist]\nnumberofentries=2\nFile1=BASE/groovesalad-256-mp3\nTitle1=Groove Salad\nLength1=-1\n'
    + 'File2=BASE/mirror-256-mp3\nVersion=2\n';

test('a .pls plays the first stream it names', async (t) => {
    const { base } = await stationServer(t, { '/groovesalad256.pls': { type: 'audio/x-scpls', body: PLS } });
    assert.equal(await resolveStream(`${base}/groovesalad256.pls`, fetch), `${base}/groovesalad-256-mp3`);
});

test('an .m3u skips its comments and follows a nested .pls to the stream', async (t) => {
    const { base } = await stationServer(t, {
        '/station.m3u': { type: 'audio/x-mpegurl', body: '#EXTM3U\n#EXTINF:-1,Groove Salad\r\nBASE/inner.pls\r\n' },
        '/inner.pls': { type: 'audio/x-scpls', body: PLS },
    });
    assert.equal(await resolveStream(`${base}/station.m3u`, fetch), `${base}/groovesalad-256-mp3`);
});

test('a direct stream, an HLS playlist and a stream named like a list all go to ffmpeg unchanged', async (t) => {
    const { base, hits } = await stationServer(t, {
        '/live.m3u8': { type: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-VERSION:3\nchunk-1.ts\n' },
        '/listen.m3u': { type: 'audio/mpeg', endless: true },
    });
    assert.equal(await resolveStream(`${base}/groovesalad-256-mp3`, fetch), `${base}/groovesalad-256-mp3`);
    assert.deepEqual(hits, [], 'a plain stream is not fetched first');
    assert.equal(await resolveStream(`${base}/live.m3u8`, fetch), `${base}/live.m3u8`);
    assert.equal(await resolveStream(`${base}/listen.m3u`, fetch), `${base}/listen.m3u`);
});

test('a playlist that is missing or names no stream fails with a plain reason', async (t) => {
    const { base } = await stationServer(t, { '/empty.pls': { type: 'audio/x-scpls', body: '[playlist]\nnumberofentries=0\n' } });
    await assert.rejects(resolveStream(`${base}/gone.pls`, fetch), /couldn't read the station's playlist \(HTTP 404\)/);
    await assert.rejects(resolveStream(`${base}/empty.pls`, fetch), /names no stream/);
});

test('playing a .pls station hands ffmpeg the stream inside it', async (t) => {
    const { base } = await stationServer(t, { '/groovesalad256.pls': { type: 'audio/x-scpls', body: PLS } });
    const radio = new RadioSource({}, {});
    t.after(() => radio.close());
    const handle = await radio.open({ url: `${base}/groovesalad256.pls`, title: 'Groove Salad' });
    assert.deepEqual(handle, { type: 'uri', uri: `${base}/groovesalad-256-mp3` });
});
