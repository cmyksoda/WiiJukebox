// Source registry.
//
// Every source is constructed lazily and kept alive once connected, so browsing
// a library does not require it to be the one currently playing -- you can queue
// up the next thing from Navidrome while AirPlay is still feeding the stream.

const { RadioSource } = require('./radio');
const { PodcastsSource } = require('./podcasts');
const { SubsonicSource } = require('./subsonic');
const { JellyfinSource } = require('./jellyfin');
const { YtdlpSource } = require('./ytdlp');

const { DesktopSource } = require('./desktop');
const { PlexSource } = require('./plex');
const { SpotifySource } = require('./spotify');
const { AirplaySource } = require('./airplay');
const { YtMusicSource } = require('./ytmusic');
const { findExecutable } = require('./receiver');

const REGISTRY = [
    RadioSource, PodcastsSource, SubsonicSource, JellyfinSource, PlexSource, YtdlpSource,
    SpotifySource, AirplaySource, YtMusicSource, DesktopSource,
];

class SourceRegistry {
    constructor(config, deps = {}) {
        this.config = config;
        this.deps = deps;
        this._instances = new Map();
    }

    /** Every source type known, with enough detail for the WebUI to list them. */
    describe() {
        const hidden = new Set(this.hidden());
        return REGISTRY.map((Cls) => {
            const instance = this._instances.get(Cls.id);
            return {
                id: Cls.id,
                label: Cls.label,
                family: Cls.family,
                suggests: Cls.suggests,
                state: instance ? instance.state : 'idle',
                configured: this._isConfigured(Cls.id),
                hidden: hidden.has(Cls.id),
                capabilities: instance ? instance.capabilities : {},
            };
        });
    }

    /** Ids left out of navigation, in registry order. Ids this build does not know are ignored. */
    hidden() {
        const saved = this.config.data.ui?.hiddenSources;
        const ids = new Set(Array.isArray(saved) ? saved : []);
        return REGISTRY.filter((Cls) => ids.has(Cls.id)).map((Cls) => Cls.id);
    }

    /** Hiding only changes what menus offer: a hidden service keeps its settings, and keeps playing. */
    setHidden(change) {
        const { hide = [], show = [] } = change ?? {};
        const invalid = (list) => !Array.isArray(list) || list.some((id) => !REGISTRY.some((Cls) => Cls.id === id));
        if (invalid(hide) || invalid(show)) {
            throw Object.assign(new Error('hide and show take lists of known service ids'), { code: 400 });
        }
        const next = new Set(this.hidden());
        for (const id of hide) next.add(id);
        for (const id of show) next.delete(id);
        const hiddenSources = REGISTRY.filter((Cls) => next.has(Cls.id)).map((Cls) => Cls.id);
        this.config.data.ui = { ...this.config.data.ui, hiddenSources };
        this.config.save();
        return this.hidden();
    }

    _isConfigured(id) {
        const cfg = this.config.sourceConfig(id);
        if (id === 'desktop') return process.platform === 'linux';
        if (id === 'radio') return true; // always usable; stations are optional
        if (id === 'podcasts') return true; // subscriptions are optional too
        // Nothing to set up: either yt-dlp is installed or connect() explains
        // how to install it, which is a better message than an empty form.
        if (id === 'ytdlp') return true;
        if (id === 'subsonic') return Boolean(cfg.url && cfg.username);
        if (id === 'jellyfin') return Boolean(cfg.url && (cfg.token || cfg.username));
        if (id === 'plex') return Boolean(cfg.url && cfg.token);
        if (id === 'ytmusic') return true;
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

        // Sources that edit their own saved settings (podcast subscriptions) report them here.
        instance.on('config', (patch) => {
            this.config.updateSource(id, patch);
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
        if (id === 'spotify') patch = this._spotifyPatch(patch);
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
        this.config.updateSource(id, patch);
    }

    // The sign-in is only ever written by the server; a new Client ID invalidates the account tied to the old one.
    _spotifyPatch(patch) {
        const { refreshToken, account, reconnect, ...rest } = patch;
        if ('clientId' in rest) {
            rest.clientId = String(rest.clientId ?? '').trim();
            if (rest.clientId !== this.config.sourceConfig('spotify').clientId) {
                Object.assign(rest, { refreshToken: null, account: '', reconnect: false });
            }
        }
        return rest;
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
