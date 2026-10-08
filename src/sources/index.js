// Source registry.
//
// Every source is constructed lazily and kept alive once connected, so browsing
// a library does not require it to be the one currently playing -- you can queue
// up the next thing from Navidrome while AirPlay is still feeding the stream.

const { RadioSource } = require('./radio');
const { SubsonicSource } = require('./subsonic');
const { JellyfinSource } = require('./jellyfin');
const { YtdlpSource } = require('./ytdlp');

const { DesktopSource } = require('./desktop');
const { PlexSource } = require('./plex');
const { SpotifySource } = require('./spotify');
const { AirplaySource } = require('./airplay');
const { YtMusicSource } = require('./ytmusic');
const { TidalSource } = require('./tidal');
const { findExecutable } = require('./receiver');

const REGISTRY = [
    RadioSource, SubsonicSource, JellyfinSource, PlexSource, YtdlpSource,
    SpotifySource, AirplaySource, YtMusicSource, TidalSource, DesktopSource,
];

class SourceRegistry {
    constructor(config, deps = {}) {
        this.config = config;
        this.deps = deps;
        this._instances = new Map();
    }

    /** Every source type known, with enough detail for the WebUI to list them. */
    describe() {
        return REGISTRY.map((Cls) => {
            const instance = this._instances.get(Cls.id);
            return {
                id: Cls.id,
                label: Cls.label,
                family: Cls.family,
                state: instance ? instance.state : 'idle',
                configured: this._isConfigured(Cls.id),
                capabilities: instance ? instance.capabilities : {},
            };
        });
    }

    _isConfigured(id) {
        const cfg = this.config.sourceConfig(id);
        if (id === 'desktop') return process.platform === 'linux';
        if (id === 'radio') return true; // always usable; stations are optional
        // Nothing to set up: either yt-dlp is installed or connect() explains
        // how to install it, which is a better message than an empty form.
        if (id === 'ytdlp') return true;
        if (id === 'subsonic') return Boolean(cfg.url && cfg.username);
        if (id === 'jellyfin') return Boolean(cfg.url && (cfg.token || cfg.username));
        if (id === 'plex') return Boolean(cfg.url && cfg.token);
        if (id === 'ytmusic') return true;
        if (id === 'tidal') return Boolean(cfg.refreshToken);
        // Receivers are offered once their program is installed; until then the
        // settings screen explains how to get it.
        if (id === 'spotify') return Boolean(findExecutable(cfg.binary || SpotifySource.binaryName));
        if (id === 'airplay') {
            return process.platform !== 'win32' && Boolean(findExecutable(cfg.binary || AirplaySource.binaryName));
        }
        return false;
    }

    /** Get (creating if needed) the instance for a source id. */
    get(id) {
        if (this._instances.has(id)) return this._instances.get(id);

        const Cls = REGISTRY.find((c) => c.id === id);
        if (!Cls) throw new Error(`unknown source: ${id}`);

        const instance = new Cls(this.config.sourceConfig(id), this.deps);

        // Sources that obtain a token during login hand it back here so the user
        // is not asked for a password on every restart.
        instance.on('credentials', (creds) => {
            this.config.updateSource(id, creds);
        });

        this._instances.set(id, instance);
        return instance;
    }

    /** Connect a source, reusing an existing connection when already ready. */
    async connect(id) {
        const source = this.get(id);
        if (source.state === 'ready' || source.state === 'playing') return source;
        await source.connect();
        return source;
    }

    async configure(id, patch) {
        this.get(id); // Validate before persisting anything.
        const previous = this._instances.get(id);
        await previous.disconnect();
        this._instances.delete(id);
        // A new login must not silently keep Jellyfin's old cached token.
        if (id === 'jellyfin' && ['url', 'username', 'password'].some((key) => key in patch)) {
            patch = { ...patch, token: null, userId: null };
        }
        if (id === 'subsonic' && ['url', 'username', 'password'].some((key) => key in patch)) {
            patch = { ...patch, token: null, salt: null };
        }
        // Tokens are bound to the OAuth client that issued them.
        const tidal = this.config.sourceConfig('tidal');
        if (id === 'tidal' && ['clientId', 'clientSecret'].some((key) => key in patch && patch[key] !== tidal[key])) {
            patch = { ...patch, accessToken: null, refreshToken: null, expiresAt: 0 };
        }
        this.config.updateSource(id, patch);
    }

    async disconnectAll() {
        for (const source of this._instances.values()) {
            try {
                await source.disconnect();
            } catch {
                /* shutting down anyway */
            }
        }
        this._instances.clear();
    }
}

module.exports = { SourceRegistry, REGISTRY };
