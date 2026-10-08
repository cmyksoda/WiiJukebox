// SPDX-License-Identifier: GPL-3.0-only
// Copies the server into app/server and fetches the platform's FFmpeg into app/bin
// for electron-builder to pick up. Usage: node scripts/stage.js [linux|win|mac-x64|mac-arm64]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..', '..');
const out = path.resolve(__dirname, '..', 'app');
const cache = path.join(os.homedir(), '.cache', 'wiijukebox-desktop');

// Every build is GPL v3 with the MP3 encoder (libmp3lame) the stream needs. Each download is pinned
// by checksum. eugeneware's macOS arm64 build is configured --enable-nonfree and may not be
// redistributed, so macOS uses Jellyfin's builds, which are open and GPL.
const EUGENE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1';
const JELLYFIN = 'https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v8.1.3-1';
const JELLYFIN_TAG = 'https://raw.githubusercontent.com/jellyfin/jellyfin-ffmpeg/v8.1.3-1';
const TARGETS = {
    linux: { exe: 'ffmpeg', eugene: 'linux-x64', sha256: 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa' },
    win: { exe: 'ffmpeg.exe', eugene: 'win32-x64', sha256: '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77' },
    'mac-x64': { exe: 'ffmpeg', jellyfin: 'mac64', sha256: 'cb2b5c154d49a6b6bfe29fa6c16510e85dcbf60b805764121a167b093d4bb6fb' },
    'mac-arm64': { exe: 'ffmpeg', jellyfin: 'macarm64', sha256: '22445d7299742749ad2eeb9ce87963d50def0357e45b3e6c7b69987c8365dbf6' },
};
const JELLYFIN_LICENSE_SHA256 = '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903';

async function download(url, file, sha256) {
    if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (sha256 && actual !== sha256) {
        fs.rmSync(file);
        throw new Error(`${path.basename(file)} checksum mismatch: ${actual}`);
    }
    return actual;
}

async function stageEugene(target, destination) {
    const name = `ffmpeg-${target.eugene}.gz`;
    const gz = path.join(cache, name);
    console.log(`${name} sha256 ${await download(`${EUGENE}/${name}`, gz, target.sha256)}`);
    fs.writeFileSync(path.join(destination, target.exe), zlib.gunzipSync(fs.readFileSync(gz)), { mode: 0o755 });
    for (const kind of ['LICENSE', 'README']) {
        const note = path.join(cache, `${target.eugene}.${kind}`);
        await download(`${EUGENE}/${target.eugene}.${kind}`, note);
        fs.copyFileSync(note, path.join(destination, `ffmpeg-${kind}.txt`));
    }
}

async function stageJellyfin(target, destination) {
    const name = `jellyfin-ffmpeg_8.1.3-1_portable_${target.jellyfin}-gpl.tar.xz`;
    const archive = path.join(cache, name);
    console.log(`${name} sha256 ${await download(`${JELLYFIN}/${name}`, archive, target.sha256)}`);
    execFileSync('tar', ['-xJf', archive, '-C', destination, target.exe]);
    const license = path.join(cache, 'jellyfin-ffmpeg-COPYING.GPLv3');
    await download(`${JELLYFIN_TAG}/COPYING.GPLv3`, license, JELLYFIN_LICENSE_SHA256);
    fs.copyFileSync(license, path.join(destination, 'ffmpeg-LICENSE.txt'));
    fs.writeFileSync(path.join(destination, 'ffmpeg-README.txt'), [
        'FFmpeg 8.1.3 (Jellyfin build), licensed GPL v3 (see ffmpeg-LICENSE.txt).',
        'Source code and build scripts: https://github.com/jellyfin/jellyfin-ffmpeg/tree/v8.1.3-1',
        `Binary: ${JELLYFIN}/${name}`,
        '',
    ].join('\n'));
}

async function stageFfmpeg(target, destination) {
    fs.mkdirSync(destination, { recursive: true });
    await (target.eugene ? stageEugene : stageJellyfin)(target, destination);
    fs.chmodSync(path.join(destination, target.exe), 0o755);
}

async function main() {
    const name = process.argv[2] || 'linux';
    if (!TARGETS[name]) throw new Error(`unknown target ${name}; use ${Object.keys(TARGETS).join(', ')}`);
    fs.rmSync(out, { recursive: true, force: true });

    const server = path.join(out, 'server');
    fs.mkdirSync(server, { recursive: true });
    for (const entry of ['src', 'public']) fs.cpSync(path.join(root, entry), path.join(server, entry), { recursive: true });
    for (const file of ['package.json', 'LICENSE']) fs.copyFileSync(path.join(root, file), path.join(server, file));
    if (!fs.existsSync(path.join(server, 'public', 'vendor', 'butterchurn.min.js'))) {
        throw new Error('public/vendor is missing; run "npm ci" in the repository root first');
    }

    // Everything except FFmpeg is the same on every platform.
    if (!process.env.WIIJUKEBOX_NO_FFMPEG) await stageFfmpeg(TARGETS[name], path.join(out, 'bin'));
    console.log(`staged ${name} in ${out}`);
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
