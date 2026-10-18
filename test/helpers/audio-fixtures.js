// SPDX-License-Identifier: GPL-3.0-only
// Tiny real audio files made with the system ffmpeg. makeAudioFixture(dir, name, { format, seconds, tags, cover,
// id3v2Version, extraArgs }) returns the absolute path; skipReason(format) is a string when a test should skip.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const FORMATS = {
    mp3: { encoder: 'libmp3lame', args: ['-c:a', 'libmp3lame', '-b:a', '128k'] },
    flac: { encoder: 'flac', args: ['-c:a', 'flac'] },
    ogg: { encoder: 'libvorbis', args: ['-c:a', 'libvorbis'] },
    opus: { encoder: 'libopus', args: ['-c:a', 'libopus'] },
    m4a: { encoder: 'aac', args: ['-c:a', 'aac', '-b:a', '128k'] },
    wav: { encoder: 'pcm_s16le', args: ['-c:a', 'pcm_s16le'] },
    aiff: { encoder: 'pcm_s16be', args: ['-c:a', 'pcm_s16be'] },
    mka: { encoder: 'flac', args: ['-c:a', 'flac'] },
};

let encoders;
function hasEncoder(name) {
    if (!encoders) {
        const { stdout, status } = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
        encoders = new Set(status === 0 ? [...stdout.matchAll(/^ [A-Z.]{6} (\S+)/gm)].map((match) => match[1]) : []);
    }
    return encoders.has(name);
}

function hasFfmpeg() {
    return spawnSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' }).status === 0;
}

function skipReason(format) {
    if (!hasFfmpeg()) return 'ffmpeg is not installed';
    const { encoder } = FORMATS[format];
    return hasEncoder(encoder) ? false : `this ffmpeg has no ${encoder} encoder`;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function pngChunk(type, data) {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    let crc = 0xffffffff;
    for (const byte of body) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const head = Buffer.alloc(4);
    const tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, body, tail]);
}

/** A valid PNG: solid red, or incompressible noise when a cover must be large. */
function makePng({ width = 8, height = 8, noise = false } = {}) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 2, 0, 0, 0], 8);
    const rows = Buffer.alloc((1 + width * 3) * height);
    let seed = 0x2545f491;
    for (let i = 0; i < rows.length; i++) {
        const column = i % (1 + width * 3) - 1;
        if (column < 0) continue;
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        rows[i] = noise ? seed & 0xff : column % 3 === 0 ? 0xff : 0;
    }
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', header),
        pngChunk('IDAT', zlib.deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}

/** A FLAC PICTURE block body, which Ogg files carry base64-encoded in METADATA_BLOCK_PICTURE. */
function pictureBlock(image, { type = 3, mime = 'image/png' } = {}) {
    const mimeBytes = Buffer.from(mime, 'latin1');
    const head = Buffer.alloc(8 + mimeBytes.length + 4 + 16 + 4);
    head.writeUInt32BE(type, 0);
    head.writeUInt32BE(mimeBytes.length, 4);
    mimeBytes.copy(head, 8);
    head.writeUInt32BE(image.length, head.length - 4);
    return Buffer.concat([head, image]);
}

/**
 * `tags` are ffmpeg metadata keys; a cover is PNG bytes (under 90 KB for ogg and opus, which pass it on the
 * command line). `id3v2Version` 3 or 4 picks the mp3 tag and turns on aiff's ID3 chunk; 0 writes no mp3 ID3v2 tag.
 */
function makeAudioFixture(dir, name, options = {}) {
    const { seconds = 2, tags = {}, cover = null, id3v2Version, extraArgs = [] } = options;
    let { format } = options;
    format ??= path.extname(name).slice(1);
    if (!FORMATS[format]) throw new Error(`unknown fixture format ${format}`);
    const file = path.resolve(dir, name.endsWith(`.${format}`) ? name : `${name}.${format}`);
    const coverFile = path.join(dir, `.cover-${process.pid}-${path.basename(file)}.png`);
    const metadata = { ...tags };
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`];
    const embedded = cover && (format === 'ogg' || format === 'opus');
    if (embedded) metadata.METADATA_BLOCK_PICTURE = pictureBlock(cover).toString('base64');
    if (cover && !embedded) {
        fs.writeFileSync(coverFile, cover);
        args.push('-i', coverFile, '-map', '0:a', '-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic');
    }
    args.push(...FORMATS[format].args);
    if (id3v2Version !== undefined) {
        args.push('-id3v2_version', String(id3v2Version));
        if (format === 'aiff') args.push('-write_id3v2', '1');
    }
    for (const [key, value] of Object.entries(metadata)) args.push('-metadata', `${key}=${value}`);
    args.push(...extraArgs, `file:${file}`);
    try {
        const { status, stderr } = spawnSync('ffmpeg', args, { encoding: 'utf8' });
        if (status !== 0) throw new Error(`ffmpeg failed making ${file}: ${stderr}`);
    } finally {
        fs.rmSync(coverFile, { force: true });
    }
    return file;
}

module.exports = { makeAudioFixture, makePng, pictureBlock, skipReason, hasFfmpeg };
