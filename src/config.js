// Configuration and persisted state.
//
// Lives in the XDG config directory rather than next to the binary, so a single
// downloaded executable can be dropped anywhere and still remember its servers,
// stations and credentials.

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = 'wiijukebox';

function configDir() {
    const base =
        process.env.XDG_CONFIG_HOME ||
        (process.platform === 'darwin'
            ? path.join(os.homedir(), 'Library', 'Application Support')
            : path.join(os.homedir(), '.config'));
    return path.join(base, APP);
}

const DEFAULTS = {
    // Port serving both the WebUI and the audio mount. 4000 matches what the
    // old bridge used for audio, so existing .pls files keep working.
    port: 4000,
    discoveryPort: 4001,

    // Advertised to the Wii inside the .pls. Detected at boot when unset, but
    // overridable because auto-detection picks the wrong NIC on machines with
    // VPNs or docker bridges.
    hostIp: null,

    mount: '/stream',

    // The shared MP3 stream. 48 kHz is ASND's native rate, so the Wii plays it
    // without resampling. { "bitrate": 128, "sampleRate": 44100 } restores the
    // original stream; changes apply when the server restarts.
    audio: { bitrate: 256, sampleRate: 48000 },

    station: {
        name: 'WiiJukebox',
        genre: 'Various',
        description: 'WiiJukebox',
    },

    // Per-source settings, keyed by source id.
    sources: {
        radio: { stations: [] },
        // `country` is the two-letter Apple store used for search and the chart.
        podcasts: { subscriptions: [], country: 'us' },
        desktop: {},
        subsonic: { url: '', username: '', password: '' },
        jellyfin: { url: '', username: '', password: '', token: null, userId: null, deviceId: null },
        plex: { url: '', token: '' },
        // Needs no setup when yt-dlp is on PATH. `binary` points at it
        // elsewhere, `format` overrides the selector, and `extraArgs` passes
        // flags straight through (--cookies-from-browser, --proxy).
        ytdlp: { binary: '', format: '', extraArgs: [], links: [] },
        // Receivers: `binary` points at librespot / shairport-sync when they are
        // not on PATH.
        spotify: { binary: '', deviceName: 'WiiJukebox', bitrate: 320, normalise: false, extraArgs: [] },
        airplay: { binary: '', deviceName: 'WiiJukebox', port: 0, password: '', extraArgs: [] },
        // Same knobs as ytdlp; add --cookies-from-browser to extraArgs for Premium.
        ytmusic: { binary: '', format: '', extraArgs: [], links: [] },
    },

    // Last source/item, restored at boot so the stream comes back by itself
    // after a restart without anyone touching the Wii.
    lastPlayed: null,
};

/** Deep-merge saved values over defaults so new keys appear on upgrade. */
function merge(base, saved) {
    if (!saved || typeof saved !== 'object') return base;
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const [k, v] of Object.entries(saved)) {
        if (["__proto__", "prototype", "constructor"].includes(k)) continue;
        if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
            out[k] = merge(base[k], v);
        } else if (v !== undefined) {
            out[k] = v;
        }
    }
    return out;
}

class Config {
    constructor(dir = configDir()) {
        this.dir = dir;
        this.file = path.join(dir, 'config.json');
        this.data = structuredClone(DEFAULTS);
        this._saveTimer = null;
    }

    load() {
        try {
            const raw = fs.readFileSync(this.file, 'utf8');
            this.data = merge(structuredClone(DEFAULTS), JSON.parse(raw));
        } catch (err) {
            if (err.code !== 'ENOENT') {
                // A corrupt config should not stop the stream coming up; fall
                // back to defaults and say so.
                console.warn(`config unreadable (${err.message}); using defaults`);
            }
            this.data = structuredClone(DEFAULTS);
        }
        return this.data;
    }

    /** Debounced so a burst of edits from the WebUI writes once. */
    save() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            try {
                fs.mkdirSync(this.dir, { recursive: true });
                // Credentials live in here, so keep it owner-only.
                fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
            } catch (err) {
                console.error(`failed to save config: ${err.message}`);
            }
        }, 250);
        this._saveTimer.unref?.();
    }

    sourceConfig(id) {
        if (!Object.hasOwn(DEFAULTS.sources, id)) throw new Error(`unknown source: ${id}`);
        this.data.sources[id] = this.data.sources[id] || {};
        return this.data.sources[id];
    }

    updateSource(id, patch) {
        this.data.sources[id] = merge(this.sourceConfig(id), patch);
        this.save();
        return this.data.sources[id];
    }
}

/**
 * Best guess at the LAN address the Wii should connect to. Skips loopback,
 * docker/virtual bridges and link-local, which are the usual wrong answers.
 */
function detectHostIp() {
    const skip = /^(docker|br-|veth|virbr|tun|tap|zt|wg)/;
    const candidates = [];

    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
        if (skip.test(name)) continue;
        for (const addr of addrs || []) {
            if (addr.family !== 'IPv4' || addr.internal) continue;
            if (/^169\.254\./.test(addr.address)) continue;
            candidates.push({ name, address: addr.address });
        }
    }

    // Prefer a normal private LAN range; the Wii cannot reach anything else.
    const priv = candidates.find((c) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(c.address));
    return (priv || candidates[0] || {}).address || '127.0.0.1';
}

module.exports = { Config, configDir, detectHostIp, DEFAULTS };
