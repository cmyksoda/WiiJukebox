// SPDX-License-Identifier: GPL-3.0-only
// Finds ffmpeg and yt-dlp, which the server runs as separate programs.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : '';

// GUI apps start with a short PATH, so check where installers and package managers put things.
function extraDirectories() {
    const home = os.homedir();
    if (WIN) {
        const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        return [
            path.join(home, 'scoop', 'shims'),
            path.join(local, 'Microsoft', 'WinGet', 'Links'),
            'C:\\ProgramData\\chocolatey\\bin',
            'C:\\Program Files\\ffmpeg\\bin',
            'C:\\ffmpeg\\bin',
        ];
    }
    return ['/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin', path.join(home, '.local', 'bin')];
}

function isExecutable(file) {
    try {
        if (!fs.statSync(file).isFile()) return false;
        fs.accessSync(file, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Directories searched, in order: folders of any explicit overrides, the app's own copies,
 * the user's PATH, then common locations. The bundled FFmpeg comes first because a system
 * build can lack the MP3 encoder the stream needs, and the app-managed yt-dlp first so that
 * updating it takes effect.
 */
function searchPath({ bundledDir, userBinDir, overrides = {} }) {
    const forced = [overrides.ffmpeg, overrides.ytdlp].filter(Boolean).map((file) => path.dirname(file));
    const fromEnv = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    return [...new Set([...forced, bundledDir, userBinDir, ...fromEnv, ...extraDirectories()].filter(Boolean))];
}

function findTool(name, dirs) {
    for (const dir of dirs) {
        const file = path.join(dir, name + EXE);
        if (isExecutable(file)) return file;
    }
    return null;
}

function version(file, args) {
    return new Promise((resolve) => {
        execFile(file, args, { timeout: 8000 }, (err, stdout) => {
            resolve(err ? null : String(stdout).split('\n')[0].trim());
        });
    });
}

/**
 * An override names the one program to use; if it does not exist the tool counts as
 * missing, which is also how tests simulate a missing install without touching PATH.
 * @returns {Promise<{ffmpeg: object|null, ytdlp: object|null, dirs: string[]}>}
 */
async function detect(dirs, overrides = {}) {
    const pick = (override, name) => (override ? (isExecutable(override) ? override : null) : findTool(name, dirs));
    const ffmpegPath = pick(overrides.ffmpeg, 'ffmpeg');
    const ytdlpPath = pick(overrides.ytdlp, 'yt-dlp');
    const [ffmpegVersion, ytdlpVersion] = await Promise.all([
        ffmpegPath ? version(ffmpegPath, ['-version']) : null,
        ytdlpPath ? version(ytdlpPath, ['--version']) : null,
    ]);
    return {
        ffmpeg: ffmpegVersion ? { path: ffmpegPath, version: ffmpegVersion } : null,
        ytdlp: ytdlpVersion ? { path: ytdlpPath, version: ytdlpVersion } : null,
        dirs,
    };
}

module.exports = { detect, searchPath, findTool, EXE };
