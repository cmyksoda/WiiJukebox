// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalLibrary } = require('../src/sources/local-library');

// Files whose tags come from this table instead of a real tag reader.
const TAGS = {
    'Artist A/Album One/01 Intro.mp3': { title: 'Intro', artist: 'Artist A', album: 'Album One', track: 1, year: 2019, hasPicture: true },
    'Artist A/Album One/02 Café.mp3': { title: 'Café', artist: 'Artist A', album: 'Album One', track: 2, year: 2019 },
    'Artist A/Album Two/CD2/01.flac': { title: 'Second disc', artist: 'Artist A', album: 'Album Two', track: 1, disc: 2 },
    'Artist A/Album Two/CD1/01.flac': { title: 'First disc', artist: 'Artist A', album: 'Album Two', track: 1, disc: 1 },
    'Mix/a.ogg': { title: 'One', artist: 'X', album: 'Mix' },
    'Mix/b.ogg': { title: 'Two', artist: 'Y', album: 'Mix' },
    'loose.mp3': {},
};

function makeTree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiijukebox-local-'));
    for (const rel of [...Object.keys(TAGS), '.hidden/secret.mp3', 'notes.txt', 'Artist A/Album One/cover.jpg', 'Artist A/Album One/back.jpg']) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), rel);
    }
    fs.writeFileSync(path.join(root, 'Best of.m3u'), [
        '#EXTM3U', '#EXTINF:1,Café', 'Artist A/Album One/02 Café.mp3', '../outside.mp3', 'http://radio.invalid/live', 'missing.mp3', '',
    ].join('\n'));
    return root;
}

function fakeReader() {
    const reads = [];
    const read = async (file) => {
        reads.push(file);
        const rel = Object.keys(TAGS).find((key) => file.endsWith(key.split('/').join(path.sep)));
        return rel ? TAGS[rel] : null;
    };
    return { reads, read };
}

const names = (library, list, map, field) => library.view[list].map((id) => library.view[map].get(id)[field]);

test('a scan groups tags into artists, albums, folders and playlists', async (t) => {
    const root = makeTree();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { read } = fakeReader();
    const library = new LocalLibrary({ folders: [root], readTags: read });
    await library.scan();
    const v = library.view;

    assert.deepEqual(names(library, 'artistList', 'artists', 'name'), ['Artist A', 'Unknown artist', 'Various Artists']);
    assert.deepEqual(names(library, 'albumList', 'albums', 'title'), ['Album One', 'Album Two', 'Mix', path.basename(root)]);
    const albumOf = (title) => [...v.albums.values()].find((album) => album.title === title);
    assert.deepEqual(albumOf('Album Two').tracks.map((id) => v.tracks.get(id).title), ['First disc', 'Second disc'],
        'CD1 and CD2 folders make one album, in disc order');
    assert.equal(albumOf('Mix').artist, 'Various Artists');
    assert.equal(albumOf('Album One').cover, path.join(root, 'Artist A', 'Album One', 'cover.jpg'));
    assert.equal(albumOf('Album One').year, 2019);
    assert.ok(albumOf('Album One').pictureTrack);
    assert.equal(v.tracks.get(albumOf(path.basename(root)).tracks[0]).title, 'loose', 'untagged songs are named after their file');

    const top = v.dirs.get(v.rootDirs[0]);
    assert.deepEqual(top.dirs.map((id) => v.dirs.get(id).name), ['Artist A', 'Mix']);
    assert.equal(top.tracks.length, 1);
    assert.ok(![...v.tracks.values()].some((track) => track.file.includes('.hidden')), 'hidden folders are skipped');

    assert.deepEqual(names(library, 'playlistList', 'playlists', 'name'), ['Best of']);
    const list = v.playlists.get(v.playlistList[0]);
    assert.deepEqual(list.tracks.map((id) => v.tracks.get(id).title), ['Café'], 'only songs inside the folders are kept');

    const found = library.search('cafe artist');
    assert.deepEqual(found.tracks.map((id) => v.tracks.get(id).title), ['Café'], 'search ignores accents and case');
});

test('a rescan only reads what changed, and a saved index is there before the next scan', async (t) => {
    const root = makeTree();
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiijukebox-local-cache-'));
    t.after(() => {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
    });
    const cacheFile = path.join(cacheDir, 'local-files.json');
    const { reads, read } = fakeReader();
    const library = new LocalLibrary({ folders: [root], readTags: read, cacheFile });
    await library.scan();
    const first = reads.length;
    assert.equal(first, Object.keys(TAGS).length);

    const changed = path.join(root, 'Mix', 'a.ogg');
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(changed, later, later);
    fs.rmSync(path.join(root, 'Mix', 'b.ogg'));
    await library.scan();
    assert.deepEqual(reads.slice(first), [changed]);
    assert.equal(library.view.songList.length, Object.keys(TAGS).length - 1);

    const again = new LocalLibrary({ folders: [root], readTags: read, cacheFile });
    again.load();
    assert.equal(again.view.songList.length, Object.keys(TAGS).length - 1, 'known before any scan');
    assert.equal(again.view.playlistList.length, 1);
});

test('a folder that went away keeps its songs for when it comes back, without showing them', async (t) => {
    const root = makeTree();
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiijukebox-local-cache-'));
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    const cacheFile = path.join(cacheDir, 'local-files.json');
    const { reads, read } = fakeReader();
    const library = new LocalLibrary({ folders: [root], readTags: read, cacheFile });
    await library.scan();
    const moved = `${root}-unplugged`;
    fs.renameSync(root, moved);
    t.after(() => fs.rmSync(moved, { recursive: true, force: true }));

    await library.scan();
    assert.deepEqual(library.missing, [root]);
    assert.equal(library.view.songList.length, 0);
    fs.renameSync(moved, root);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const before = reads.length;
    await library.scan();
    assert.equal(library.view.songList.length, Object.keys(TAGS).length);
    assert.equal(reads.length, before, 'nothing had to be read again');
});

test('a closed library stops before saving over a newer index', async (t) => {
    const root = makeTree();
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiijukebox-local-cache-'));
    t.after(() => {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
    });
    const cacheFile = path.join(cacheDir, 'local-files.json');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const library = new LocalLibrary({ folders: [root], cacheFile, readTags: async () => { await gate; return {}; } });
    const scan = library.scan();
    library.close();
    release();
    await scan;
    assert.equal(fs.existsSync(cacheFile), false);
});
