// SPDX-License-Identifier: GPL-3.0-only
// A stand-in Subsonic server with one album, so the smoke test and screenshot scripts can play something
// without a library. Its tracks are a quiet tone that only goes to whatever listens to the server's stream.

const http = require('node:http');
const { execFile } = require('node:child_process');

const ALBUM = [
    ['Rain on the Roof', 'Wii Quartet'],
    ['Channel Surfing', 'Wii Quartet'],
    ['Lobby Music', 'Wii Quartet'],
    ['Night Mode', 'Wii Quartet'],
    ['Last Call', 'Wii Quartet'],
];

function tone(ffmpeg) {
    return new Promise((resolve, reject) => {
        const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=40',
            '-filter:a', 'volume=0.05', '-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'mp3', '-'];
        execFile(ffmpeg, args, { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
}

/** Resolves with { url, close }; `ffmpeg` is the program that makes the tone. */
async function startFakeSubsonic(ffmpeg) {
    const audio = await tone(ffmpeg);
    const songs = ALBUM.map(([title, artist], i) => ({ id: `song-${i + 1}`, title, artist, album: 'Living Room Sessions', duration: 40 }));
    const server = http.createServer((req, res) => {
        const endpoint = new URL(req.url, 'http://fake').pathname.split('/').pop();
        if (endpoint === 'stream.view') {
            res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length });
            return res.end(audio);
        }
        const response = { status: 'ok', version: '1.16.1' };
        if (endpoint === 'getAlbum.view') response.album = { song: songs };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ 'subsonic-response': response }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        songs,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

module.exports = { startFakeSubsonic };
