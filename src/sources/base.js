// The contract every audio source implements.
//
// Sources fall into two families and this interface deliberately covers both:
//
//   PULL sources hand back a URI and let the pipeline do the fetching --
//   internet radio, Jellyfin, Plex, Navidrome, anything yt-dlp resolves. They
//   know what to play and where it lives.
//
//   PUSH sources receive audio they did not ask for and write it in -- the
//   AirPlay receiver, the Bluetooth sink, the loopback capture. They cannot say
//   what plays next because something else is deciding.
//
// The distinction matters for control: a pull source can be told to skip, while
// a push source can only relay a skip request back to whatever is sending
// (DACP for AirPlay, AVRCP for Bluetooth, the Web API for Spotify). Capabilities
// below are how a source declares which of those it can actually do, so the
// WebUI can grey out controls that would do nothing rather than lying.

const { EventEmitter } = require('events');

/** Every control the WebUI knows how to render. Sources opt in individually. */
const CAPABILITIES = [
    'play',
    'pause',
    'stop',
    'next',
    'previous',
    'seek',
    'volume',
    'shuffle',
    'repeat',
    'browse', // has a library the WebUI can page through
    'search',
    'queue',
];

/**
 * @typedef {object} NowPlaying
 * @property {string} [title]
 * @property {string} [artist]
 * @property {string} [album]
 * @property {string} [artwork]   URL the WebUI can load, or a data: URI
 * @property {number} [duration]  seconds; omit when unknown (live radio)
 * @property {number} [position]  seconds elapsed
 */

/**
 * @typedef {object} AudioHandle
 * What a source returns from open(). Either:
 *   { type: 'uri', uri, headers?, seekSeconds? }  -- pipeline decodes it
 *   { type: 'pcm', stream }                       -- already interchange PCM
 *   { type: 'encoded', stream }                   -- encoded bytes, pipeline decodes
 */

class Source extends EventEmitter {
    /** Stable identifier used in config and API routes. */
    static id = 'base';

    /** Human name shown in the WebUI source picker. */
    static label = 'Source';

    /** 'pull' or 'push'; see the note at the top of this file. */
    static family = 'pull';

    /**
     * @param {object} [config]  persisted per-source settings (host, token, ...)
     * @param {object} [deps]    shared services (logger, http client, paths)
     */
    constructor(config = {}, deps = {}) {
        super();
        this.config = config;
        this.deps = deps;
        this._state = 'idle'; // idle | connecting | ready | playing | error
    }

    get id() {
        return this.constructor.id;
    }

    get label() {
        return this.constructor.label;
    }

    get family() {
        return this.constructor.family;
    }

    get state() {
        return this._state;
    }

    _setState(next, detail) {
        if (this._state === next) return;
        this._state = next;
        this.emit('state', { state: next, detail });
    }

    /**
     * Which controls this source honours right now. May change with context --
     * a radio stream has no 'next', a Jellyfin queue does.
     * @returns {Record<string, boolean>}
     */
    get capabilities() {
        return {};
    }

    /**
     * Verify configuration and establish any long-lived connection (log in,
     * start a listener). Must not produce audio. Throws with a message meant for
     * the user, since the WebUI shows it verbatim on the settings screen.
     */
    async connect() {}

    /** Tear down whatever connect() established. */
    async disconnect() {}

    /**
     * Begin producing audio for the given item.
     * @param {object} [item]  a source-specific item id from browse()/search()
     * @returns {Promise<AudioHandle>}
     */
    async open(_item) {
        throw new Error(`${this.id}: open() not implemented`);
    }

    /** Stop producing audio, keeping the connection alive. */
    async close() {}

    // --- Optional: library browsing -----------------------------------------
    // Implemented by sources declaring the 'browse' capability. The WebUI drives
    // these generically, so Navidrome, Jellyfin and Plex all render through the
    // same components.

    /**
     * @param {object} [opts] { path, offset, limit, sort }
     * @returns {Promise<{items: Array, total: number}>}
     */
    async browse(_opts) {
        return { items: [], total: 0 };
    }

    /** @returns {Promise<{items: Array, total: number}>} */
    async search(_query, _opts) {
        return { items: [], total: 0 };
    }

    // --- Optional: transport control -----------------------------------------
    // Only meaningful for capabilities the source declared. Push sources relay
    // these to the sending device rather than acting locally.

    async play() {}
    async pause() {}
    async next() {}
    async previous() {}
    async seek(_seconds) {}
    async setVolume(_level) {}
    async setShuffle(_on) {}
    async setRepeat(_mode) {}

    // --- Helpers for subclasses ---------------------------------------------

    /** Announce a now-playing change. The pipeline forwards it to ICY + WebUI. */
    _emitMetadata(meta) {
        this.emit('metadata', meta);
    }

    /** Report a recoverable problem without tearing the source down. */
    _warn(message) {
        this.emit('warning', message);
    }
}

module.exports = { Source, CAPABILITIES };
