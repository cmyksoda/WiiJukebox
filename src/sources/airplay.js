// SPDX-License-Identifier: GPL-3.0-only
// AirPlay receiver, using shairport-sync (https://github.com/mikebrady/shairport-sync).
//
// iPhones, iPads and Macs list the server as an AirPlay speaker, so Apple Music
// (and any other app or system audio) can be sent to it. shairport-sync decodes
// the stream and writes raw PCM to stdout; now-playing details and cover art
// arrive on its metadata pipe. Apple's streaming service itself is never
// contacted from here, and no DRM is involved.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { ReceiverSource } = require('./receiver');
const { shrinkToDataUri } = require('./artwork');
const { BYTES_PER_SECOND } = require('../core/format');

// Classic AirPlay senders run about two seconds ahead of what is heard.
const DEFAULT_LATENCY_MS = 1500;
const MAX_PENDING_BYTES = 12 * 1024 * 1024;

const ITEM = /<item><type>([0-9a-f]{1,8})<\/type><code>([0-9a-f]{1,8})<\/code><length>(\d+)<\/length>(?:\s*<data encoding="base64">([^<]*)<\/data>)?<\/item>/;

const fourCC = (hex) => Buffer.from(hex.padStart(8, '0'), 'hex').toString('latin1');

/** Incremental reader for shairport-sync's XML-ish metadata pipe. */
class MetadataParser {
    constructor(onItem) {
        this._onItem = onItem;
        this._text = '';
    }

    write(chunk) {
        this._text += chunk.toString('latin1');
        for (;;) {
            const start = this._text.indexOf('<item>');
            if (start < 0) {
                this._text = this._text.slice(-6);
                return;
            }
            const match = ITEM.exec(this._text.slice(start));
            if (!match) {
                // Wait for the rest of a large item (cover art), but never forever.
                this._text = this._text.slice(start);
                if (this._text.length > MAX_PENDING_BYTES) this._text = '';
                return;
            }
            const data = match[4] ? Buffer.from(match[4].replace(/\s+/g, ''), 'base64') : Buffer.alloc(0);
            this._text = this._text.slice(start + match.index + match[0].length);
            this._onItem({ type: fourCC(match[1]), code: fourCC(match[2]), data });
        }
    }
}

const libconfigString = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

class AirplaySource extends ReceiverSource {
    static id = 'airplay';
    static label = 'AirPlay (Apple Music)';
    static binaryName = 'shairport-sync';
    static installHint = 'Install shairport-sync built with the stdout backend and metadata support ' +
        '(see docs/streaming-services.md), or set its full path in the AirPlay settings.';

    constructor(config = {}, deps = {}) {
        super(config, deps);
        this._runtimeDir = null;
        this._metadataSocket = null;
        this._pending = {};
        this._track = null;
        this._client = null;
        this._playing = false;
        this._art = null;
        this._artSerial = 0;
        this._artSinceMetadata = false;
        this._metadataTimer = null;
    }

    get _deviceName() {
        return String(this.config.deviceName || 'WiiJukebox').slice(0, 50);
    }

    _probeArgs() {
        return ['-V'];
    }

    async connect() {
        if (process.platform === 'win32') {
            const err = new Error('AirPlay receiving is not available on Windows');
            this._setState('error', err.message);
            throw err;
        }
        return super.connect();
    }

    async browse() {
        return {
            items: [{
                id: 'receiver', type: 'station', title: this._deviceName,
                subtitle: 'Start the receiver, then choose it under AirPlay on your iPhone or Mac',
            }],
            total: 1,
        };
    }

    info() {
        return {
            ...super.info(),
            deviceName: this._deviceName,
            client: this._client,
            playing: this._playing,
            track: this._track && { title: this._track.title, artist: this._track.artist, album: this._track.album },
        };
    }

    _idleMetadata() {
        return {
            title: 'Waiting for AirPlay',
            artist: `Choose "${this._deviceName}" under AirPlay`,
            album: '', artwork: null, duration: null,
        };
    }

    _configText(pipePath) {
        const general = [
            `name = ${libconfigString(this._deviceName)};`,
            'output_backend = "stdout";',
            // Level is set by the Wii; the sender's volume slider should not change the stream.
            'ignore_volume_control = "yes";',
        ];
        if (Number.isInteger(this.config.port) && this.config.port > 0) general.push(`port = ${this.config.port};`);
        if (this.config.password) general.push(`password = ${libconfigString(this.config.password)};`);
        return [
            `general = { ${general.join(' ')} };`,
            'stdout = { output_rate = 44100; output_format = "S16_LE"; output_channels = 2; };',
            `metadata = { enabled = "yes"; include_cover_art = "yes"; pipe_name = ${libconfigString(pipePath)}; ` +
                'cover_art_cache_directory = ""; pipe_timeout = 5000; };',
            '',
        ].join('\n');
    }

    async _prepare() {
        if (!this._runtimeDir) {
            this._runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiijukebox-airplay-'));
            const pipePath = path.join(this._runtimeDir, 'metadata');
            try {
                execFileSync('mkfifo', ['-m', '600', pipePath], { stdio: 'ignore' });
            } catch {
                throw new Error('AirPlay needs the mkfifo command to receive track details');
            }
            this._openMetadata(pipePath);
            fs.writeFileSync(path.join(this._runtimeDir, 'shairport-sync.conf'),
                this._configText(pipePath), { mode: 0o600 });
        }
        const args = ['-c', path.join(this._runtimeDir, 'shairport-sync.conf')];
        if (Array.isArray(this.config.extraArgs)) {
            args.push(...this.config.extraArgs.filter((arg) => typeof arg === 'string' && arg));
        }
        return { args, env: {} };
    }

    // Read/write open keeps the pipe from reporting end-of-file whenever the writer restarts.
    _openMetadata(pipePath) {
        const fd = fs.openSync(pipePath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
        const socket = new net.Socket({ fd, readable: true, writable: false });
        const parser = new MetadataParser((item) => this._handleItem(item));
        socket.on('data', (chunk) => parser.write(chunk));
        socket.on('error', () => {});
        this._metadataSocket = socket;
    }

    _handleItem({ type, code, data }) {
        const text = () => data.toString('utf8');
        if (type === 'core') {
            if (code === 'minm') this._pending.title = text();
            else if (code === 'asar') this._pending.artist = text();
            else if (code === 'asal') this._pending.album = text();
            return;
        }
        if (type !== 'ssnc') return;
        switch (code) {
        case 'snam':
            this._client = text();
            break;
        case 'pbeg':
        case 'prsm':
            this._playing = true;
            break;
        case 'pend':
            this._playing = false;
            this._track = null;
            this._art = null;
            this._announce();
            break;
        case 'mdst':
            this._pending = {};
            this._artSinceMetadata = false;
            break;
        case 'mden': {
            const previous = this._track;
            // Senders repeat the picture only when the album changes.
            if (!this._artSinceMetadata && (!previous || previous.album !== this._pending.album)) this._art = null;
            this._track = { title: '', artist: '', album: '', ...this._pending, artwork: this._art };
            this._announce();
            break;
        }
        case 'PICT':
            this._setArtwork(data);
            break;
        default:
        }
    }

    async _setArtwork(image) {
        const serial = ++this._artSerial;
        this._artSinceMetadata = true;
        const art = await shrinkToDataUri(image, { ffmpegPath: this.deps.ffmpegPath || 'ffmpeg' });
        if (serial !== this._artSerial || !art) return;
        this._art = art;
        if (!this._track) return;
        this._track = { ...this._track, artwork: art };
        this._announce();
    }

    // The sender runs ahead of what is audible; hold the label back to match.
    _announce() {
        const buffered = this.deps.pipeline?.pacer?.buffered || 0;
        const latency = Number.isFinite(this.config.latencyMs) ? this.config.latencyMs : DEFAULT_LATENCY_MS;
        const delay = Math.min(5000, latency + Math.round((buffered / BYTES_PER_SECOND) * 1000));
        const track = this._track;
        clearTimeout(this._metadataTimer);
        this._metadataTimer = setTimeout(() => {
            this._emitMetadata(track ? { ...track, duration: null } : this._idleMetadata());
        }, track ? delay : 0);
        this._metadataTimer.unref?.();
    }

    _onStderr(line) {
        if (/address already in use|could not bind|can't bind|failed to start/i.test(line)) {
            this._warn(line.slice(0, 200));
        }
    }

    _onStopped() {
        this._playing = false;
        this._client = null;
        this._track = null;
    }

    async close() {
        clearTimeout(this._metadataTimer);
        this._artSerial++;
        await super.close();
        if (this._metadataSocket) {
            this._metadataSocket.destroy();
            this._metadataSocket = null;
        }
        if (this._runtimeDir) {
            fs.rmSync(this._runtimeDir, { recursive: true, force: true });
            this._runtimeDir = null;
        }
    }
}

module.exports = { AirplaySource, MetadataParser };
