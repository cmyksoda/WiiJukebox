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
 * Search order: explicit overrides, the app's own copies, PATH, then common folders. The bundled FFmpeg
 * leads because a system build can lack the MP3 encoder; the app's yt-dlp so that updating it takes effect.
 * With `useBundled` off the included folder is skipped, so only the computer's own FFmpeg can be found.
 */
function searchPath({ bundledDir, userBinDir, overrides = {}, useBundled = true }) {
    const forced = [overrides.ffmpeg, overrides.ytdlp].filter(Boolean).map((file) => path.dirname(file));
    const fromEnv = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const own = useBundled ? [bundledDir, userBinDir] : [userBinDir];
    return [...new Set([...forced, ...own, ...fromEnv, ...extraDirectories()].filter(Boolean))];
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

/** Some distro builds leave the MP3 encoder out, and the stream cannot be made without it. */
function canEncodeMp3(file) {
    return new Promise((resolve) => {
        execFile(file, ['-hide_banner', '-encoders'], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
            resolve(!err && /\blibmp3lame\b/.test(String(stdout)));
        });
    });
}

/** "7.0.2" from a banner such as "ffmpeg version 7.0.2-static https://...", or null for a development build. */
function ffmpegVersionNumber(banner) {
    return /version\s+n?(\d+(?:\.\d+)*)/.exec(banner || '')?.[1] ?? null;
}

/** Why the FFmpeg that was found cannot run the stream: 'none' when there is no working one, 'no-mp3' without the encoder. */
function ffmpegProblem(ffmpeg) {
    if (!ffmpeg) return 'none';
    return ffmpeg.mp3 ? null : 'no-mp3';
}

/**
 * An override names the one program to use; if it does not exist the tool counts as
 * missing, which is also how tests simulate a missing install without touching PATH.
 * @returns {Promise<{ffmpeg: {path: string, version: string, mp3: boolean}|null, ytdlp: object|null, dirs: string[]}>}
 */
async function detect(dirs, overrides = {}) {
    const pick = (override, name) => (override ? (isExecutable(override) ? override : null) : findTool(name, dirs));
    const ffmpegPath = pick(overrides.ffmpeg, 'ffmpeg');
    const ytdlpPath = pick(overrides.ytdlp, 'yt-dlp');
    const [ffmpegVersion, mp3, ytdlpVersion] = await Promise.all([
        ffmpegPath ? version(ffmpegPath, ['-version']) : null,
        ffmpegPath ? canEncodeMp3(ffmpegPath) : false,
        ytdlpPath ? version(ytdlpPath, ['--version']) : null,
    ]);
    return {
        ffmpeg: ffmpegVersion ? { path: ffmpegPath, version: ffmpegVersion, mp3 } : null,
        ytdlp: ytdlpVersion ? { path: ytdlpPath, version: ytdlpVersion } : null,
        dirs,
    };
}

module.exports = { detect, searchPath, findTool, canEncodeMp3, ffmpegVersionNumber, ffmpegProblem, EXE };
