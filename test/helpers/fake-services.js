// SPDX-License-Identifier: GPL-3.0-only
// Small stand-ins for Navidrome, Jellyfin, Plex and a podcast host, so the home screen
// can be tested and photographed without touching any real service.
const crypto = require('node:crypto');
const http = require('node:http');
const zlib = require('node:zlib');

// --- generated media ----------------------------------------------------------

const CRC = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) crc = CRC[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
    return out;
}

function hsl(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min((n + h / 30) % 12 - 3, 9 - (n + h / 30) % 12, 1));
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

/** A flat square cover: one hue, a lighter disc and a darker bar, different for each seed. */
function coverPng(seed, size = 160) {
    const hue = crypto.createHash('sha1').update(String(seed)).digest()[0] * 360 / 256;
    const [bg, disc, bar] = [hsl(hue, 0.45, 0.42), hsl(hue, 0.5, 0.7), hsl(hue, 0.5, 0.25)];
    const rows = Buffer.alloc((size * 3 + 1) * size);
    for (let y = 0; y < size; y++) {
        rows[y * (size * 3 + 1)] = 0;
        for (let x = 0; x < size; x++) {
            const inDisc = (x - size * 0.5) ** 2 + (y - size * 0.45) ** 2 < (size * 0.27) ** 2;
            const color = inDisc ? disc : y > size * 0.82 ? bar : bg;
            color.forEach((v, i) => { rows[y * (size * 3 + 1) + 1 + x * 3 + i] = v; });
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header.set([8, 2, 0, 0, 0], 8);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** A quiet 16-bit stereo sine, long enough that nothing ends while a test looks at it. */
function tone(seconds = 30, rate = 8000) {
    const frames = seconds * rate;
    const data = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) {
        const v = Math.round(Math.sin(2 * Math.PI * 330 * i / rate) * 2000);
        data.writeInt16LE(v, i * 4);
        data.writeInt16LE(v, i * 4 + 2);
    }
    const head = Buffer.alloc(44);
    head.write('RIFF', 0);
    head.writeUInt32LE(36 + data.length, 4);
    head.write('WAVEfmt ', 8);
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(2, 22);
    head.writeUInt32LE(rate, 24);
    head.writeUInt32LE(rate * 4, 28);
    head.writeUInt16LE(4, 32);
    head.writeUInt16LE(16, 34);
    head.write('data', 36);
    head.writeUInt32LE(data.length, 40);
    return Buffer.concat([head, data]);
}
const TONE = tone();

// --- server plumbing ----------------------------------------------------------

/** Starts `handler` on a free local port; `hits` records every request path for assertions. */
async function listen(handler) {
    const hits = [];
    const server = http.createServer((req, res) => {
        hits.push(req.url);
        Promise.resolve(handler(req, res, new URL(req.url, 'http://fake'))).catch((err) => {
            res.writeHead(500);
            res.end(err.message);
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        url: `http://127.0.0.1:${server.address().port}`, hits,
        close: () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); },
    };
}

const json = (res, body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
};
const image = (res, seed) => {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(coverPng(seed));
};
const audio = (res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': TONE.length });
    res.end(TONE);
};

// --- Navidrome ------------------------------------------------------------------

const ALBUMS = {
    newest: [['n1', 'Paper Lanterns', 'Mika Ito'], ['n2', 'Low Tide Radio', 'Harbor Lights'], ['n3', 'Second Spring', 'Alma Reyes'],
        ['n4', 'Night Bus', 'The Quiet Hours'], ['n5', 'Glass Garden', 'Oda'], ['n6', 'Slow Orbit', 'Pinewood']],
    frequent: [['f1', 'Late Checkout', 'Marlowe'], ['f2', 'Cassette Summer', 'Dune Club'], ['f3', 'Small Hours', 'Nell Archer'],
        ['f4', 'Moth Songs', 'Fenwick']],
    recent: [['r1', 'Blue Hour', 'Kestrel'], ['r2', 'Paper Lanterns', 'Mika Ito'], ['r3', 'Overland', 'Teo Marsh']],
};

const albumName = (id) => Object.values(ALBUMS).flat().find(([albumId]) => albumId === id)?.[1] || id;

/** `fail` makes every music call answer 500, like a server that is up but unwell. */
async function fakeSubsonic({ password = 'secret', fail = false } = {}) {
    const state = { fail };
    const server = await listen((req, res, url) => {
        const q = url.searchParams;
        const endpoint = url.pathname.split('/').pop();
        const token = crypto.createHash('md5').update(password + q.get('s')).digest('hex');
        if (q.get('t') !== token) {
            return json(res, { 'subsonic-response': { status: 'failed', error: { code: 40, message: 'Wrong credentials' } } });
        }
        if (endpoint === 'getCoverArt.view') return image(res, q.get('id'));
        if (endpoint === 'stream.view') return audio(res);
        if (state.fail && endpoint !== 'ping.view') { res.writeHead(500); return res.end('down'); }
        const reply = { status: 'ok', version: '1.16.1' };
        if (endpoint === 'getAlbumList2.view') {
            reply.albumList2 = { album: (ALBUMS[q.get('type')] || []).slice(0, Number(q.get('size') || 10))
                .map(([id, name, artist]) => ({ id, name, artist, coverArt: id })) };
        }
        const songs = (id) => ['One', 'Two', 'Three', 'Four'].map((title, i) => ({
            id: `${id}-t${i + 1}`, title, artist: 'Fixture', album: albumName(id), duration: 200, coverArt: id }));
        if (endpoint === 'getAlbum.view') reply.album = { song: songs(q.get('id')) };
        if (endpoint === 'getArtists.view') {
            reply.artists = { index: [{ artist: [{ id: 'a1', name: 'Mika Ito', albumCount: 2, coverArt: 'a1' }] }] };
        }
        if (endpoint === 'getPlaylists.view') reply.playlists = { playlist: [{ id: 'p1', name: 'Rainy Day', songCount: 4, coverArt: 'p1' }] };
        if (endpoint === 'getPlaylist.view') reply.playlist = { entry: songs('p1') };
        if (endpoint === 'getStarred2.view') reply.starred2 = { song: songs('n2').slice(0, 2) };
        if (endpoint === 'search3.view') {
            reply.searchResult3 = { artist: [{ id: 'a1', name: 'Mika Ito' }],
                album: ALBUMS.newest.slice(0, 2).map(([id, name, artist]) => ({ id, name, artist, coverArt: id })), song: songs('n1').slice(0, 2) };
        }
        json(res, { 'subsonic-response': reply });
    });
    return { ...server, state, config: { url: server.url, username: 'fixture', password } };
}

// --- Jellyfin -------------------------------------------------------------------

async function fakeJellyfin() {
    const albums = [['j1', 'Harbor Letters', 'Wren'], ['j2', 'Salt and Cedar', 'Hollis Park'], ['j3', 'Afterglow Tape', 'Nia Okoro']];
    const server = await listen((req, res, url) => {
        if (url.pathname === '/Users/AuthenticateByName') return json(res, { AccessToken: 'jf-token', User: { Id: 'u1' } });
        if (url.pathname === '/System/Info') return json(res, { Version: '10' });
        const art = /^\/Items\/([^/]+)\/Images\/Primary$/.exec(url.pathname);
        if (art) return image(res, art[1]);
        const stream = /^\/Audio\/([^/]+)\/stream$/.exec(url.pathname);
        if (stream) return audio(res);
        if (url.pathname === '/Items' && url.searchParams.get('ParentId')) {
            const parent = url.searchParams.get('ParentId');
            return json(res, { TotalRecordCount: 3, Items: ['One', 'Two', 'Three'].map((Name, i) => ({
                Id: `${parent}-t${i + 1}`, Name, Type: 'Audio', Artists: ['Fixture'], Album: parent,
                RunTimeTicks: 2000000000, AlbumId: parent, AlbumPrimaryImageTag: 'tag' })) });
        }
        if (url.pathname === '/Artists') {
            return json(res, { TotalRecordCount: 1, Items: [{ Id: 'ja1', Name: 'Wren', ImageTags: { Primary: 'tag' } }] });
        }
        if (url.pathname === '/Items') {
            const items = albums.map(([Id, Name, AlbumArtist]) => ({
                Id, Name, AlbumArtist, Type: 'MusicAlbum', ImageTags: { Primary: 'tag' } }));
            if (url.searchParams.get('SearchTerm')) {
                items.push({ Id: 'j1-t1', Name: 'One', Type: 'Audio', Artists: ['Fixture'], Album: 'Harbor Letters',
                    RunTimeTicks: 2000000000, AlbumId: 'j1', AlbumPrimaryImageTag: 'tag' });
            }
            return json(res, { TotalRecordCount: items.length, Items: items });
        }
        res.writeHead(404);
        res.end();
    });
    return { ...server, config: { url: server.url, username: 'fixture', password: 'pw' } };
}

// --- Plex -----------------------------------------------------------------------

async function fakePlex({ token = 'plex-secret' } = {}) {
    const albums = [['101', 'Tidewater', 'Ivy Bell'], ['102', 'Lamplight Sessions', 'The Corner Shop'], ['103', 'Soft Static', 'Rue']];
    const server = await listen((req, res, url) => {
        const given = req.headers['x-plex-token'] || url.searchParams.get('X-Plex-Token');
        if (given !== token) { res.writeHead(401); return res.end(); }
        const thumb = /^\/library\/metadata\/(\d+)\/thumb$/.exec(url.pathname);
        if (thumb) return image(res, thumb[1]);
        let data = {};
        if (url.pathname === '/library/sections') data = { Directory: [{ key: '1', type: 'artist', title: 'Music' }] };
        if (url.pathname === '/library/sections/1/recentlyAdded') {
            data = { Metadata: albums.map(([ratingKey, title, parentTitle], i) => ({ ratingKey, type: 'album', title,
                parentTitle, addedAt: 1000 - i, thumb: `/library/metadata/${ratingKey}/thumb` })) };
        }
        if (url.pathname === '/library/onDeck') {
            data = { Metadata: [
                { ratingKey: '9', type: 'movie', title: 'Not music' },
                { ratingKey: '201', type: 'track', title: 'Porch Light', grandparentTitle: 'Ivy Bell', parentTitle: 'Tidewater',
                    thumb: '/library/metadata/101/thumb' },
            ] };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ MediaContainer: data }));
    });
    return { ...server, config: { url: server.url, token } };
}

// --- podcasts -------------------------------------------------------------------

function feedXml(base, title, episodes) {
    const items = episodes.map(([name, date], i) => `<item><title>${name}</title><guid>${title}-${i}</guid>
        <pubDate>${date}</pubDate><itunes:duration>31:05</itunes:duration>
        <enclosure url="${base}/episode.wav" type="audio/wav"/></item>`).join('');
    return `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
        <title>${title}</title><itunes:author>${title} Team</itunes:author><itunes:image href="${base}/show/${title}.png"/>${items}</channel></rss>`;
}

/** Two shows; /feed/broken answers 500, so a subscription can fail while the rest load. */
async function fakePodcasts() {
    const server = await listen((req, res, url) => {
        const base = `http://${req.headers.host}`;
        if (url.pathname === '/feed/morning') {
            res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
            return res.end(feedXml(base, 'Morning Pages', [['Walking the dog in the rain', 'Wed, 07 Oct 2026 07:00:00 GMT'],
                ['A short one about tea', 'Mon, 05 Oct 2026 07:00:00 GMT']]));
        }
        if (url.pathname === '/feed/maker') {
            res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
            return res.end(feedXml(base, 'Maker Hour', [['Soldering without tears', 'Tue, 06 Oct 2026 12:00:00 GMT']]));
        }
        if (url.pathname.startsWith('/show/')) return image(res, url.pathname);
        if (url.pathname === '/episode.wav') return audio(res);
        res.writeHead(500);
        res.end('broken feed');
    });
    const feeds = { morning: `${server.url}/feed/morning`, maker: `${server.url}/feed/maker`, broken: `${server.url}/feed/broken` };
    return { ...server, feeds };
}

module.exports = { coverPng, tone, listen, fakeSubsonic, fakeJellyfin, fakePlex, fakePodcasts };
