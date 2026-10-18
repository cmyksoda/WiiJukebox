// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalSource } = require('../src/sources/local');
const { SourceRegistry } = require('../src/sources/index');
const { Config } = require('../src/config');
const { ArtProxy } = require('../src/web/art');
const { Artwork } = require('../src/client/artwork');
const { makeAudioFixture, makePng, skipReason } = require('./helpers/audio-fixtures');

function tempDir(t, prefix = 'wiijukebox-local-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('chosen folders are checked, made real, and kept once each', (t) => {
    const music = tempDir(t);
    fs.mkdirSync(path.join(music, 'Inside'));
    fs.writeFileSync(path.join(music, 'song.mp3'), '');
    assert.deepEqual(LocalSource.cleanFolders([` ${music} `, music, path.join(music, 'Inside'), '']), [fs.realpathSync(music)]);
    assert.throws(() => LocalSource.cleanFolders(['Music']), /not a full folder path/);
    assert.throws(() => LocalSource.cleanFolders([path.join(music, 'nope')]), /not a folder on this computer/);
    assert.throws(() => LocalSource.cleanFolders([path.join(music, 'song.mp3')]), /not a folder on this computer/);
    assert.throws(() => LocalSource.cleanFolders('not a list'), /list of folder paths/);
});

test('Local files needs a folder before it is offered, and refuses one that is not there', async (t) => {
    const music = tempDir(t);
    const registry = new SourceRegistry(new Config(tempDir(t, 'wiijukebox-config-')));
    const local = () => registry.describe().find((s) => s.id === 'local');
    assert.equal(local().label, 'Local files');
    assert.equal(local().configured, false);
    await assert.rejects(registry.configure('local', { folders: [path.join(music, 'missing')] }), /not a folder/);
    await registry.configure('local', { folders: [music] });
    assert.equal(local().configured, true);
    assert.deepEqual(registry.config.sourceConfig('local').folders, [fs.realpathSync(music)]);
});

test('a folder of music browses by tags and by folders, plays in order and has covers', async (t) => {
    const skip = skipReason('mp3') || skipReason('flac');
    if (skip) return t.skip(skip);
    const music = tempDir(t);
    const configDir = tempDir(t, 'wiijukebox-config-');
    const record = path.join(music, 'Band', 'Record');
    fs.mkdirSync(record, { recursive: true });
    fs.mkdirSync(path.join(music, 'Loose'));
    makeAudioFixture(record, '01 Opening.mp3', { cover: makePng({ width: 64, height: 64 }), id3v2Version: 3,
        tags: { title: 'Opening', artist: 'Band', album: 'Record', track: '1/2', date: '2020-04-01' } });
    makeAudioFixture(record, '02 Closing.flac', { tags: { title: 'Closing', artist: 'Band', album: 'Record', track: '2/2' } });
    const dashed = makeAudioFixture(path.join(music, 'Loose'), '-take one.mp3', { seconds: 1 });

    const source = new LocalSource({ folders: [music] }, { configDir });
    t.after(() => source.disconnect());
    await source.connect();
    await source.library.scan();

    assert.deepEqual((await source.browse()).items.map((i) => i.id), ['artists', 'albums', 'songs', 'folders']);
    const albums = (await source.browse({ path: 'albums' })).items;
    assert.deepEqual(albums.map((a) => [a.title, a.subtitle]), [['Loose', 'Unknown artist'], ['Record', 'Band · 2020']]);
    const album = albums[1];
    assert.match(album.artwork, /^local-art:album\//);
    const tracks = (await source.browse({ path: album.id })).items;
    assert.deepEqual(tracks.map((s) => s.title), ['Opening', 'Closing']);
    assert.ok(Math.abs(tracks[1].duration - 2) < 0.2);

    const handle = await source.open({ ...album, startId: tracks[1].id, startIndex: 1 });
    assert.equal(handle.uri, `file:${path.join(record, '02 Closing.flac')}`);
    assert.equal(handle.seekable, true);
    assert.equal(source.queue.index, 1);
    assert.match((await source.previous()).uri, /01 Opening\.mp3$/);
    await source.open({ id: 'songs', type: 'playlist' });
    assert.equal(source.queue.items.length, 3, 'Songs plays everything');

    const folders = (await source.browse({ path: 'folders' })).items;
    assert.deepEqual(folders.map((f) => [f.title, f.type]), [['Band', 'folder'], ['Loose', 'album']]);
    const inside = (await source.browse({ path: folders[0].id })).items;
    assert.deepEqual(inside.map((f) => [f.title, f.type, f.subtitle]), [['Record', 'album', '2 songs']]);
    const loose = (await source.browse({ path: folders[1].id })).items;
    assert.equal(loose[0].title, '-take one', 'an untagged song is named after its file');
    assert.equal((await source.open(loose[0])).uri, `file:${dashed}`);

    const art = await source.art(album.artwork);
    assert.equal(art.mime, 'image/jpeg');
    assert.deepEqual([...art.data.subarray(0, 2)], [0xff, 0xd8]);
    assert.equal(fs.readdirSync(path.join(configDir, 'local-art')).length, 1, 'shrunk covers are kept for next time');
    assert.equal(await source.art(loose[0].artwork), null);

    assert.deepEqual((await source.search('closing')).items.map((i) => i.title), ['Closing']);
    assert.equal((await source.homeRow('newest', { limit: 5 })).length, 2);
    assert.deepEqual([source.info().songs, source.info().albums, source.info().artists], [3, 2, 2]);
    assert.deepEqual((await source.action('folders', { path: music })).folders.map((f) => f.name), ['Band', 'Loose']);

    fs.rmSync(dashed);
    await assert.rejects(source.open(loose[0]), /isn't in your music folders any more/);
});

test('Local files covers reach the web page and the Wii without a web address', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const localArt = async (url) => (url === 'local-art:album/abc' ? { data: jpeg, mime: 'image/jpeg' } : null);
    const proxy = new ArtProxy({ localArt });
    const link = proxy.link('local-art:album/abc');
    assert.match(link, /^\/api\/art\/[0-9a-f]+$/);
    const sent = {};
    const res = { writeHead: (code, headers) => Object.assign(sent, { code, headers }), end: (body) => { sent.body = body; } };
    await proxy.serve(link.split('/').pop(), res);
    assert.equal(sent.code, 200);
    assert.equal(sent.headers['Content-Type'], 'image/jpeg');
    assert.deepEqual(sent.body, jpeg);
    await proxy.serve(proxy.link('local-art:album/gone').split('/').pop(), res);
    assert.equal(sent.code, 404);
    assert.equal(new ArtProxy().link('local-art:album/abc'), null, 'only a server with Local files takes these links');

    assert.deepEqual(await new Artwork({ localArt })._image('local-art:album/abc'), jpeg);
    await assert.rejects(new Artwork()._image('local-art:album/abc'), /artwork unavailable/);
});
