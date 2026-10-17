// SPDX-License-Identifier: GPL-3.0-only
// Copies the server into app/server and the platform's FFmpeg and librespot into app/bin
// for electron-builder to pick up. Usage: node scripts/stage.js [linux|win|mac-x64|mac-arm64]

const fs = require('node:fs');
const path = require('node:path');
const { bundledBuild } = require('./build');

const root = path.resolve(__dirname, '..', '..', '..');
const out = path.resolve(__dirname, '..', 'app');

// Our own builds (scripts/build-*.sh): FFmpeg under the LGPL v3, with nothing GPL-only or nonfree in
// it, and librespot for Spotify Connect.
const TARGETS = { linux: 'linux-x64', win: 'win-x64', 'mac-x64': 'mac-x64', 'mac-arm64': 'mac-arm64' };
const FILES = {
    ffmpeg: ['ffmpeg', 'ffmpeg-LICENSE.txt', 'ffmpeg-README.txt'],
    librespot: ['librespot', 'librespot-LICENSE.txt'],
};

function stageBuild(tool, target, destination) {
    const build = bundledBuild(tool, target);
    const [program, ...notes] = FILES[tool];
    const exe = target === 'win-x64' ? `${program}.exe` : program;
    fs.mkdirSync(destination, { recursive: true });
    for (const file of [exe, ...notes]) fs.copyFileSync(path.join(build, file), path.join(destination, file));
    fs.chmodSync(path.join(destination, exe), 0o755);
    console.log(`${tool} from ${build}`);
}

function main() {
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

    // Everything except the bundled programs is the same on every platform.
    if (!process.env.WIIJUKEBOX_NO_FFMPEG) stageBuild('ffmpeg', TARGETS[name], path.join(out, 'bin'));
    if (!process.env.WIIJUKEBOX_NO_LIBRESPOT) stageBuild('librespot', TARGETS[name], path.join(out, 'bin'));
    console.log(`staged ${name} in ${out}`);
}

try {
    main();
} catch (err) {
    console.error(err.message);
    process.exit(1);
}
