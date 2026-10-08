// SPDX-License-Identifier: GPL-3.0-only
// Spotify Connect receiver, using librespot (https://github.com/librespot-org/librespot).
//
// librespot appears in the Spotify app's device list as a speaker. It signs in
// with the account that selects it (zeroconf), decodes with the user's own
// Premium subscription and writes raw PCM to stdout, which feeds the pipeline.
// Nothing here touches Spotify's web API or any DRM; playback is controlled
// from the Spotify app itself.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { ReceiverSource } = require('./receiver');
const { configDir } = require('../config');
const { BYTES_PER_SECOND } = require('../core/format');

const EVENT_SCRIPT = path.join(__dirname, 'receiver-event.js');
const MAX_EVENT_BYTES = 64 * 1024;

const shellQuote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;

class SpotifySource extends ReceiverSource {
    static id = 'spotify';
    static label = 'Spotify Connect';
    static binaryName = 'librespot';
    static installHint = 'Install librespot ("cargo install librespot", or your package manager) ' +
        'or set its full path in the Spotify settings.';

    constructor(config = {}, deps = {}) {
        super(config, deps);
        this._runtimeDir = null;
        this._eventServer = null;
        this._session = { user: null, playing: false, track: null };
        this._metadataTimer = null;
    }

    get _deviceName() {
        return String(this.config.deviceName || 'WiiJukebox').slice(0, 50);
    }

    async browse() {
        return {
            items: [{
                id: 'receiver', type: 'station', title: this._deviceName,
                subtitle: 'Start the receiver, then pick it in the Spotify app',
            }],
            total: 1,
        };
    }

    info() {
        return {
            ...super.info(),
            deviceName: this._deviceName,
            user: this._session.user,
            playing: this._session.playing,
            track: this._session.track,
        };
    }

    _idleMetadata() {
        return {
            title: 'Waiting for Spotify',
            artist: `Choose "${this._deviceName}" in the Spotify app`,
            album: '', artwork: null, duration: null,
        };
    }

    async _prepare() {
        if (!this._runtimeDir) {
            this._runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiijukebox-spotify-'));
            await this._listen();
        }
        const cacheDir = path.join(this.deps.configDir || configDir(), 'spotify');
        fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });

        const args = [
            '--name', this._deviceName,
            '--backend', 'pipe',
            '--format', 'S16',
            '--bitrate', String([96, 160, 320].includes(Number(this.config.bitrate)) ? Number(this.config.bitrate) : 320),
            // Level is set by the Wii; the phone's volume slider should not change the stream.
            '--volume-ctrl', 'fixed',
            '--initial-volume', '100',
            '--system-cache', cacheDir,
            '--disable-audio-cache',
        ];
        if (this.config.normalise) args.push('--enable-volume-normalisation');
        const hook = this._writeHook();
        if (hook) args.push('--onevent', hook);
        else this._warn('now-playing details are unavailable because the temporary folder path contains spaces');
        if (Array.isArray(this.config.extraArgs)) {
            args.push(...this.config.extraArgs.filter((arg) => typeof arg === 'string' && arg));
        }
        return { args, env: {} };
    }

    _ipcPath() {
        return process.platform === 'win32'
            ? `\\\\.\\pipe\\wiijukebox-${path.basename(this._runtimeDir)}`
            : path.join(this._runtimeDir, 'events.sock');
    }

    _listen() {
        this._eventServer = net.createServer((socket) => {
            let text = '';
            socket.setEncoding('utf8');
            socket.on('data', (chunk) => {
                text += chunk;
                if (text.length > MAX_EVENT_BYTES) socket.destroy();
            });
            socket.on('end', () => {
                try { this._handleEvent(JSON.parse(text)); } catch { /* ignore malformed hook output */ }
            });
            socket.on('error', () => {});
        });
        return new Promise((resolve, reject) => {
            this._eventServer.once('error', reject);
            this._eventServer.listen(this._ipcPath(), resolve);
        });
    }

    // librespot splits --onevent on whitespace without any quoting.
    _writeHook() {
        const win = process.platform === 'win32';
        const file = path.join(this._runtimeDir, win ? 'onevent.cmd' : 'onevent.sh');
        if (/\s/.test(file)) return null;
        const script = path.join(this._runtimeDir, 'receiver-event.js');
        fs.copyFileSync(EVENT_SCRIPT, script);
        // A packaged desktop app runs this same binary as plain Node.
        const body = win
            ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${script}" "${this._ipcPath()}"\r\n`
            : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(this._ipcPath())}\n`;
        fs.writeFileSync(file, body, { mode: 0o700 });
        return file;
    }

    _handleEvent(event) {
        switch (event.PLAYER_EVENT) {
        case 'session_connected':
            this._session.user = event.USER_NAME || null;
            break;
        case 'track_changed':
            this._session.track = this._trackFrom(event);
            this._announce(this._session.track);
            break;
        case 'playing':
            this._session.playing = true;
            break;
        case 'paused':
            this._session.playing = false;
            break;
        case 'stopped':
        case 'session_disconnected':
            this._session.playing = false;
            if (event.PLAYER_EVENT === 'session_disconnected') {
                this._session.user = null;
                this._session.track = null;
            }
            this._announce(null);
            break;
        default:
        }
    }

    _trackFrom(event) {
        const people = event.ITEM_TYPE === 'Episode' ? event.SHOW_NAME : (event.ARTISTS || '').split('\n').join(', ');
        const cover = (event.COVERS || '').split('\n').find((url) => /^https:\/\//.test(url));
        return {
            title: event.NAME || '',
            artist: people || '',
            album: event.ALBUM || '',
            artwork: cover || null,
        };
    }

    // The pipeline buffers audio before it is heard; hold the label back to match.
    _announce(track) {
        const buffered = this.deps.pipeline?.pacer?.buffered || 0;
        const delay = Math.min(3000, Math.round((buffered / BYTES_PER_SECOND) * 1000));
        clearTimeout(this._metadataTimer);
        this._metadataTimer = setTimeout(() => {
            this._emitMetadata(track ? { ...track, duration: null } : this._idleMetadata());
        }, track ? delay : 0);
        this._metadataTimer.unref?.();
    }

    _onStderr(line) {
        if (/Address already in use|failed to bind|Authentication failed|Bad credentials/i.test(line)) {
            this._warn(line.replace(/^\[[^\]]*\]\s*/, '').slice(0, 200));
        }
    }

    _onStopped() {
        this._session = { user: null, playing: false, track: null };
    }

    async close() {
        clearTimeout(this._metadataTimer);
        await super.close();
        await new Promise((resolve) => (this._eventServer ? this._eventServer.close(resolve) : resolve()));
        this._eventServer = null;
        if (this._runtimeDir) {
            fs.rmSync(this._runtimeDir, { recursive: true, force: true });
            this._runtimeDir = null;
        }
    }
}

module.exports = { SpotifySource };
