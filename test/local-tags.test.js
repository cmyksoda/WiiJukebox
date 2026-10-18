// SPDX-License-Identifier: GPL-3.0-only
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { readTags, readPicture, AUDIO_EXTENSIONS } = require('../src/sources/local-tags');
const { makeAudioFixture, makePng, pictureBlock, skipReason } = require('./helpers/audio-fixtures');
const { tempDir, fakeBinary } = require('./helpers/fake-binary');

const dir = tempDir('wiijukebox-tags-');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

// An encoder adds delay and padding: LAME turns 2 s of sine into a 2.04 s MP3, the rest are within a few ms.
const DURATION_TOLERANCE = 0.1;
const EMPTY = {
    title: null, artist: null, albumArtist: null, album: null, track: null, disc: null, year: null,
    genre: null, compilation: false, duration: null, hasPicture: false,
};
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0x00, 0x00, 0xff, 0xd9]);
const JPEG_BACK = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x01, 0x02, 0xff, 0xd9]);
const FRONT = { data: JPEG, mime: 'image/jpeg' };
const scriptable = { skip: process.platform === 'win32' && 'needs executable scripts' };
const needs = (format) => ({ skip: skipReason(format) });

const u16 = (n) => Buffer.from([n >> 8, n & 255]);
const u16le = (n) => u16(n).reverse();
const u32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u32le = (n) => u32(n).reverse();
const syncsafe = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);

function write(name, ...parts) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.concat(parts));
    return file;
}

async function fromDir(run) {
    const before = process.cwd();
    process.chdir(dir);
    try {
        return await run();
    } finally {
        process.chdir(before);
    }
}

function noise(length, seed = 1) {
    const out = Buffer.alloc(length);
    for (let i = 0; i < length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        out[i] = seed >>> 24;
    }
    return out;
}

async function countBytesRead(run) {
    const open = fsPromises.open;
    let total = 0;
    fsPromises.open = async (...args) => {
        const handle = await open.apply(fsPromises, args);
        const read = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
            const result = await read(...readArgs);
            total += result.bytesRead;
            return result;
        };
        return handle;
    };
    try {
        await run();
    } finally {
        fsPromises.open = open;
    }
    return total;
}

function assertDuration(actual, expected) {
    const message = `duration ${actual} should be about ${expected}`;
    assert.ok(actual !== null && Math.abs(actual - expected) <= DURATION_TOLERANCE, message);
}

// --- ID3 builders ------------------------------------------------------------

function encodeText(encoding, text) {
    if (encoding === 1) return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    if (encoding === 2) return Buffer.from(text, 'utf16le').swap16();
    return Buffer.from(text, encoding === 3 ? 'utf8' : 'latin1');
}

function textBody(encoding, ...values) {
    const terminator = Buffer.alloc(encoding === 1 || encoding === 2 ? 2 : 1);
    const parts = values.flatMap((value) => [encodeText(encoding, value), terminator]);
    return Buffer.concat([Buffer.from([encoding]), ...parts.slice(0, -1)]);
}

function id3Frame(version, id, body, flags = 0) {
    if (version === 2) return Buffer.concat([Buffer.from(id), u32(body.length).subarray(1), body]);
    const size = version === 4 ? syncsafe(body.length) : u32(body.length);
    return Buffer.concat([Buffer.from(id), size, u16(flags), body]);
}

const textFrame = (version, id, encoding, ...values) => id3Frame(version, id, textBody(encoding, ...values));

function apicFrame(version, image, type, mime = 'image/jpeg') {
    const head = version === 2
        ? Buffer.concat([Buffer.from([0]), Buffer.from('JPG'), Buffer.from([type, 0])])
        : Buffer.concat([Buffer.from([0]), Buffer.from(mime), Buffer.from([0, type, 0])]);
    return id3Frame(version, version === 2 ? 'PIC' : 'APIC', Buffer.concat([head, image]));
}

function unsynchronize(buffer) {
    const bytes = [...buffer].flatMap((byte) => (byte === 0xff ? [0xff, 0] : [byte]));
    return Buffer.from(bytes);
}

function id3Tag(version, frames, { flags = 0, extended = Buffer.alloc(0), padding = 0, unsync = false } = {}) {
    let body = Buffer.concat([extended, ...frames]);
    if (unsync) body = unsynchronize(body);
    body = Buffer.concat([body, Buffer.alloc(padding)]);
    const header = Buffer.from([version, 0, flags | (unsync ? 0x80 : 0)]);
    return Buffer.concat([Buffer.from('ID3'), header, syncsafe(body.length), body]);
}

// --- FLAC, Ogg, MP4 and WAV builders -----------------------------------------

function flacFile(blocks, prefix = Buffer.alloc(0)) {
    const parts = blocks.map(([type, body], index) => {
        const last = index === blocks.length - 1 ? 0x80 : 0;
        return Buffer.concat([Buffer.from([last | type]), u32(body.length).subarray(1), body]);
    });
    return Buffer.concat([prefix, Buffer.from('fLaC'), ...parts]);
}

function streamInfo(sampleRate, samples) {
    const packed = Buffer.alloc(8);
    packed.writeBigUInt64BE((BigInt(sampleRate) << 44n) | (1n << 41n) | (15n << 36n) | BigInt(samples));
    return Buffer.concat([u16(4096), u16(4096), Buffer.alloc(6), packed, Buffer.alloc(16)]);
}

const comment = (text) => Buffer.concat([u32le(Buffer.byteLength(text)), Buffer.from(text)]);
const commentBody = (...entries) => Buffer.concat([comment('vendor'), u32le(entries.length), ...entries.map(comment)]);

function oggPage(serial, sequence, granule, flags, packet, complete = true) {
    const lacing = Array(Math.floor(packet.length / 255)).fill(255);
    if (complete) lacing.push(packet.length % 255);
    const head = Buffer.alloc(27);
    head.write('OggS');
    head[5] = flags;
    head.writeBigUInt64LE(BigInt.asUintN(64, BigInt(granule)), 6);
    head.writeUInt32LE(serial, 14);
    head.writeUInt32LE(sequence, 18);
    head[26] = lacing.length;
    return Buffer.concat([head, Buffer.from(lacing), packet]);
}

// The comment header is cut into pages, with another stream's page between them.
function opusFile({ entries = [], seconds = 2, preSkip = 312, pageSize = 255 * 100, tagsPacket } = {}) {
    const head = Buffer.concat([Buffer.from('OpusHead'), Buffer.from([1, 1]), u16le(preSkip), u32le(48000),
        Buffer.alloc(3)]);
    const tags = tagsPacket ?? Buffer.concat([Buffer.from('OpusTags'), commentBody(...entries)]);
    const pages = [oggPage(7, 0, 0, 0x02, head)];
    for (let at = 0, sequence = 1; at < tags.length; at += pageSize, sequence++) {
        const last = at + pageSize >= tags.length;
        pages.push(oggPage(7, sequence, 0, at ? 0x01 : 0, tags.subarray(at, at + pageSize), last));
        pages.push(oggPage(9, sequence, 0, 0x02, Buffer.from('another stream')));
    }
    pages.push(oggPage(7, 99, (seconds * 48000) / 2 + preSkip, 0, noise(300)));
    pages.push(oggPage(7, 100, seconds * 48000 + preSkip, 0x04, noise(300)));
    return Buffer.concat(pages);
}

function atom(type, ...children) {
    const body = Buffer.concat(children);
    return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
}

function bigAtom(type, ...children) {
    const body = Buffer.concat(children);
    return Buffer.concat([u32(1), Buffer.from(type, 'latin1'), u32(0), u32(16 + body.length), body]);
}

const ilstItem = (type, kind, payload) => atom(type, atom('data', u32(kind), u32(0), payload));

// `wrap` builds the moov atom: bigAtom gives it a 64-bit size, atom a plain one.
function mp4File({ items, seconds = 3.5, quickTime = false, wrap = bigAtom }) {
    const mvhd = atom('mvhd', Buffer.alloc(4), u32(0), u32(0), u32(1000), u32(seconds * 1000), Buffer.alloc(80));
    const metaVersion = Buffer.alloc(quickTime ? 0 : 4);
    const meta = atom('meta', metaVersion, atom('hdlr', Buffer.alloc(24)), atom('ilst', ...items));
    return Buffer.concat([
        atom('ftyp', Buffer.from('M4A '), u32(0), Buffer.from('M4A ')),
        atom('mdat', noise(1000)),
        wrap('moov', mvhd, atom('trak', noise(200)), atom('udta', meta)),
    ]);
}

function wavFile({ info = [], id3 = null, seconds = 2, dataSize = null }) {
    const chunk = (id, body) => {
        return Buffer.concat([Buffer.from(id), u32le(body.length), body, Buffer.alloc(body.length & 1)]);
    };
    const fmt = Buffer.concat([u16le(1), u16le(1), u32le(8000), u32le(16000), u16le(2), u16le(16)]);
    const infoChunks = info.map(([id, text]) => chunk(id, Buffer.from(`${text}\0`)));
    const audio = Buffer.alloc(seconds * 16000);
    const body = Buffer.concat([
        Buffer.from('WAVE'),
        chunk('fmt ', fmt),
        chunk('LIST', Buffer.concat([Buffer.from('INFO'), ...infoChunks])),
        Buffer.from('data'), u32le(dataSize ?? audio.length), audio,
        id3 ? chunk('id3 ', id3) : Buffer.alloc(0),
    ]);
    return Buffer.concat([Buffer.from('RIFF'), u32le(body.length), body]);
}

// --- hand-built files, which need no ffmpeg ----------------------------------

test('AUDIO_EXTENSIONS lists lowercase dotted extensions', () => {
    assert.ok(AUDIO_EXTENSIONS instanceof Set);
    const expected = ['.mp3', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.m4b', '.mp4', '.aac', '.wav', '.aif',
        '.aiff', '.wma', '.wv', '.ape', '.mka', '.mpc', '.dsf'];
    for (const extension of expected) assert.ok(AUDIO_EXTENSIONS.has(extension), extension);
    assert.ok([...AUDIO_EXTENSIONS].every((extension) => /^\.[a-z0-9]+$/.test(extension)));
});

test('ID3v2.2 reads its three-letter frames, genre numbers and the PIC cover', async () => {
    const file = write('v22.mp3', id3Tag(2, [
        textFrame(2, 'TT2', 0, 'Titre'), textFrame(2, 'TP1', 0, 'Artiste'), textFrame(2, 'TP2', 0, 'Groupe'),
        textFrame(2, 'TAL', 0, 'Album'), textFrame(2, 'TRK', 0, '4/9'), textFrame(2, 'TPA', 0, '2/3'),
        textFrame(2, 'TYE', 0, '1999'), textFrame(2, 'TCO', 0, '(17)'), textFrame(2, 'TCP', 0, '1'),
        apicFrame(2, JPEG, 3),
    ]));
    assert.deepEqual(await readTags(file), {
        ...EMPTY, title: 'Titre', artist: 'Artiste', albumArtist: 'Groupe', album: 'Album', track: 4, disc: 2,
        year: 1999, genre: 'Rock', compilation: true, hasPicture: true,
    });
    assert.deepEqual(await readPicture(file), FRONT);
});

test('ID3v2.3 survives unsynchronization, UTF-16 and multiple values', async () => {
    const file = write('v23.mp3', id3Tag(3, [
        textFrame(3, 'TIT2', 1, '夜に駆ける'), textFrame(3, 'TPE1', 1, 'Ado', 'YOASOBI'), textFrame(3, 'TALB', 2, 'Café'),
        textFrame(3, 'TYER', 0, '2019'), textFrame(3, 'TCON', 0, '(51)(39)Techno-Industrial'),
        textFrame(3, 'TRCK', 0, '3/12'), apicFrame(3, JPEG, 3),
    ], { unsync: true, padding: 30 }));
    assert.deepEqual(await readTags(file), {
        ...EMPTY, title: '夜に駆ける', artist: 'Ado, YOASOBI', album: 'Café', track: 3, year: 2019,
        genre: 'Techno-Industrial', hasPicture: true,
    });
    assert.deepEqual(await readPicture(file), FRONT);
});

test('ID3v2.4 reads syncsafe sizes behind an extended header and prefers the front cover', async () => {
    const extended = Buffer.from([0, 0, 0, 6, 1, 0]);
    const file = write('v24.mp3', id3Tag(4, [
        textFrame(4, 'TIT2', 3, 'Title'), textFrame(4, 'TPE1', 3, 'A', 'B'), textFrame(4, 'TPE2', 2, 'Ünï'),
        textFrame(4, 'TALB', 3, 'Ålbum'), textFrame(4, 'TRCK', 3, '3/12'), textFrame(4, 'TPOS', 3, '1/2'),
        textFrame(4, 'TDRC', 3, '2019-05-01T10:00:00'), textFrame(4, 'TCON', 3, 'Rock', 'Pop'),
        textFrame(4, 'TCMP', 3, '1'), apicFrame(4, JPEG_BACK, 4), apicFrame(4, JPEG, 3, 'image/jpg'),
    ], { flags: 0x40, extended, padding: 20 }));
    assert.deepEqual(await readTags(file), {
        ...EMPTY, title: 'Title', artist: 'A, B', albumArtist: 'Ünï', album: 'Ålbum', track: 3, disc: 1, year: 2019,
        genre: 'Rock, Pop', compilation: true, hasPicture: true,
    });
    assert.deepEqual(await readPicture(file), FRONT);
});

test('ID3v2.4 frame sizes written as plain integers are still understood', async () => {
    const title = 'long '.repeat(40);
    const frame = (id, text) => {
        const body = textBody(3, text);
        return Buffer.concat([Buffer.from(id), u32(body.length), u16(0), body]);
    };
    const file = write('plain-sizes.mp3', id3Tag(4, [frame('TIT2', title), frame('TPE1', 'After the long one')]));
    const tags = await readTags(file);
    assert.equal(tags.title, title.trim());
    assert.equal(tags.artist, 'After the long one');
});

test('a file with only ID3v1 reads its fields, track and genre', async () => {
    const field = (text, length) => Buffer.concat([Buffer.from(text, 'latin1'), Buffer.alloc(length - text.length)]);
    const file = write('v1.mp3', noise(40, 3), Buffer.from('TAG'), field('Old Song', 30), field('Old Band', 30),
        field('Old Album', 30), field('1999', 4), field('', 28), Buffer.from([0, 7, 17]));
    assert.deepEqual(await readTags(file), {
        ...EMPTY, title: 'Old Song', artist: 'Old Band', album: 'Old Album', track: 7, year: 1999, genre: 'Rock',
    });
});

test('FLAC reads STREAMINFO, mixed-case Vorbis keys and the front cover among several pictures', async () => {
    const blocks = [
        [0, streamInfo(44100, 88200)],
        [4, commentBody('title=Hand Title', 'Artist=First', 'ARTIST=Second', 'album artist=The Band', 'ALBUM=Alb',
            'tracknumber=3/12', 'TRACKTOTAL=12', 'DiscNumber=1/2', 'DATE=2019-05-01', 'GENRE=Rock', 'COMPILATION=1')],
        [6, pictureBlock(JPEG_BACK, { type: 4, mime: 'image/jpeg' })],
        [6, pictureBlock(JPEG, { type: 3, mime: 'image/jpeg' })],
        [1, Buffer.alloc(100)],
    ];
    const expected = {
        ...EMPTY, title: 'Hand Title', artist: 'First, Second', albumArtist: 'The Band', album: 'Alb', track: 3,
        disc: 1, year: 2019, genre: 'Rock', compilation: true, duration: 2, hasPicture: true,
    };
    const id3Prefix = id3Tag(3, [textFrame(3, 'TIT2', 0, 'Not this one')], { padding: 50 });
    for (const [name, prefix] of [['plain.flac', Buffer.alloc(0)], ['tagged.flac', id3Prefix]]) {
        const file = write(name, flacFile(blocks, prefix));
        assert.deepEqual(await readTags(file), expected, name);
        assert.deepEqual(await readPicture(file), FRONT, name);
    }
});

test('Ogg Opus reassembles a comment header spread over pages among other streams', async () => {
    const cover = makePng({ width: 150, height: 150, noise: true });
    const file = write('pages.opus', opusFile({
        entries: ['TITLE=Paged', 'ARTIST=Someone', `METADATA_BLOCK_PICTURE=${pictureBlock(cover).toString('base64')}`,
            'DATE=2020'],
    }));
    assert.deepEqual(await readTags(file), {
        ...EMPTY, title: 'Paged', artist: 'Someone', year: 2020, duration: 2, hasPicture: true,
    });
    assert.deepEqual(await readPicture(file), { data: cover, mime: 'image/png' });
});

test('MP4 reads iTunes atoms behind a 64-bit moov, with or without the meta version word', async () => {
    const items = [
        ilstItem('©nam', 1, Buffer.from('夜に駆ける')), ilstItem('©ART', 1, Buffer.from('Artist')),
        ilstItem('aART', 1, Buffer.from('Band')), ilstItem('©alb', 1, Buffer.from('Album')),
        ilstItem('©day', 1, Buffer.from('2019-05-01')), ilstItem('gnre', 0, Buffer.from([0, 18])),
        ilstItem('trkn', 0, Buffer.from([0, 0, 0, 5, 0, 12, 0, 0])),
        ilstItem('disk', 0, Buffer.from([0, 0, 0, 2, 0, 3])),
        ilstItem('cpil', 21, Buffer.from([1])), ilstItem('covr', 13, JPEG),
    ];
    const expected = {
        ...EMPTY, title: '夜に駆ける', artist: 'Artist', albumArtist: 'Band', album: 'Album', track: 5, disc: 2,
        year: 2019, genre: 'Rock', compilation: true, duration: 3.5, hasPicture: true,
    };
    for (const [name, options] of [['big.m4a', {}], ['quicktime.m4a', { quickTime: true, wrap: atom }]]) {
        const file = write(name, mp4File({ items, ...options }));
        assert.deepEqual(await readTags(file), expected, name);
        assert.deepEqual(await readPicture(file), FRONT, name);
    }
});

test('WAV takes its length from the data chunk and prefers an ID3 chunk over LIST INFO', async () => {
    const info = [['INAM', 'Info Title'], ['IART', 'Info Artist'], ['IPRD', 'Info Album'], ['ITRK', '5'],
        ['ICRD', '2001-02-03'], ['IGNR', 'Jazz']];
    const infoOnly = write('info.wav', wavFile({ info }));
    assert.deepEqual(await readTags(infoOnly), {
        ...EMPTY, title: 'Info Title', artist: 'Info Artist', album: 'Info Album', track: 5, year: 2001, genre: 'Jazz',
        duration: 2,
    });

    const id3 = id3Tag(4, [
        textFrame(4, 'TIT2', 3, 'ID3 Title'), textFrame(4, 'TPE2', 3, 'ID3 Band'), apicFrame(4, JPEG, 3),
    ]);
    const both = write('both.wav', wavFile({ info, id3 }));
    assert.deepEqual(await readTags(both), {
        ...EMPTY, title: 'ID3 Title', artist: 'Info Artist', albumArtist: 'ID3 Band', album: 'Info Album', track: 5,
        year: 2001, genre: 'Jazz', duration: 2, hasPicture: true,
    });
    assert.deepEqual(await readPicture(both), FRONT);

    const streamed = write('streamed.wav', wavFile({ dataSize: 0xffffffff }));
    assertDuration((await readTags(streamed)).duration, 2);
});

test('reading tags leaves large covers unread', async () => {
    const cover = makePng({ width: 1000, height: 1000, noise: true });
    const items = [ilstItem('©nam', 1, Buffer.from('Big')), ilstItem('covr', 13, cover)];
    const files = {
        'big.mp3': write('big.mp3', id3Tag(4, [textFrame(4, 'TIT2', 3, 'Big'), apicFrame(4, cover, 3)])),
        'big.flac': write('big.flac', flacFile([[0, streamInfo(44100, 88200)], [4, commentBody('TITLE=Big')],
            [6, pictureBlock(cover)]])),
        'big.m4a': write('big.m4a', mp4File({ items })),
        'big.opus': write('big.opus', opusFile({
            entries: ['TITLE=Big', `METADATA_BLOCK_PICTURE=${pictureBlock(cover).toString('base64')}`],
            pageSize: 255 * 255,
        })),
    };
    for (const [name, file] of Object.entries(files)) {
        let tags;
        const bytes = await countBytesRead(async () => { tags = await readTags(file); });
        assert.equal(tags.title, 'Big', name);
        assert.equal(tags.hasPicture, true, name);
        assert.ok(bytes < 128 * 1024, `${name} read ${bytes} bytes`);
        assert.equal((await readPicture(file)).data.length, cover.length, name);
    }
});

test('corrupt, truncated and empty files give nulls and never throw', async () => {
    const flac = flacFile([[0, streamInfo(44100, 88200)], [1, Buffer.alloc(10)]]);
    const cases = {
        'noise.mp3': noise(4096),
        'noise.flac': Buffer.concat([Buffer.from('fLaC'), noise(500, 2)]),
        'noise.ogg': Buffer.concat([Buffer.from('OggS'), noise(500, 3)]),
        'noise.m4a': noise(3000, 4),
        'noise.wav': Buffer.concat([Buffer.from('RIFF'), noise(8), Buffer.from('WAVE'), noise(200, 5)]),
        'noise.aiff': noise(2000, 6),
        'empty.mp3': Buffer.alloc(0),
        'empty.flac': Buffer.alloc(0),
        'empty.opus': Buffer.alloc(0),
        'cut.flac': flac.subarray(0, 20),
        'cut.opus': opusFile().subarray(0, 40),
        'cut.m4a': mp4File({ items: [ilstItem('©nam', 1, Buffer.from('x'))] }).subarray(0, 1040),
        'cut-tag.mp3': id3Tag(3, [textFrame(3, 'TIT2', 0, 'x')]).subarray(0, 15),
    };
    for (const [name, bytes] of Object.entries(cases)) {
        const file = write(name, bytes);
        assert.deepEqual(await readTags(file), EMPTY, name);
        // Every ffmpeg fallback costs a process, so only a few files try for a picture too.
        if (/^(noise\.(mp3|aiff)|empty\.flac|cut\.m4a)$/.test(name)) assert.equal(await readPicture(file), null, name);
    }
    const missing = path.join(dir, 'missing.flac');
    assert.deepEqual(await readTags(missing), EMPTY);
    assert.equal(await readPicture(missing), null);
    assert.deepEqual(await readTags(dir), EMPTY);
});

test('a missing ffmpeg only costs the formats that need it', async () => {
    const file = write('nowhere.aiff', noise(2000, 7));
    const ffmpegPath = path.join(dir, 'no-such-ffmpeg');
    assert.deepEqual(await readTags(file, { ffmpegPath }), EMPTY);
    assert.equal(await readPicture(file, { ffmpegPath }), null);
});

test('absurd sizes inside a file are bounded instead of allocated', async () => {
    const id3Bomb = (flags) => Buffer.concat([
        Buffer.from('ID3'), Buffer.from([3, 0, flags]), syncsafe(0x0fffffff),
        Buffer.from('TIT2'), u32(0x0fffffff), u16(0), Buffer.from([0, 65, 66, 67]),
    ]);
    for (const flags of [0, 0x80]) assert.deepEqual(await readTags(write(`bomb-${flags}.mp3`, id3Bomb(flags))), EMPTY);

    // flacFile marks STREAMINFO as the last block; clear that and add a comment block of 16 MB.
    const flac = flacFile([[0, streamInfo(44100, 88200)]]);
    flac[4] &= 0x7f;
    const hugeBlock = write('bomb.flac', flac, Buffer.from([0x84, 0xff, 0xff, 0xff]), noise(10));
    assert.deepEqual(await readTags(hugeBlock), { ...EMPTY, duration: 2 });

    const hugeVendor = Buffer.concat([Buffer.from('OpusTags'), u32le(0xffffffff), noise(40)]);
    const hugeCount = Buffer.concat([Buffer.from('OpusTags'), comment('x'), u32le(0xffffffff), u32le(0xffffffff),
        noise(10)]);
    for (const [name, tagsPacket] of [['vendor.opus', hugeVendor], ['count.opus', hugeCount]]) {
        assert.deepEqual(await readTags(write(name, opusFile({ tagsPacket }))), { ...EMPTY, duration: 2 }, name);
    }

    const hugeAtom = Buffer.concat([atom('ftyp', Buffer.from('M4A ')), u32(1), Buffer.from('moov'), u32(0x10000000),
        u32(0), noise(50)]);
    assert.deepEqual(await readTags(write('bomb.m4a', hugeAtom)), EMPTY);
});

// --- ffmpeg fallback with a stand-in binary ----------------------------------

test('the ffmpeg fallback passes a file: URL, reads the report and ignores stream metadata', scriptable, async () => {
    const report = [
        "Input #0, asf, from 'file:x':",
        '  Metadata:',
        '    title           : Fake Title',
        '    artist          : Fake Artist',
        '    album_artist    : Fake Band',
        '    track           : 4/10',
        '    DATE            : 2018',
        '                    : a continuation line',
        '    genre           : Pop',
        '  Duration: 01:02:03.50, start: 0.000000, bitrate: 128 kb/s',
        '  Stream #0:0: Audio: wmav2, 44100 Hz, stereo, fltp, 128 kb/s',
        '    Metadata:',
        '      title           : Stream title',
        '  Stream #0:1: Video: mjpeg (attached pic)',
        '',
    ].join('\n');
    const cover = makePng();
    const log = path.join(dir, 'ffmpeg-args.log');
    const coverBase64 = JSON.stringify(cover.toString('base64'));
    const ffmpeg = fakeBinary(dir, 'fake-ffmpeg', `
        const fs = require('node:fs');
        fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
        if (process.argv.includes('pipe:1')) process.stdout.write(Buffer.from(${coverBase64}, 'base64'));
        else { process.stderr.write(${JSON.stringify(report)}); process.exit(1); }`);
    write('-odd: name.wma', noise(500, 8));

    const tags = await fromDir(() => readTags('-odd: name.wma', { ffmpegPath: ffmpeg }));
    assert.deepEqual(tags, {
        ...EMPTY, title: 'Fake Title', artist: 'Fake Artist', albumArtist: 'Fake Band', track: 4, year: 2018,
        genre: 'Pop', duration: 3723.5, hasPicture: true,
    });
    const picture = await fromDir(() => readPicture('-odd: name.wma', { ffmpegPath: ffmpeg }));
    assert.deepEqual(picture, { data: cover, mime: 'image/png' });

    const target = `file:${path.join(dir, '-odd: name.wma')}`;
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls, [
        ['-hide_banner', '-nostdin', '-i', target],
        ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', target, '-an', '-map', '0:v:0?', '-c:v', 'copy',
            '-frames:v', '1', '-f', 'image2pipe', 'pipe:1'],
    ]);
});

test('ffmpeg output that is too large or not an image is dropped', scriptable, async () => {
    const huge = fakeBinary(dir, 'huge-ffmpeg', 'process.stdout.write(Buffer.alloc(9 * 1024 * 1024, 0xff));');
    const text = fakeBinary(dir, 'text-ffmpeg', "process.stdout.write('not an image at all');");
    const file = write('unknown.wma', noise(500, 9));
    assert.equal(await readPicture(file, { ffmpegPath: huge }), null);
    assert.equal(await readPicture(file, { ffmpegPath: text }), null);
});

// --- files made by ffmpeg ----------------------------------------------------

const TAGS = {
    title: '夜に駆ける', artist: '방탄소년단', album: 'Café', album_artist: 'Ünï Band', track: '3/12', disc: '1/2',
    date: '2019-05-01', genre: 'J-Pop', compilation: '1',
};
const FROM_TAGS = {
    title: '夜に駆ける', artist: '방탄소년단', albumArtist: 'Ünï Band', album: 'Café', track: 3, disc: 1, year: 2019,
    genre: 'J-Pop',
};
const subset = (tags) => Object.fromEntries(Object.keys(FROM_TAGS).map((key) => [key, tags[key]]));

for (const format of ['mp3', 'flac', 'ogg', 'opus', 'm4a']) {
    test(`${format}: Unicode tags, numbers, duration and the embedded cover`, needs(format), async () => {
        // Ogg carries its cover in a comment, which is why this one is big enough to span pages.
        const ogg = format === 'ogg' || format === 'opus';
        const cover = ogg ? makePng({ width: 150, height: 150, noise: true }) : makePng();
        const file = makeAudioFixture(dir, `made-${format}`, { format, tags: TAGS, cover });
        const tags = await readTags(file);
        assert.deepEqual(subset(tags), FROM_TAGS);
        // ffmpeg stores an MP3's compilation flag in a TXXX frame, which is not read.
        if (format !== 'mp3') assert.equal(tags.compilation, true);
        assertDuration(tags.duration, 2);
        assert.equal(tags.hasPicture, true);
        assert.deepEqual(await readPicture(file), { data: cover, mime: 'image/png' });
    });

    test(`${format}: a file without a cover reports none`, needs(format), async () => {
        const file = makeAudioFixture(dir, `bare-${format}`, { format, seconds: 3, tags: { title: 'Bare' } });
        const tags = await readTags(file);
        assert.deepEqual({ ...tags, duration: null }, { ...EMPTY, title: 'Bare' });
        assertDuration(tags.duration, 3);
        assert.equal(await readPicture(file), null);
    });
}

for (const id3v2Version of [3, 4]) {
    test(`mp3: ID3v2.${id3v2Version} written by ffmpeg`, needs('mp3'), async () => {
        const cover = makePng();
        const file = makeAudioFixture(dir, `v${id3v2Version}-made`, { format: 'mp3', tags: TAGS, cover, id3v2Version });
        assert.deepEqual(subset(await readTags(file)), FROM_TAGS);
        assert.deepEqual((await readPicture(file)).data, cover);
    });
}

test('mp3: audio after a hand-built tag is found past an extended header and padding', needs('mp3'), async () => {
    const audio = fs.readFileSync(makeAudioFixture(dir, 'audio-only', { format: 'mp3', id3v2Version: 0 }));
    const tag = id3Tag(4, [textFrame(4, 'TIT2', 3, 'In front')], {
        flags: 0x40, extended: Buffer.from([0, 0, 0, 6, 1, 0]), padding: 5000,
    });
    const tags = await readTags(write('prefixed.mp3', tag, audio));
    assert.equal(tags.title, 'In front');
    assertDuration(tags.duration, 2);
});

test('mp3: a constant-bitrate file without a Xing header is measured from its size', needs('mp3'), async () => {
    const file = makeAudioFixture(dir, 'cbr', {
        format: 'mp3', seconds: 4, id3v2Version: 0, extraArgs: ['-write_xing', '0'],
    });
    const tags = await readTags(file);
    assert.equal(tags.title, null);
    assertDuration(tags.duration, 4);
});

test('mp3: ID3v1 alone is read when the ID3v2 tag is gone', needs('mp3'), async () => {
    const tags = { title: 'Old Song', artist: 'Old Band', album: 'Old Album', date: '1999', track: '7', genre: 'Rock' };
    const both = fs.readFileSync(makeAudioFixture(dir, 'v1-made', {
        format: 'mp3', tags, extraArgs: ['-write_id3v1', '1'],
    }));
    const v2Size = 10 + ((both[6] << 21) | (both[7] << 14) | (both[8] << 7) | both[9]);
    const read = await readTags(write('v1-only.mp3', both.subarray(v2Size)));
    assert.deepEqual({ ...read, duration: null }, {
        ...EMPTY, title: 'Old Song', artist: 'Old Band', album: 'Old Album', track: 7, year: 1999, genre: 'Rock',
    });
    assertDuration(read.duration, 2);
});

test('wav: LIST INFO written by ffmpeg, Unicode included', needs('wav'), async () => {
    const file = makeAudioFixture(dir, 'made-wav', { format: 'wav', tags: TAGS });
    const tags = await readTags(file);
    // INFO has no field for the album artist or the disc.
    assert.deepEqual(subset(tags), { ...FROM_TAGS, albumArtist: null, disc: null });
    assertDuration(tags.duration, 2);
    assert.equal(tags.hasPicture, false);
});

test('formats without a parser go through ffmpeg, even when the name starts with a hyphen or has a colon',
    { skip: skipReason('aiff') || (process.platform === 'win32' && 'no colons in file names') }, async () => {
        const cover = makePng();
        for (const name of ['-dash.aiff', 'http:odd.aiff']) {
            makeAudioFixture(dir, name, { format: 'aiff', tags: TAGS, cover, id3v2Version: 3 });
            const tags = await fromDir(() => readTags(name));
            assert.deepEqual(subset(tags), FROM_TAGS, name);
            assertDuration(tags.duration, 2);
            assert.equal(tags.hasPicture, true, name);
            assert.deepEqual(await fromDir(() => readPicture(name)), { data: cover, mime: 'image/png' }, name);
        }
    });

test('mka goes through ffmpeg for tags and cover', needs('mka'), async () => {
    const cover = makePng();
    const file = makeAudioFixture(dir, 'made-mka', { format: 'mka', tags: TAGS, cover });
    const tags = await readTags(file);
    assert.deepEqual(subset(tags), FROM_TAGS);
    assert.equal(tags.hasPicture, true);
    assert.deepEqual((await readPicture(file)).data, cover);
});
