// SPDX-License-Identifier: GPL-3.0-only
// Downloads the standalone yt-dlp release (Unlicense) into the app's own folder.

const fs = require('node:fs');
const path = require('node:path');

const ASSETS = {
    'linux-x64': 'yt-dlp_linux',
    'linux-arm64': 'yt-dlp_linux_aarch64',
    'darwin-x64': 'yt-dlp_macos',
    'darwin-arm64': 'yt-dlp_macos',
    'win32-x64': 'yt-dlp.exe',
    'win32-arm64': 'yt-dlp_arm64.exe',
};

function assetName() {
    return ASSETS[`${process.platform}-${process.arch}`] || null;
}

async function installYtdlp(binDir, fetchImpl = fetch) {
    const asset = assetName();
    if (!asset) throw new Error(`no yt-dlp download for ${process.platform}/${process.arch}`);
    const res = await fetchImpl(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`);
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    // A small body is an error page, not a program.
    if (bytes.length < 1_000_000) throw new Error('download was too small to be yt-dlp');
    fs.mkdirSync(binDir, { recursive: true });
    const target = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    const partial = `${target}.part`;
    fs.writeFileSync(partial, bytes, { mode: 0o755 });
    fs.renameSync(partial, target);
    return target;
}

module.exports = { installYtdlp, assetName };
