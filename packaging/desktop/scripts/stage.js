// SPDX-License-Identifier: GPL-3.0-only
// Copies the server into app/server and fetches the platform's FFmpeg into app/bin
// for electron-builder to pick up. Usage: node scripts/stage.js [linux|win|mac|mac-arm64]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..', '..', '..');
const out = path.resolve(__dirname, '..', 'app');
const cache = path.join(os.homedir(), '.cache', 'wiijukebox-desktop');
const TARGETS = {
    linux: { suffix: 'linux-x64', exe: 'ffmpeg' },
    win: { suffix: 'win32-x64', exe: 'ffmpeg.exe' },
    mac: { suffix: 'darwin-x64', exe: 'ffmpeg' },
    'mac-arm64': { suffix: 'darwin-arm64', exe: 'ffmpeg' },
};
// eugeneware/ffmpeg-static release b6.1.1 (FFmpeg 6.1.1, GPL build with libmp3lame).
const FFMPEG_BASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1';
const SHA256 = {
    'linux-x64': process.env.FFMPEG_SHA_LINUX,
    'win32-x64': process.env.FFMPEG_SHA_WIN,
    'darwin-x64': process.env.FFMPEG_SHA_MAC,
    'darwin-arm64': process.env.FFMPEG_SHA_MAC_ARM64,
};

async function download(url, file) {
    if (fs.existsSync(file)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

async function stageFfmpeg(target, destination) {
    const { suffix, exe } = TARGETS[target];
    const gz = path.join(cache, `ffmpeg-${suffix}.gz`);
    await download(`${FFMPEG_BASE}/ffmpeg-${suffix}.gz`, gz);
    const expected = SHA256[suffix];
    const actual = crypto.createHash('sha256').update(fs.readFileSync(gz)).digest('hex');
    if (expected && expected !== actual) throw new Error(`ffmpeg-${suffix}.gz checksum mismatch: ${actual}`);
    console.log(`ffmpeg-${suffix}.gz sha256 ${actual}`);
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, exe), zlib.gunzipSync(fs.readFileSync(gz)), { mode: 0o755 });
    for (const kind of ['LICENSE', 'README']) {
        const note = path.join(cache, `${suffix}.${kind}`);
        await download(`${FFMPEG_BASE}/${suffix}.${kind}`, note);
        fs.copyFileSync(note, path.join(destination, `ffmpeg-${kind}.txt`));
    }
}

async function main() {
    const target = process.argv[2] || 'linux';
    if (!TARGETS[target]) throw new Error(`unknown target ${target}`);
    fs.rmSync(out, { recursive: true, force: true });

    const server = path.join(out, 'server');
    fs.mkdirSync(server, { recursive: true });
    for (const entry of ['src', 'public']) fs.cpSync(path.join(root, entry), path.join(server, entry), { recursive: true });
    for (const file of ['package.json', 'LICENSE']) fs.copyFileSync(path.join(root, file), path.join(server, file));
    if (!fs.existsSync(path.join(server, 'public', 'vendor', 'butterchurn.min.js'))) {
        throw new Error('public/vendor is missing; run "npm ci" in the repository root first');
    }

    // Everything except FFmpeg is the same on every platform.
    if (!process.env.WIIJUKEBOX_NO_FFMPEG) await stageFfmpeg(target, path.join(out, 'bin'));
    console.log(`staged ${target} in ${out}`);
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
