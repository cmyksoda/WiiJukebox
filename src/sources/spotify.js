// SPDX-License-Identifier: GPL-3.0-only
// Spotify through librespot (https://github.com/librespot-org/librespot) as the audio receiver, plus the
// Spotify Web API for browsing the library and for play, pause and skip. Spotify owns the queue.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ReceiverSource } = require('./receiver');
const { SpotifyApi, SpotifyError, authorizeUrl, pkcePair, redirectUriFor, CALLBACK_PATH } = require('./spotify-api');
const { SpotifyLibrary } = require('./spotify-library');
const { configDir } = require('../config');
const { BYTES_PER_SECOND } = require('../core/format');

const EVENT_SCRIPT = path.join(__dirname, 'receiver-event.js');
const MAX_EVENT_BYTES = 64 * 1024;

const REPEAT_STATE = { off: 'off', all: 'context', one: 'track' };
const LOGIN_TTL_MS = 10 * 60 * 1000;
const DEVICE_TTL_MS = 5 * 60 * 1000;
const MIN_PCM_BYTES = 8192;
const PLAY_ATTEMPTS = 3;
const TIMING = {
    pollMs: 3000,
    confirmPollMs: 600,
    confirmMs: 15000,
    deviceRetryMs: 1000,
    // A receiver that is already running shows up fast; a fresh one is still signing in.
    deviceWaitMs: 4000,
    deviceStartWaitMs: 25000,
};

const shellQuote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isLibraryItem = (item) => Boolean(item) && item.type !== 'station' && item.id !== 'receiver';
const ignoreRestricted = (err) => {
    if (err.kind !== 'restricted') throw err;
};

class SpotifySource extends ReceiverSource {
    static id = 'spotify';
    static label = 'Spotify Connect';
    static binaryName = 'librespot';
    static installHint = 'Install librespot ("cargo install librespot", or your package manager) ' +
        'or set its full path in the Spotify settings.';
    // Play, pause, next and previous go to Spotify, which owns the queue; nothing here advances a local one.
    static remoteControl = true;

    constructor(config = {}, deps = {}) {
        super(config, deps);
        this._runtimeDir = null;
        this._eventServer = null;
        this._session = { user: null, playing: false, track: null };
        this._metadataTimer = null;

        this._timing = { ...TIMING, ...deps.spotify?.timing };
        this._account = config.account || '';
        this._reconnect = Boolean(config.reconnect);
        this._api = new SpotifyApi({
            clientId: String(config.clientId || '').trim(), refreshToken: config.refreshToken || null,
            onRefreshToken: (refreshToken) => this.emit('credentials', { refreshToken }),
            onRevoked: () => this._revoked(),
            fetchImpl: deps.fetch, accountsBase: deps.spotify?.accountsBase, apiBase: deps.spotify?.apiBase,
        });
        this._library = new SpotifyLibrary(this._api);
        this._logins = new Map();

        // Set once the receiver is wired to the pipeline and Spotify may be commanded.
        this._attached = false;
        this._receiver = null;
        this._paused = null;
        this._busy = 0;
        this._poller = null;
        this._pcmBytes = 0;
        this._modes = { shuffle: false, repeat: 'off' };
    }

    get _deviceName() {
        return String(this.config.deviceName || 'WiiJukebox').slice(0, 50);
    }

    get auth() {
        if (!this._api.clientId) return 'no-client-id';
        if (this._reconnect) return 'reconnect';
        return this._api.hasToken ? 'connected' : 'not-connected';
    }

    get redirectUri() {
        return redirectUriFor(this.deps.serverPort);
    }

    get capabilities() {
        const caps = { stop: true, browse: true };
        if (this.auth !== 'connected') return caps;
        caps.search = true;
        if (this._attached) {
            Object.assign(caps, { play: true, pause: true, next: true, previous: true, shuffle: true, repeat: true });
        }
        return caps;
    }

    // What the connection test needs to see.
    get api() { return this._api; }
    get library() { return this._library; }
    get deviceName() { return this._deviceName; }
    get receiverRunning() { return Boolean(this._child); }
    get pcmBytes() { return this._pcmBytes; }

    findReceiver(waitMs) {
        this._receiver = null;
        return this._findDevice(waitMs);
    }

    playItem(item) {
        const pipeline = this.deps.pipeline;
        if (!pipeline) throw new Error('the stream is not running');
        return pipeline.command(() => pipeline.attach(this, item));
    }

    _receiverItem(subtitle = 'Start the receiver, then pick it in the Spotify app') {
        return { id: 'receiver', type: 'station', title: this._deviceName, subtitle };
    }

    async browse({ path: where = '', offset = 0, limit = 100 } = {}) {
        if (this.auth !== 'connected') return { items: [this._receiverItem()], total: 1 };
        if (where) return this._library.browse({ path: where, offset, limit });
        const roots = [
            { id: 'liked', type: 'playlist', title: 'Liked Songs', subtitle: 'Songs you saved' },
            { id: 'playlists', type: 'folder', title: 'Playlists' },
            { id: 'albums', type: 'folder', title: 'Albums' },
            this._receiverItem('Receiver for the Spotify app'),
        ];
        return { items: roots.slice(offset, offset + limit), total: roots.length };
    }

    async search(query) {
        if (this.auth !== 'connected' || !String(query).trim()) return { items: [], total: 0 };
        return this._library.search(String(query).trim());
    }

    info() {
        const redirectUri = this.redirectUri;
        return {
            ...super.info(),
            deviceName: this._deviceName,
            user: this._session.user,
            playing: this._session.playing,
            track: this._session.track,
            web: {
                state: this.auth, account: this._account, redirectUri,
                loginUrl: redirectUri && redirectUri.replace(CALLBACK_PATH, '/api/spotify/login'),
                message: this.auth === 'connected' ? '' : new SpotifyError(this.auth).message,
            },
        };
    }

    // --- signing in ---------------------------------------------------------------

    beginLogin() {
        if (!this._api.clientId) throw new SpotifyError('no-client-id');
        const redirectUri = this.redirectUri;
        if (!redirectUri) throw new Error('the server address is not known yet');
        const now = Date.now();
        for (const [key, entry] of this._logins) if (entry.expires < now) this._logins.delete(key);
        const state = crypto.randomBytes(16).toString('hex');
        const { verifier, challenge } = pkcePair();
        this._logins.set(state, { verifier, redirectUri, expires: now + LOGIN_TTL_MS });
        const base = this.deps.spotify?.accountsBase;
        return authorizeUrl({ clientId: this._api.clientId, redirectUri, state, challenge, base });
    }

    /** Finishes a sign-in from the query Spotify sent back; throws a message fit for the callback page. */
    async completeLogin({ code, state, error }) {
        const entry = this._logins.get(state);
        this._logins.delete(state);
        const again = 'Start again from the Spotify settings.';
        if (!entry || entry.expires < Date.now()) throw new Error(`This sign-in link expired or was already used. ${again}`);
        if (error) {
            throw new Error(error === 'access_denied'
                ? 'Spotify access was declined.' : `Spotify sign-in failed (${this._api.clean(error)}).`);
        }
        if (!code) throw new Error(`Spotify sent no sign-in code. ${again}`);
        const refreshToken = await this._api.exchange(code, entry.verifier, entry.redirectUri);
        try {
            const me = await this._api.me();
            this._account = me.display_name || me.id || 'Spotify account';
        } catch (err) {
            this._api.forget();
            throw err;
        }
        this._reconnect = false;
        this._library.forget();
        this.emit('credentials', { refreshToken, account: this._account, reconnect: false });
        this._authChanged();
    }

    _revoked() {
        this._reconnect = true;
        this._library.forget();
        this.emit('credentials', { refreshToken: null, reconnect: true });
        this._authChanged();
        this._warn(new SpotifyError('reconnect').message);
    }

    // The controls on offer follow the sign-in, so whoever shows them is told to look again.
    _authChanged() {
        this.emit('state', { state: this.state });
    }

    _requireAuth() {
        if (this.auth !== 'connected') throw new SpotifyError(this.auth);
    }

    async action(name, body = {}) {
        if (name === 'disconnect-account') {
            this._api.forget();
            this._library.forget();
            this._account = '';
            this._reconnect = false;
            this.emit('credentials', { refreshToken: null, account: '', reconnect: false });
            this._authChanged();
            return { ok: true };
        }
        if (name === 'proof') {
            const { play, track, wait } = body;
            const waitMs = Math.min(Number(wait) || 30, 300) * 1000;
            return { steps: await require('./spotify-proof').runProof(this, { play: play === true, track, waitMs }) };
        }
        throw new Error(`${this.label} has no such action`);
    }

    // --- playing and controlling ----------------------------------------------------

    async open(item) {
        if (!isLibraryItem(item)) {
            const handle = await super.open(item);
            // With an account signed in, the receiver started by hand can also be commanded from here.
            if (this.auth === 'connected') this._wire();
            return handle;
        }
        this._requireAuth();
        this._attached = false;
        const handle = await this._openReceiver({ primed: false });
        try {
            await this._command(() => this._select(item, { starting: true }));
        } catch (err) {
            await this.close();
            throw err;
        }
        this._wire();
        return handle;
    }

    canRetarget(item) {
        return this._attached && Boolean(this._child) && isLibraryItem(item);
    }

    canReplay(item) {
        return isLibraryItem(item);
    }

    /** A restart brings the receiver back but does not start music on its own account. */
    restoreItem(item) {
        return isLibraryItem(item) ? this._receiverItem() : item;
    }

    /** Points the running receiver at another song, album or playlist and waits until it plays. */
    async retarget(item) {
        this._requireAuth();
        await this._command(() => this._select(item, { starting: false }));
    }

    async play() {
        return this._command(async () => {
            const device = await this._findDevice();
            const mark = this._pcmBytes;
            await this._api.startPlayback(device.id).catch(ignoreRestricted);
            await this._confirm(device, (state) => state.is_playing && this._flowing(mark), 'resume playing');
        });
    }

    async pause() {
        return this._command(async () => {
            const device = await this._findDevice();
            await this._api.pause(device.id).catch(ignoreRestricted);
            await this._confirm(device, (state) => !state.is_playing, 'pause');
        });
    }

    next() {
        return this._skip('next');
    }

    previous() {
        return this._skip('previous');
    }

    async setShuffle(on) {
        this._modes.shuffle = Boolean(on);
        if (this._attached) await this._command(async () => this._api.setShuffle(on, (await this._findDevice()).id));
    }

    async setRepeat(mode) {
        this._modes.repeat = mode;
        if (this._attached) {
            await this._command(async () => this._api.setRepeat(REPEAT_STATE[mode] || 'off', (await this._findDevice()).id));
        }
    }

    async _skip(direction) {
        return this._command(async () => {
            const device = await this._findDevice();
            const before = await this._api.playerState();
            const blocked = before?.actions?.disallows?.[direction === 'next' ? 'skipping_next' : 'skipping_prev'];
            if (blocked) return { endOfQueue: true };
            const mark = this._pcmBytes;
            await this._api.skip(direction, device.id);
            this.emit('discontinuity');
            const was = before?.item?.uri;
            // Previous deep into a song starts it over instead of moving back.
            const moved = (state) => state.item?.uri !== was ||
                (direction === 'previous' && state.progress_ms < (before?.progress_ms ?? 0) - 1500);
            const what = direction === 'next' ? 'skip to the next song' : 'go back';
            await this._confirm(device, (state) => state.is_playing && moved(state) && this._flowing(mark), what);
            return {};
        });
    }

    /** Sends the selection to Spotify and returns once the player reports it playing. */
    async _select(item, { starting }) {
        const target = await this._library.target(item);
        const wait = starting ? this._timing.deviceStartWaitMs : this._timing.deviceWaitMs;
        let device = await this._findDevice(wait);
        const mark = this._pcmBytes;
        // A receiver can be listed a moment before it takes commands, and device ids can change.
        for (let attempt = 1; ; attempt++) {
            try {
                await this._api.startPlayback(device.id, target.body);
                break;
            } catch (err) {
                if (err.kind !== 'no-device' || attempt >= PLAY_ATTEMPTS) throw err;
                this._receiver = null;
                await sleep(this._timing.deviceRetryMs);
                device = await this._findDevice(wait);
            }
        }
        if (!starting) this.emit('discontinuity');
        // A relinked track is reported under the uri it was relinked from.
        const isTarget = (now) => (target.itemUri
            ? [now.item?.uri, now.item?.linked_from?.uri].includes(target.itemUri)
            : now.context?.uri === target.contextUri);
        const accept = (now) => now.is_playing && this._flowing(mark) && isTarget(now);
        const state = await this._confirm(device, accept, 'start playing that');
        await this._syncModes(device, state);
    }

    // Shuffle and repeat are applied once playing; an idle receiver refuses them.
    async _syncModes(device, state) {
        try {
            if (state.shuffle_state !== this._modes.shuffle) {
                await this._api.setShuffle(this._modes.shuffle, device.id);
            }
            const repeat = REPEAT_STATE[this._modes.repeat] || 'off';
            if (state.repeat_state !== repeat) await this._api.setRepeat(repeat, device.id);
        } catch (err) {
            this._warn(`could not set shuffle or repeat: ${err.message}`);
        }
    }

    /** Polls the player until `accept(state)` holds for the receiver: a command is done when the audio is. */
    async _confirm(device, accept, what) {
        const deadline = Date.now() + this._timing.confirmMs;
        for (;;) {
            const state = await this._api.playerState();
            const here = state?.device?.name === this._deviceName;
            this._mirror(state);
            if (state && here && accept(state)) return state;
            if (Date.now() >= deadline) {
                throw new SpotifyError('timeout', `Spotify did not ${what} on "${device.name}" in time. ` +
                    'Check the Spotify app, and that the receiver uses this Spotify account.');
            }
            await sleep(this._timing.confirmPollMs);
        }
    }

    _flowing(mark) {
        return this._pcmBytes - mark >= MIN_PCM_BYTES;
    }

    async _findDevice(wait = this._timing.deviceWaitMs) {
        if (this._receiver && Date.now() - this._receiver.at < DEVICE_TTL_MS) return this._receiver.device;
        const deadline = Date.now() + wait;
        for (;;) {
            const devices = await this._api.devices();
            const named = devices.filter((device) => device.id && device.name === this._deviceName);
            const usable = named.filter((device) => !device.is_restricted);
            if (usable.length) {
                const device = usable.find((candidate) => candidate.is_active) || usable[0];
                this._receiver = { device, at: Date.now() };
                return device;
            }
            if (named.length) {
                throw new SpotifyError('device-not-found',
                    `Spotify lists "${this._deviceName}" but does not allow it to be controlled.`);
            }
            if (Date.now() >= deadline) break;
            await sleep(this._timing.deviceRetryMs);
        }
        throw new SpotifyError('device-not-found', `Spotify cannot see "${this._deviceName}" on this account. ` +
            `The first time, open Spotify, pick "${this._deviceName}" in the device list so the receiver can ` +
            'sign in, then try again.');
    }

    // Polling stands aside while a command runs, so a stale answer cannot undo what it just confirmed.
    async _command(work) {
        this._busy++;
        try {
            return await work();
        } finally {
            this._busy--;
        }
    }

    _wire() {
        this._attached = true;
        this._paused = null;
        this._schedulePoll();
    }

    // Checking is less urgent while nothing is playing, which keeps an idle receiver cheap on the API's rate limit.
    _schedulePoll() {
        clearTimeout(this._poller);
        if (!this._attached) return;
        const wait = this._paused === true ? this._timing.pollMs * 3 : this._timing.pollMs;
        this._poller = setTimeout(() => this._poll(), wait);
        this._poller.unref?.();
    }

    async _poll() {
        if (!this._busy) {
            try {
                const state = await this._api.playerState();
                if (this._attached && !this._busy) this._mirror(state);
            } catch (err) {
                if (err.kind === 'reconnect') this._warn(err.message);
            }
        }
        this._schedulePoll();
    }

    _mirror(state) {
        this._setPaused(state?.device?.name === this._deviceName && !state.is_playing);
    }

    _setPaused(paused) {
        if (this._paused === paused) return;
        this._paused = paused;
        if (this._attached) this.emit('paused', paused);
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
            this._setPaused(false);
            break;
        case 'paused':
            this._session.playing = false;
            this._setPaused(true);
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

    _onStarted(child) {
        child.stdout.on('data', (chunk) => { this._pcmBytes += chunk.length; });
    }

    _onStopped() {
        this._session = { user: null, playing: false, track: null };
        this._receiver = null;
    }

    async close() {
        clearTimeout(this._metadataTimer);
        clearTimeout(this._poller);
        this._poller = null;
        this._attached = false;
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
