// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { YtMusicSource, parseSearch } = require('../src/sources/ytmusic');
const { tempDir, fakeBinary } = require('./helpers/fake-binary');

const runs = (...groups) => groups.flatMap((group, i) => (i ? [{ text: ' • ' }, ...group] : group)).map((r) => (typeof r === 'string' ? { text: r } : r));
const row = (title, subtitle, extra = {}) => ({ musicResponsiveListItemRenderer: {
    flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: subtitle } } },
    ],
    thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [
        { url: 'https://yt3.googleusercontent.com/abc=w60-h60-l90-rj', width: 60 },
        { url: 'https://yt3.googleusercontent.com/abc=w120-h120-l90-rj', width: 120 }] } } },
    ...extra,
} });
const shelf = (...rows) => ({ contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: {
    sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: rows } }] } } } }] } } });

const FIXTURES = {
    songs: shelf(
        row('Voyager', runs(['Daft Punk'], ['Discovery'], ['3:50']), { playlistItemData: { videoId: 'OWiVJMgms9E' } }),
        row('No id', runs(['Someone'], ['Album'], ['1:00']))),
    albums: shelf(row('Discovery', runs(['Album'], ['Daft Punk'], ['2001']), {
        navigationEndpoint: { browseEndpoint: { browseId: 'MPREb_7ltM34kr0mH' } } })),
    playlists: shelf(row('Daft Punk - Discovery', runs(['SlowMusic'], ['34K views']), {
        navigationEndpoint: { browseEndpoint: { browseId: 'VLPLImcLkJqSBKgkIndmyBXVGM9pDKsW88-2' } } })),
    artists: shelf(row('Daft Punk', runs(['Artist'], ['81M monthly audience']), {
        navigationEndpoint: { browseEndpoint: { browseId: 'UCRr1xG_2WIDs18a6cIiCxeA' } } })),
};

const FILTER_NAMES = { EgWKAQIIAWoMEA4QChADEAQQCRAF: 'songs', EgWKAQIYAWoMEA4QChADEAQQCRAF: 'albums',
    'Eg-KAQwIABAAGAAgACgBMABqChAEEAMQCRAFEAo=': 'playlists', EgWKAQIgAWoMEA4QChADEAQQCRAF: 'artists' };

const fakeFetch = (log, { fail = false } = {}) => async (url, init) => {
    log.push({ url: String(url), body: JSON.parse(init.body) });
    if (fail) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => FIXTURES[FILTER_NAMES[JSON.parse(init.body).params]] };
};

// Answers the few yt-dlp invocations the source makes.
const FAKE_YTDLP = (dir) => `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.log'))}, JSON.stringify(args) + '\\n');
if (args.includes('--version')) { console.log('2026.01.01'); process.exit(0); }
const url = args.at(-1);
const entry = (id, title) => ({ _type: 'url', ie_key: 'Youtube', id, title, url: 'https://music.youtube.com/watch?v=' + id, channel: 'Daft Punk', duration: 200 });
if (url.includes('/browse/MPREb_')) {
    console.log(JSON.stringify({ _type: 'playlist', title: 'Album - Discovery', id: 'OLAK5uy_x', playlist_count: 3,
        thumbnails: [{ url: 'https://i9.ytimg.com/s_p/x/maxresdefault.jpg', width: 1200 }],
        entries: [entry('aaaaaaaaaaa', 'One More Time'), entry('bbbbbbbbbbb', 'Aerodynamic'), entry('ccccccccccc', 'Digital Love')] }));
} else {
    const id = /v=([\\w-]{11})/.exec(url)[1];
    console.log(JSON.stringify({ id, title: 'Raw Title', track: 'One More Time', artist: 'Daft Punk', album: 'Discovery',
        duration: 320, thumbnail: 'https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg', url: 'https://example.invalid/audio-' + id }));
}
`;

test('search groups songs, albums, playlists and artists with covers and durations', async () => {
    const log = [];
    const source = new YtMusicSource({}, { fetch: fakeFetch(log) });
    const { items } = await source.search('daft punk');
    assert.equal(log.length, 4);
    assert.ok(log.every((call) => call.body.context.client.clientName === 'WEB_REMIX'));
    assert.deepEqual(items.map((i) => [i.group, i.type, i.title]), [
        ['Songs', 'track', 'Voyager'], ['Albums', 'album', 'Discovery'],
        ['Playlists', 'playlist', 'Daft Punk - Discovery'], ['Artists', 'artist', 'Daft Punk'],
    ]);
    const [song, album, playlist, artist] = items;
    assert.equal(song.id, 'https://music.youtube.com/watch?v=OWiVJMgms9E');
    assert.equal(song.artist, 'Daft Punk');
    assert.equal(song.album, 'Discovery');
    assert.equal(song.duration, 230);
    assert.equal(song.artwork, 'https://yt3.googleusercontent.com/abc=w400-h400-l90-rj');
    assert.equal(album.id, 'list/https://music.youtube.com/browse/MPREb_7ltM34kr0mH');
    assert.equal(album.subtitle, 'Daft Punk · 2001');
    assert.equal(playlist.id, 'list/https://music.youtube.com/playlist?list=PLImcLkJqSBKgkIndmyBXVGM9pDKsW88-2');
    assert.equal(artist.id, 'albums/Daft Punk');
});

test('a broken search endpoint falls back to yt-dlp titles', async () => {
    const dir = tempDir();
    const bin = fakeBinary(dir, 'yt-dlp', `
const args = process.argv.slice(2);
if (args.includes('--dump-json')) {
    console.log(JSON.stringify({ title: 'Fallback Song', url: 'https://music.youtube.com/watch?v=zzzzzzzzzzz' }));
    process.exit(0);
}
process.exit(1);`);
    const source = new YtMusicSource({ binary: bin }, { fetch: fakeFetch([], { fail: true }) });
    const { items } = await source.search('anything');
    assert.deepEqual(items.map((i) => i.title), ['Fallback Song']);
});

test('albums queue from the chosen track with the album cover on now-playing', async () => {
    const dir = tempDir();
    const bin = fakeBinary(dir, 'yt-dlp', FAKE_YTDLP(dir));
    const source = new YtMusicSource({ binary: bin }, { fetch: fakeFetch([]) });
    const metadata = [];
    source.on('metadata', (meta) => metadata.push(meta));
    await source.connect();

    const page = await source.browse({ path: 'list/https://music.youtube.com/browse/MPREb_x' });
    assert.equal(page.total, 3);
    assert.ok(page.items.every((i) => i.artwork === 'https://i9.ytimg.com/s_p/x/maxresdefault.jpg' && i.album === 'Discovery'));

    const handle = await source.open({ id: 'list/https://music.youtube.com/browse/MPREb_x', type: 'album',
        startId: 'https://music.youtube.com/watch?v=bbbbbbbbbbb', startIndex: 1 });
    assert.equal(source.queue.index, 1);
    assert.equal(handle.uri, 'https://example.invalid/audio-bbbbbbbbbbb');
    assert.equal(metadata.at(-1).title, 'One More Time');
    assert.equal(metadata.at(-1).artist, 'Daft Punk');
    assert.equal(metadata.at(-1).artwork, 'https://i9.ytimg.com/s_p/x/maxresdefault.jpg');
    assert.equal(source.capabilities.next, true);
    assert.equal((await source.next()).uri, 'https://example.invalid/audio-ccccccccccc');
    await assert.rejects(source.open({ id: 'list/https://music.youtube.com/browse/MPREb_x', type: 'album',
        startId: 'https://music.youtube.com/watch?v=missing0000' }), /no longer/);
});

test('search results remember their cover for playback; root lists saved links, Liked Music needs cookies', async () => {
    const dir = tempDir();
    const bin = fakeBinary(dir, 'yt-dlp', FAKE_YTDLP(dir));
    const links = [{ id: '1', name: 'Album link', url: 'https://music.youtube.com/browse/MPREb_x' },
        { id: '2', name: 'Single', url: 'https://music.youtube.com/watch?v=aaaaaaaaaaa' }];
    const source = new YtMusicSource({ binary: bin, links }, { fetch: fakeFetch([]) });
    const metadata = [];
    source.on('metadata', (meta) => metadata.push(meta));
    const { items } = await source.search('daft punk');
    await source.open(items[0]);
    assert.equal(metadata.at(-1).artwork, 'https://yt3.googleusercontent.com/abc=w400-h400-l90-rj');

    const root = await source.browse();
    assert.deepEqual(root.items.map((i) => [i.title, i.type]), [['Album link', 'playlist'], ['Single', 'track']]);
    const withCookies = new YtMusicSource({ binary: bin, links, extraArgs: ['--cookies-from-browser', 'firefox'] }, {});
    assert.equal((await withCookies.browse()).items[0].title, 'Liked Music');
});

test('parseSearch skips rows it cannot turn into playable items', () => {
    assert.deepEqual(parseSearch('songs', {}, 5), []);
    assert.deepEqual(parseSearch('songs', FIXTURES.songs, 5).map((i) => i.title), ['Voyager']);
});
