// SPDX-License-Identifier: GPL-3.0-only
// Tags, durations and cover art for local audio files, parsed in plain JavaScript; ffmpeg reads whatever is left.

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const AUDIO_EXTENSIONS = new Set([
    '.mp3', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.m4b', '.mp4', '.aac',
    '.wav', '.aif', '.aiff', '.wma', '.wv', '.ape', '.mka', '.mpc', '.dsf',
]);

const MAX_READ = 32 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const MAX_ITEMS = 10000;
const FFMPEG_TIMEOUT_MS = 10000;
const FFMPEG_MAX_BYTES = 8 * 1024 * 1024;

const GENRES = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal',
    'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska',
    'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion',
    'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'Alternative Rock',
    'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic',
    'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult',
    'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychedelic',
    'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical',
    'Rock & Roll', 'Hard Rock', 'Folk', 'Folk-Rock', 'National Folk', 'Swing', 'Fast Fusion', 'Bebop', 'Latin',
    'Revival', 'Celtic', 'Bluegrass', 'Avantgarde', 'Gothic Rock', 'Progressive Rock', 'Psychedelic Rock',
    'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus', 'Easy Listening', 'Acoustic', 'Humour', 'Speech', 'Chanson',
    'Opera', 'Chamber Music', 'Sonata', 'Symphony', 'Booty Bass', 'Primus', 'Porn Groove', 'Satire', 'Slow Jam', 'Club',
    'Tango', 'Samba', 'Folklore', 'Ballad', 'Power Ballad', 'Rhythmic Soul', 'Freestyle', 'Duet', 'Punk Rock',
    'Drum Solo', 'A cappella', 'Euro-House', 'Dance Hall'];

const MPEG_BITRATES = {
    1: {
        1: [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
        2: [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
        3: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    },
    2: {
        1: [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
        2: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
        3: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    },
};
// Keyed by the header's version bits: 3 is MPEG-1, 2 is MPEG-2 and 0 is MPEG-2.5.
const MPEG_SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

const ID3_TEXT_FIELDS = {
    TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TPE2: 'albumArtist', TP2: 'albumArtist',
    TALB: 'album', TAL: 'album', TRCK: 'track', TRK: 'track', TPOS: 'disc', TPA: 'disc',
    TDRC: 'year', TYER: 'year', TYE: 'year', TCON: 'genre', TCO: 'genre', TCMP: 'compilation', TCP: 'compilation',
};

const VORBIS_FIELDS = {
    TITLE: 'title', ARTIST: 'artist', ALBUMARTIST: 'albumArtist', 'ALBUM ARTIST': 'albumArtist',
    ALBUM_ARTIST: 'albumArtist', ALBUM: 'album', TRACKNUMBER: 'track', TRACK: 'track', DISCNUMBER: 'disc',
    DISC: 'disc', DATE: 'year', YEAR: 'year', GENRE: 'genre', COMPILATION: 'compilation',
};

const MP4_TEXT_FIELDS = {
    '©nam': 'title', '©ART': 'artist', aART: 'albumArtist', '©alb': 'album',
    '©day': 'year', '©gen': 'genre',
};
const MP4_IMAGE_TYPES = { 12: 'image/gif', 13: 'image/jpeg', 14: 'image/png', 27: 'image/bmp' };

const WAV_INFO_FIELDS = {
    INAM: 'title', IART: 'artist', IPRD: 'album', ITRK: 'track', IPRT: 'track', ICRD: 'year', IGNR: 'genre',
};

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

const sum = (values) => values.reduce((total, value) => total + value, 0);
const endOfData = () => new RangeError('end of data');
const newRaw = () => ({
    title: [], artist: [], albumArtist: [], album: [], track: [], disc: [], year: [], genre: [], compilation: [],
});

function clean(value) {
    return String(value ?? '').replace(/\0/g, '').trim() || null;
}

function add(raw, field, value) {
    const text = clean(value);
    if (text) raw[field].push(text);
}

function mergeRaw(primary, fallback) {
    const merged = {};
    for (const key of Object.keys(primary)) merged[key] = primary[key].length ? primary[key] : fallback[key];
    return merged;
}

// Tags written as "latin1" are often UTF-8 in practice.
function decodeLoose(buffer) {
    try {
        return strictUtf8.decode(buffer);
    } catch {
        return buffer.toString('latin1');
    }
}

function sniffImage(buffer) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
    if (buffer.length > 7 && buffer.readUInt32BE(0) === 0x89504e47) return 'image/png';
    const head = buffer.toString('latin1', 0, 4);
    if (head === 'GIF8') return 'image/gif';
    if (head === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
    if (head.startsWith('BM')) return 'image/bmp';
    return null;
}

function imageMime(data, declared) {
    const sniffed = sniffImage(data);
    if (sniffed) return sniffed;
    const mime = clean(declared)?.toLowerCase();
    if (!mime) return 'application/octet-stream';
    return mime.includes('/') ? mime.replace('image/jpg', 'image/jpeg') : `image/${mime === 'jpg' ? 'jpeg' : mime}`;
}

function fileReader(fh, size) {
    return async (position, length) => {
        const wanted = Math.min(length, size - position);
        if (!(wanted > 0)) return Buffer.alloc(0);
        if (wanted > MAX_READ) throw new RangeError('read too large');
        const buffer = Buffer.allocUnsafe(wanted);
        const { bytesRead } = await fh.read(buffer, 0, wanted, position);
        return bytesRead < wanted ? buffer.subarray(0, bytesRead) : buffer;
    };
}

const bufferReader = (buffer) => async (position, length) => buffer.subarray(position, position + length);

function bufferStream(buffer) {
    let position = 0;
    return {
        async take(count) {
            if (count > buffer.length - position) throw endOfData();
            position += count;
            return buffer.subarray(position - count, position);
        },
        async skip(count) {
            if (count > buffer.length - position) throw endOfData();
            position += count;
        },
    };
}

// --- ID3 ---------------------------------------------------------------------

const syncsafe = (b, offset) => ((b[offset] & 0x7f) << 21) | ((b[offset + 1] & 0x7f) << 14)
    | ((b[offset + 2] & 0x7f) << 7) | (b[offset + 3] & 0x7f);

function unsynchronize(buffer) {
    const out = Buffer.allocUnsafe(buffer.length);
    let length = 0;
    for (let i = 0; i < buffer.length; i++) {
        out[length++] = buffer[i];
        if (buffer[i] === 0xff && buffer[i + 1] === 0) i++;
    }
    return out.subarray(0, length);
}

async function readId3v2Header(read, position) {
    const head = await read(position, 10);
    if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3') return null;
    const version = head[3];
    if (version < 2 || version > 4 || ((head[6] | head[7] | head[8] | head[9]) & 0x80)) return null;
    const flags = head[5];
    const size = syncsafe(head, 6);
    return { version, flags, size, total: 10 + size + (version === 4 && flags & 0x10 ? 10 : 0) };
}

function splitStrings(buffer, wide) {
    const parts = [];
    const step = wide ? 2 : 1;
    let start = 0;
    for (let i = 0; i + step <= buffer.length; i += step) {
        if (buffer[i] === 0 && (!wide || buffer[i + 1] === 0)) {
            parts.push(buffer.subarray(start, i));
            start = i + step;
        }
    }
    if (start < buffer.length) parts.push(buffer.subarray(start));
    return parts;
}

function decodeUtf16(buffer, bigEndian) {
    let start = 0;
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
        start = 2;
        bigEndian = false;
    } else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
        start = 2;
        bigEndian = true;
    }
    const bytes = Buffer.from(buffer.subarray(start, buffer.length - ((buffer.length - start) & 1)));
    return (bigEndian ? bytes.swap16() : bytes).toString('utf16le');
}

function id3Strings(data) {
    const encoding = data[0];
    const wide = encoding === 1 || encoding === 2;
    return splitStrings(data.subarray(1), wide).map((part) => {
        if (wide) return decodeUtf16(part, encoding === 2);
        return encoding === 3 ? part.toString('utf8') : decodeLoose(part);
    });
}

function expandGenre(text) {
    const references = [];
    let rest = text.trim();
    let match;
    while ((match = /^\((\d{1,3}|RX|CR)\)/.exec(rest))) {
        references.push(match[1]);
        rest = rest.slice(match[0].length);
    }
    if (rest) return /^\d{1,3}$/.test(rest) ? GENRES[+rest] ?? rest : rest;
    return references.map((reference) => GENRES[+reference]).filter(Boolean).join(', ');
}

// Returns null for frames that are encrypted or compressed, which no tagger really writes.
function frameBody(data, version, flags) {
    let skip = 0;
    let unsync = false;
    if (version === 3) {
        if (flags & 0x00c0) return null;
        if (flags & 0x0020) skip = 1;
    } else if (version === 4) {
        if (flags & 0x000c) return null;
        if (flags & 0x0040) skip += 1;
        if (flags & 0x0001) skip += 4;
        unsync = Boolean(flags & 0x0002);
    }
    const body = data.subarray(skip);
    return unsync ? unsynchronize(body) : body;
}

function apicParts(data, version) {
    if (data.length < 6) return null;
    const encoding = data[0];
    let position;
    let mime;
    if (version === 2) {
        mime = data.toString('latin1', 1, 4);
        position = 4;
    } else {
        const end = data.indexOf(0, 1);
        if (end < 0) return null;
        mime = data.toString('latin1', 1, end);
        position = end + 1;
    }
    const type = data[position++];
    if (encoding === 1 || encoding === 2) {
        while (position + 1 < data.length && (data[position] !== 0 || data[position + 1] !== 0)) position += 2;
        position += 2;
    } else {
        const end = data.indexOf(0, position);
        position = end < 0 ? data.length : end + 1;
    }
    return { type, mime, data: data.subarray(position) };
}

// Some taggers wrote 2.4 frame sizes as plain integers; the next frame header gives the right reading away.
async function endsAtFrame(body, at, end) {
    if (at === end) return true;
    if (at > end) return false;
    const next = await body(at, 4);
    return next.length > 0 && (next[0] === 0 || /^[A-Z0-9]{4}$/.test(next.toString('latin1')));
}

async function readId3v2(read, position, { version, flags, size }) {
    const raw = newRaw();
    const pictures = [];
    if (version === 2 && flags & 0x40) return { raw, pictures };
    let body = (offset, length) => read(position + 10 + offset, Math.min(length, size - offset));
    let bodySize = size;
    if (version < 4 && flags & 0x80) {
        const data = unsynchronize(await read(position + 10, Math.min(size, MAX_READ)));
        body = bufferReader(data);
        bodySize = data.length;
    }
    let offset = 0;
    if (version > 2 && flags & 0x40) {
        const head = await body(0, 4);
        offset = version === 3 ? head.readUInt32BE(0) + 4 : syncsafe(head, 0);
    }
    const idLength = version === 2 ? 3 : 4;
    const headerLength = version === 2 ? 6 : 10;
    for (let n = 0; n < MAX_ITEMS && offset + headerLength <= bodySize; n++) {
        const head = await body(offset, headerLength);
        const id = head.toString('latin1', 0, idLength);
        if (head.length < headerLength || !/^[A-Z0-9]+$/.test(id)) break;
        const frameFlags = version === 2 ? 0 : head.readUInt16BE(8);
        const start = offset + headerLength;
        let length = version === 2 ? head.readUIntBE(3, 3) : version === 3 ? head.readUInt32BE(4) : syncsafe(head, 4);
        if (version === 4 && !(await endsAtFrame(body, start + length, bodySize))) {
            const plain = head.readUInt32BE(4);
            if (await endsAtFrame(body, start + plain, bodySize)) length = plain;
        }
        if (start + length > bodySize) break;
        offset = start + length;

        const field = ID3_TEXT_FIELDS[id];
        if (field && length > 1 && length <= MAX_TEXT) {
            const data = frameBody(await body(start, length), version, frameFlags);
            if (!data || data.length < 2) continue;
            for (const value of id3Strings(data)) add(raw, field, field === 'genre' ? expandGenre(value) : value);
        } else if ((id === 'APIC' || id === 'PIC') && length > 8) {
            const apic = apicParts(await body(start, Math.min(length, 1024)), version);
            if (apic && apic.mime !== '-->') {
                pictures.push({
                    type: apic.type,
                    async load() {
                        const data = frameBody(await body(start, length), version, frameFlags);
                        return data && apicParts(data, version);
                    },
                });
            }
        }
    }
    return { raw, pictures };
}

function readId3v1(tail) {
    const raw = newRaw();
    const text = (from, to) => decodeLoose(tail.subarray(from, to));
    add(raw, 'title', text(3, 33));
    add(raw, 'artist', text(33, 63));
    add(raw, 'album', text(63, 93));
    add(raw, 'year', text(93, 97));
    if (tail[125] === 0 && tail[126] !== 0) add(raw, 'track', tail[126]);
    add(raw, 'genre', GENRES[tail[127]]);
    return raw;
}

// --- MP3 ---------------------------------------------------------------------

function mpegFrame(b, i) {
    if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
    const version = (b[i + 1] >> 3) & 3;
    const layerBits = (b[i + 1] >> 1) & 3;
    const bitrateIndex = b[i + 2] >> 4;
    const rateIndex = (b[i + 2] >> 2) & 3;
    if (version === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
    const layer = 4 - layerBits;
    const bitrate = MPEG_BITRATES[version === 3 ? 1 : 2][layer][bitrateIndex - 1] * 1000;
    const sampleRate = MPEG_SAMPLE_RATES[version][rateIndex];
    const padding = (b[i + 2] >> 1) & 1;
    const samples = layer === 1 ? 384 : layer === 3 && version !== 3 ? 576 : 1152;
    const length = layer === 1
        ? (Math.floor(12 * bitrate / sampleRate) + padding) * 4
        : Math.floor(samples / 8 * bitrate / sampleRate) + padding;
    return { version, layer, bitrate, sampleRate, samples, length, mono: ((b[i + 3] >> 6) & 3) === 3 };
}

function mpegFrameCount(b, i, frame) {
    if (frame.layer !== 3) return 0;
    const sideInfo = frame.version === 3 ? (frame.mono ? 17 : 32) : (frame.mono ? 9 : 17);
    for (const offset of [4 + sideInfo, 6 + sideInfo]) {
        const tag = b.toString('latin1', i + offset, i + offset + 4);
        if ((tag === 'Xing' || tag === 'Info') && i + offset + 12 <= b.length && b[i + offset + 7] & 1) {
            return b.readUInt32BE(i + offset + 8);
        }
    }
    if (b.toString('latin1', i + 36, i + 40) === 'VBRI' && i + 54 <= b.length) return b.readUInt32BE(i + 50);
    return 0;
}

async function mpegDuration(read, start, end) {
    const window = await read(start, 64 * 1024);
    for (let i = 0; i + 4 <= window.length; i++) {
        const frame = mpegFrame(window, i);
        if (!frame) continue;
        // A lone frame is believed only when it ends the audio; otherwise the next one must match.
        const next = start + i + frame.length;
        if (next !== end) {
            const after = next + 4 <= start + window.length ? window.subarray(next - start) : await read(next, 4);
            const follower = mpegFrame(after, 0);
            if (!follower || follower.layer !== frame.layer || follower.sampleRate !== frame.sampleRate) continue;
        }
        const frames = mpegFrameCount(window, i, frame);
        const seconds = frames ? frames * frame.samples / frame.sampleRate : (end - start - i) * 8 / frame.bitrate;
        return seconds > 0 ? seconds : null;
    }
    return null;
}

async function parseMp3(read, size, id3) {
    const tag = id3 ? await readId3v2(read, 0, id3) : { raw: newRaw(), pictures: [] };
    let raw = tag.raw;
    const tail = size >= 128 ? await read(size - 128, 128) : Buffer.alloc(0);
    const hasV1 = tail.length === 128 && tail.toString('latin1', 0, 3) === 'TAG';
    if (hasV1 && !raw.title.length && !raw.artist.length && !raw.album.length) raw = mergeRaw(raw, readId3v1(tail));
    const duration = await mpegDuration(read, id3 ? id3.total : 0, hasV1 ? size - 128 : size);
    return { raw, pictures: tag.pictures, duration };
}

// --- Vorbis comments, FLAC and Ogg -------------------------------------------

function parsePictureBlock(block) {
    let position = 4;
    const take = (length) => {
        if (length > block.length - position) throw endOfData();
        position += length;
        return block.subarray(position - length, position);
    };
    try {
        const type = block.readUInt32BE(0);
        const mime = take(take(4).readUInt32BE(0)).toString('latin1');
        take(take(4).readUInt32BE(0));
        take(16);
        return { type, mime, data: take(take(4).readUInt32BE(0)) };
    } catch {
        return null;
    }
}

// Reads comments until the stream ends; a truncated block still yields what came before the cut.
async function readComments(stream, wantPicture, raw, pictures) {
    try {
        await stream.skip((await stream.take(4)).readUInt32LE(0));
        const count = (await stream.take(4)).readUInt32LE(0);
        for (let i = 0; i < Math.min(count, MAX_ITEMS); i++) {
            const length = (await stream.take(4)).readUInt32LE(0);
            const head = await stream.take(Math.min(length, 32));
            const equals = head.indexOf('=');
            const key = equals < 0 ? '' : head.toString('latin1', 0, equals).toUpperCase();
            const rest = length - head.length;
            if (key === 'METADATA_BLOCK_PICTURE') {
                let picture = null;
                if (wantPicture && length <= MAX_READ) {
                    const encoded = Buffer.concat([head.subarray(equals + 1), await stream.take(rest)]);
                    picture = parsePictureBlock(Buffer.from(encoded.toString('latin1'), 'base64'));
                } else {
                    await stream.skip(rest);
                }
                pictures.push({ type: picture?.type ?? 0, load: async () => picture });
            } else if (length > MAX_TEXT) {
                await stream.skip(rest);
            } else {
                const entry = rest ? Buffer.concat([head, await stream.take(rest)]) : head;
                const field = VORBIS_FIELDS[key];
                if (field) add(raw, field, entry.toString('utf8', equals + 1));
            }
        }
    } catch (error) {
        if (!(error instanceof RangeError)) throw error;
    }
}

async function parseFlac(read, size, start) {
    const raw = newRaw();
    const pictures = [];
    let duration = null;
    let position = start + 4;
    for (let n = 0; n < MAX_ITEMS; n++) {
        const head = await read(position, 4);
        if (head.length < 4) break;
        const type = head[0] & 0x7f;
        const length = head.readUIntBE(1, 3);
        const body = position + 4;
        if (body + length > size) break;
        if (type === 0 && length >= 18) {
            const info = await read(body, 18);
            const sampleRate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4);
            const samples = (info[13] & 0x0f) * 2 ** 32 + info.readUInt32BE(14);
            if (sampleRate > 0 && samples > 0) duration = samples / sampleRate;
        } else if (type === 4 && length <= MAX_READ) {
            await readComments(bufferStream(await read(body, length)), true, raw, pictures);
        } else if (type === 6 && length >= 4) {
            const pictureType = (await read(body, 4)).readUInt32BE(0);
            pictures.push({ type: pictureType, load: async () => parsePictureBlock(await read(body, length)) });
        }
        if (head[0] & 0x80) break;
        position = body + length;
    }
    return { raw, pictures, duration };
}

// Streams the packet that starts at `position` across Ogg pages, skipping other logical streams.
function oggPacketStream(read, size, position, serial) {
    let page = null;
    let next = position;

    async function nextPage() {
        for (;;) {
            const head = await read(next, 27);
            if (head.length < 27 || head.toString('latin1', 0, 4) !== 'OggS') throw endOfData();
            const lacing = await read(next + 27, head[26]);
            const bodyStart = next + 27 + head[26];
            next = bodyStart + sum(lacing);
            if (head.readUInt32LE(14) !== serial) continue;
            let left = 0;
            let ended = false;
            for (const value of lacing) {
                left += value;
                if (value < 255) {
                    ended = true;
                    break;
                }
            }
            page = { position: bodyStart, left, ended };
            return;
        }
    }

    async function advance(count, out) {
        if (count > size) throw endOfData();
        let done = 0;
        while (done < count) {
            if (!page || page.left === 0) {
                if (page?.ended) throw endOfData();
                await nextPage();
                continue;
            }
            const chunk = Math.min(count - done, page.left);
            if (out) {
                const data = await read(page.position, chunk);
                if (data.length < chunk) throw endOfData();
                data.copy(out, done);
            }
            done += chunk;
            page.position += chunk;
            page.left -= chunk;
        }
    }

    return {
        async take(count) {
            const out = Buffer.alloc(count);
            await advance(count, out);
            return out;
        },
        skip: (count) => advance(count, null),
    };
}

async function oggDuration(read, size, serial, sampleRate, preSkip) {
    const tail = await read(Math.max(0, size - 64 * 1024), 64 * 1024);
    let at = tail.length;
    while (at > 0 && (at = tail.lastIndexOf('OggS', at - 1)) >= 0) {
        if (tail.length - at < 27 || tail[at + 4] !== 0 || tail.readUInt32LE(at + 14) !== serial) continue;
        const granule = tail.readBigUInt64LE(at + 6);
        if (granule === 0xffffffffffffffffn) continue;
        const seconds = (Number(granule) - preSkip) / sampleRate;
        return seconds > 0 ? seconds : null;
    }
    return null;
}

async function parseOgg(read, size, wantPicture) {
    const first = await read(0, 27 + 255);
    if (first.length < 27 || first.toString('latin1', 0, 4) !== 'OggS') return null;
    const lacing = first.subarray(27, 27 + first[26]);
    const bodyStart = 27 + first[26];
    const serial = first.readUInt32LE(14);
    const ident = await read(bodyStart, 16);
    let sampleRate;
    let preSkip = 0;
    let magic;
    if (ident.toString('latin1', 0, 7) === '\x01vorbis' && ident.length >= 16) {
        sampleRate = ident.readUInt32LE(12);
        magic = '\x03vorbis';
    } else if (ident.toString('latin1', 0, 8) === 'OpusHead' && ident.length >= 12) {
        sampleRate = 48000;
        preSkip = ident.readUInt16LE(10);
        magic = 'OpusTags';
    } else {
        return null;
    }
    const raw = newRaw();
    const pictures = [];
    const stream = oggPacketStream(read, size, bodyStart + sum(lacing), serial);
    try {
        if ((await stream.take(magic.length)).toString('latin1') === magic) {
            await readComments(stream, wantPicture, raw, pictures);
        }
    } catch (error) {
        if (!(error instanceof RangeError)) throw error;
    }
    const duration = sampleRate > 0 ? await oggDuration(read, size, serial, sampleRate, preSkip) : null;
    return { raw, pictures, duration };
}

// --- MP4 ---------------------------------------------------------------------

async function* atoms(read, start, end) {
    let position = start;
    for (let n = 0; n < MAX_ITEMS && position + 8 <= end; n++) {
        const head = await read(position, 16);
        if (head.length < 8) return;
        let length = head.readUInt32BE(0);
        let headerLength = 8;
        if (length === 1) {
            if (head.length < 16) return;
            length = Number(head.readBigUInt64BE(8));
            headerLength = 16;
        } else if (length === 0) {
            length = end - position;
        }
        length = Math.min(length, end - position);
        if (length < headerLength) return;
        yield { type: head.toString('latin1', 4, 8), start: position + headerLength, end: position + length };
        position += length;
    }
}

async function mp4Duration(read, atom) {
    const head = await read(atom.start, 32);
    const long = head[0] === 1;
    if (head.length < (long ? 32 : 20)) return null;
    const timescale = head.readUInt32BE(long ? 20 : 12);
    const units = long ? Number(head.readBigUInt64BE(24)) : head.readUInt32BE(16);
    return timescale > 0 && units > 0 && units !== 0xffffffff ? units / timescale : null;
}

async function readIlstItem(read, item, raw, pictures) {
    for await (const data of atoms(read, item.start, item.end)) {
        if (data.type !== 'data' || data.end - data.start < 8) continue;
        const kind = (await read(data.start, 4)).readUInt32BE(0) & 0xffffff;
        const payloadStart = data.start + 8;
        const payloadLength = data.end - payloadStart;
        if (item.type === 'covr') {
            if (payloadLength > 0) {
                pictures.push({
                    type: 0,
                    load: async () => ({ data: await read(payloadStart, payloadLength), mime: MP4_IMAGE_TYPES[kind] }),
                });
            }
            continue;
        }
        if (payloadLength > MAX_TEXT) continue;
        const payload = await read(payloadStart, payloadLength);
        if (item.type === 'trkn' || item.type === 'disk') {
            if (payload.length >= 4) add(raw, item.type === 'trkn' ? 'track' : 'disc', payload.readUInt16BE(2));
        } else if (item.type === 'cpil') {
            add(raw, 'compilation', payload[0] ? '1' : '');
        } else if (item.type === 'gnre') {
            if (payload.length >= 2) add(raw, 'genre', GENRES[payload.readUInt16BE(0) - 1]);
        } else if (MP4_TEXT_FIELDS[item.type]) {
            add(raw, MP4_TEXT_FIELDS[item.type], payload.toString('utf8'));
        }
    }
}

async function readMeta(read, meta, raw, pictures) {
    const probe = await read(meta.start, 8);
    // QuickTime-style meta atoms have no version/flags word before their children.
    const childrenStart = probe.toString('latin1', 4, 8) === 'hdlr' ? meta.start : meta.start + 4;
    for await (const atom of atoms(read, childrenStart, meta.end)) {
        if (atom.type !== 'ilst') continue;
        for await (const item of atoms(read, atom.start, atom.end)) await readIlstItem(read, item, raw, pictures);
    }
}

async function parseMp4(read, size) {
    const raw = newRaw();
    const pictures = [];
    let duration = null;
    for await (const top of atoms(read, 0, size)) {
        if (top.type !== 'moov') continue;
        for await (const atom of atoms(read, top.start, top.end)) {
            if (atom.type === 'mvhd') {
                duration = await mp4Duration(read, atom);
            } else if (atom.type === 'udta') {
                for await (const child of atoms(read, atom.start, atom.end)) {
                    if (child.type === 'meta') await readMeta(read, child, raw, pictures);
                }
            }
        }
        break;
    }
    return { raw, pictures, duration };
}

// --- WAV ---------------------------------------------------------------------

function readWavInfo(list, raw) {
    for (let position = 0; position + 8 <= list.length;) {
        const id = list.toString('latin1', position, position + 4);
        const length = list.readUInt32LE(position + 4);
        const field = WAV_INFO_FIELDS[id];
        if (field) add(raw, field, decodeLoose(list.subarray(position + 8, position + 8 + length)));
        position += 8 + length + (length & 1);
    }
}

async function parseWav(read, size) {
    let raw = newRaw();
    let pictures = [];
    let id3 = null;
    let byteRate = 0;
    let dataBytes = 0;
    let position = 12;
    for (let n = 0; n < MAX_ITEMS && position + 8 <= size; n++) {
        const head = await read(position, 12);
        const id = head.toString('latin1', 0, 4);
        const length = head.readUInt32LE(4);
        const body = position + 8;
        const available = Math.min(length, size - body);
        if (id === 'fmt ' && available >= 16) {
            byteRate = (await read(body, 16)).readUInt32LE(8);
        } else if (id === 'data') {
            dataBytes = available;
        } else if (id === 'LIST' && available <= MAX_TEXT && head.toString('latin1', 8, 12) === 'INFO') {
            readWavInfo(await read(body + 4, available - 4), raw);
        } else if (id.toLowerCase() === 'id3 ') {
            const header = await readId3v2Header(read, body);
            if (header) id3 = await readId3v2(read, body, header);
        }
        position = body + length + (length & 1);
    }
    if (id3) {
        raw = mergeRaw(id3.raw, raw);
        pictures = id3.pictures;
    }
    return { raw, pictures, duration: byteRate > 0 && dataBytes > 0 ? dataBytes / byteRate : null };
}

// --- ffmpeg ------------------------------------------------------------------

function runFfmpeg(ffmpegPath, args, capture) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(ffmpegPath, args, {
                stdio: ['ignore', capture === 'stdout' ? 'pipe' : 'ignore', capture === 'stderr' ? 'pipe' : 'ignore'],
            });
        } catch {
            return resolve(null);
        }
        const chunks = [];
        let length = 0;
        let failed = false;
        const giveUp = () => {
            failed = true;
            child.kill('SIGKILL');
        };
        const timer = setTimeout(giveUp, FFMPEG_TIMEOUT_MS);
        timer.unref?.();
        child[capture].on('data', (chunk) => {
            length += chunk.length;
            if (length > FFMPEG_MAX_BYTES) giveUp();
            else chunks.push(chunk);
        });
        child.on('error', () => { clearTimeout(timer); resolve(null); });
        child.on('close', () => { clearTimeout(timer); resolve(failed ? null : Buffer.concat(chunks)); });
    });
}

function parseFfmpegInfo(text) {
    const raw = newRaw();
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((line) => /^ {2}Metadata:\s*$/.test(line));
    if (start >= 0) {
        for (const line of lines.slice(start + 1)) {
            if (!line.startsWith('    ')) break;
            const match = /^ {4}(\S[^:]*?)\s*: ?(.*)$/.exec(line);
            const field = match && VORBIS_FIELDS[match[1].toUpperCase()];
            if (field) add(raw, field, match[2]);
        }
    }
    const time = /^\s*Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/m.exec(text);
    const duration = time ? +time[1] * 3600 + +time[2] * 60 + +time[3] : null;
    return { raw, duration, hasPicture: /Stream #\d+:\d+\S*: Video:/.test(text) };
}

async function ffmpegTags(file, ffmpegPath) {
    const output = await runFfmpeg(ffmpegPath, ['-hide_banner', '-nostdin', '-i', `file:${file}`], 'stderr');
    return output ? parseFfmpegInfo(output.toString('utf8')) : null;
}

async function ffmpegPicture(file, ffmpegPath) {
    const output = await runFfmpeg(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', `file:${file}`,
        '-an', '-map', '0:v:0?', '-c:v', 'copy', '-frames:v', '1', '-f', 'image2pipe', 'pipe:1'], 'stdout');
    const mime = output?.length ? sniffImage(output) : null;
    return mime ? { data: output, mime } : null;
}

// --- entry points ------------------------------------------------------------

async function parseFile(read, size, extension, wantPicture) {
    const head = await read(0, 12);
    const magic = head.toString('latin1', 0, 4);
    if (magic === 'OggS') return parseOgg(read, size, wantPicture);
    if (magic === 'fLaC') return parseFlac(read, size, 0);
    if (magic === 'RIFF' && head.toString('latin1', 8, 12) === 'WAVE') return parseWav(read, size);
    if (head.toString('latin1', 4, 8) === 'ftyp') return parseMp4(read, size);
    const id3 = await readId3v2Header(read, 0);
    if (id3 && (await read(id3.total, 4)).toString('latin1') === 'fLaC') return parseFlac(read, size, id3.total);
    if (!id3 && extension !== '.mp3') return null;
    const mp3 = await parseMp3(read, size, id3);
    // An ID3 tag in front of some other format (WavPack, APE) leaves no MPEG audio to measure.
    return extension === '.mp3' || mp3.duration !== null ? mp3 : null;
}

function hasContent({ raw, pictures, duration }) {
    return duration !== null || pictures.length > 0 || Object.values(raw).some((values) => values.length);
}

async function loadPicture(candidates) {
    const ordered = [...candidates.filter((c) => c.type === 3), ...candidates.filter((c) => c.type !== 3)];
    for (const candidate of ordered) {
        const picture = await candidate.load().catch(() => null);
        if (!picture?.data.length) continue;
        return { data: Buffer.from(picture.data), mime: imageMime(picture.data, picture.mime) };
    }
    return null;
}

// Null means the file is not one we parse natively or yielded nothing, so ffmpeg should have a go.
async function parseNative(file, wantPicture) {
    let fh;
    try {
        fh = await fs.open(file, 'r');
        const { size } = await fh.stat();
        const parsed = await parseFile(fileReader(fh, size), size, path.extname(file).toLowerCase(), wantPicture);
        if (!parsed || !hasContent(parsed)) return null;
        return { ...parsed, picture: wantPicture ? await loadPicture(parsed.pictures) : null };
    } catch {
        return null;
    } finally {
        await fh?.close().catch(() => {});
    }
}

const first = (values) => values[0] ?? null;
const joined = (values) => (values.length ? values.join(', ') : null);

function firstNumber(values, pattern) {
    for (const value of values) {
        const match = pattern.exec(value);
        if (match && +match[1] > 0) return +match[1];
    }
    return null;
}

function toTags(raw, duration, hasPicture) {
    return {
        title: first(raw.title),
        artist: joined(raw.artist),
        albumArtist: joined(raw.albumArtist),
        album: first(raw.album),
        track: firstNumber(raw.track, /^\s*(\d{1,5})(?!\d)/),
        disc: firstNumber(raw.disc, /^\s*(\d{1,5})(?!\d)/),
        year: firstNumber(raw.year, /(?<!\d)([12]\d{3})(?!\d)/),
        genre: joined(raw.genre),
        compilation: raw.compilation.some((value) => /^(1|true|yes)$/i.test(value)),
        duration: Number.isFinite(duration) && duration > 0 ? duration : null,
        hasPicture,
    };
}

async function readTags(file, { ffmpegPath = 'ffmpeg' } = {}) {
    try {
        const absolute = path.resolve(String(file));
        const parsed = await parseNative(absolute, false) ?? await ffmpegTags(absolute, ffmpegPath);
        if (parsed) return toTags(parsed.raw, parsed.duration, parsed.hasPicture ?? parsed.pictures.length > 0);
    } catch {
        // A file we cannot read has no tags.
    }
    return toTags(newRaw(), null, false);
}

async function readPicture(file, { ffmpegPath = 'ffmpeg' } = {}) {
    try {
        const absolute = path.resolve(String(file));
        const native = await parseNative(absolute, true);
        return native ? native.picture : await ffmpegPicture(absolute, ffmpegPath);
    } catch {
        return null;
    }
}

module.exports = { readTags, readPicture, AUDIO_EXTENSIONS };
