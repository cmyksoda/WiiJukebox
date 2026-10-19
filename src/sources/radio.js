// Internet radio source.
//
// The stream itself is handed to the pipeline as a plain URI -- ffmpeg does the
// fetching and decoding. What this file mostly contains is the *second*
// connection, opened purely to read in-band ICY song titles.
//
// That split exists because ffmpeg will not surface ICY metadata mid-stream: it
// reads the headers once at connect and never reports the interleaved title
// changes that follow. So we open our own socket alongside, walk the ICY
// framing, throw the audio away and keep the titles. This parser is carried over
// from the original bridge, where it was tested against a lot of real stations.

const net = require('net');
const tls = require('tls');
const { Source } = require('./base');
const { readCapped } = require('./podcasts');

// A healthy radio stream never goes quiet this long; treat it as a stall.
const STALL_MS = 30000;
const RETRY_MS = 30000;
const MAX_REDIRECTS = 5;
const MAX_HEADER_BYTES = 65536;
const PLAYLIST_PATH = /\.(pls|m3u8?)$/i;
const PLAYLIST_TYPE = /scpls|mpegurl|pls\+xml/i;
const PLAYLIST_TIMEOUT_MS = 8000;
const MAX_PLAYLIST_BYTES = 65536;
const MAX_PLAYLIST_DEPTH = 3;

class RadioSource extends Source {
    static id = 'radio';
    static label = 'Internet Radio';
    static family = 'pull';
    static homeRows = [{ id: 'saved', title: 'Saved stations' }];

    constructor(config = {}, deps = {}) {
        super(config, deps);
        this._reader = null;
        this._station = null;
    }

    get capabilities() {
        // Live radio has no transport beyond connect/disconnect: there is no
        // track to seek within and no queue to skip through.
        return {
            play: true,
            stop: true,
            browse: true, // the user's saved station list
        };
    }

    /** Saved stations live in config; the WebUI edits them through browse(). */
    async browse() {
        const stations = this.config.stations || [];
        return {
            items: stations.map((s, i) => ({
                id: s.id || String(i),
                type: 'station',
                title: s.name,
                subtitle: s.description || s.url,
                url: s.url,
            })),
            total: stations.length,
        };
    }

    async homeRow(_row, { limit }) {
        const { items } = await this.browse();
        return items.slice(0, limit).map((station) => ({ ...station, subtitle: hostOf(station.url) || station.subtitle }));
    }

    async open(item) {
        const url = typeof item === 'string' ? item : item && (item.url || item.uri);
        if (!url) throw new Error('no station URL given');

        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            throw new Error(`not a valid URL: ${url}`);
        }
        if (!/^https?:$/.test(parsed.protocol)) {
            throw new Error(`unsupported protocol ${parsed.protocol}`);
        }

        this._station = {
            url,
            name: (item && item.title) || parsed.hostname,
            description: (item && item.subtitle) || '',
        };

        this._setState('connecting');

        // Show the station name straight away. Most stations send a title within
        // a few seconds, but some take a minute or two, and a blank display in
        // the meantime looks like a failure.
        this._emitMetadata({
            title: this._station.name,
            artist: '',
            album: '',
            artwork: null,
            duration: null,
        });

        const stream = await resolveStream(url, this.deps.fetch || fetch);
        this._startMetadataReader(stream);
        this._setState('playing');

        return { type: 'uri', uri: stream };
    }

    async close() {
        this._stopMetadataReader();
        this._station = null;
        this._setState('idle');
    }

    _stopMetadataReader() {
        if (this._reader) {
            this._reader.stop();
            this._reader = null;
        }
    }

    /**
     * Open a side connection and follow the ICY framing for song titles.
     * Audio bytes are counted and discarded; only StreamTitle is kept.
     */
    _startMetadataReader(sourceUri) {
        this._stopMetadataReader();

        const reader = { stopped: false, socket: null, timer: null };
        reader.stop = () => {
            reader.stopped = true;
            if (reader.timer) clearTimeout(reader.timer);
            if (reader.socket) reader.socket.destroy();
        };
        this._reader = reader;

        // Permanent conditions: don't retry. The audio is still playing via
        // ffmpeg's own connection, so this is a degradation, not a failure --
        // the station name stays on screen.
        const giveUp = (reason) => {
            this._warn(`song titles unavailable (${reason}); station name will be shown instead`);
        };

        // Transient: the stream is fine, quietly try again in a bit.
        const reconnect = (reason) => {
            if (reader.stopped || reader.timer) return;
            reader.timer = setTimeout(() => {
                reader.timer = null;
                connect(sourceUri, 0);
            }, RETRY_MS);
            if (reader.timer.unref) reader.timer.unref();
        };

        const connect = (uri, redirects) => {
            if (reader.stopped) return;

            let u;
            try {
                u = new URL(uri);
            } catch {
                return giveUp('unparseable source uri');
            }
            if (u.protocol !== 'http:' && u.protocol !== 'https:') {
                return giveUp(`${u.protocol}// source`);
            }

            const secure = u.protocol === 'https:';
            const port = u.port || (secure ? 443 : 80);
            const sock = secure
                ? tls.connect({ host: u.hostname, port, servername: u.hostname })
                : net.connect(port, u.hostname);
            reader.socket = sock;

            sock.setTimeout(STALL_MS, () => sock.destroy(new Error('stalled')));

            sock.on(secure ? 'secureConnect' : 'connect', () => {
                sock.write(
                    `GET ${u.pathname}${u.search} HTTP/1.0\r\n` +
                        `Host: ${u.host}\r\n` +
                        `Icy-MetaData: 1\r\n` +
                        `User-Agent: WiiJukebox\r\n` +
                        `Connection: close\r\n\r\n`,
                );
            });

            let buf = Buffer.alloc(0);
            let phase = 'headers'; // headers -> audio -> metalen -> meta -> audio ...
            let metaint = 0;
            let audioLeft = 0;
            let metaLeft = 0;
            let lastTitle = null;

            sock.on('data', (chunk) => {
                if (phase === 'done') return;
                buf = Buffer.concat([buf, chunk]);

                if (phase === 'headers') {
                    const end = buf.indexOf('\r\n\r\n');
                    if (end === -1) {
                        if (buf.length > MAX_HEADER_BYTES) {
                            phase = 'done';
                            sock.destroy();
                            giveUp('oversized response headers');
                        }
                        return;
                    }
                    const head = buf.toString('latin1', 0, end);
                    buf = buf.subarray(end + 4);

                    const status = head.match(/^(?:HTTP\/\d\.\d|ICY)\s+(\d+)/i);
                    const code = status ? parseInt(status[1], 10) : 0;
                    const location = (head.match(/^location:\s*(.+)$/im) || [])[1];

                    if (code >= 300 && code < 400 && location) {
                        phase = 'done';
                        sock.destroy();
                        if (redirects >= MAX_REDIRECTS) return giveUp('too many redirects');
                        let next;
                        try {
                            next = new URL(location.trim(), uri).href;
                        } catch {
                            return giveUp('bad redirect');
                        }
                        return connect(next, redirects + 1);
                    }
                    if (code !== 200) {
                        phase = 'done';
                        sock.destroy();
                        return giveUp(`HTTP ${code || 'unparseable status line'}`);
                    }

                    // Pick up the station name the server advertises; it is
                    // usually better than the hostname we guessed.
                    const icyName = (head.match(/^icy-name:\s*(.+)$/im) || [])[1];
                    if (icyName && this._station) {
                        const name = icyName.trim();
                        if (name && name !== this._station.name) {
                            this._station.name = name;
                            if (!lastTitle) this._emitMetadata({ title: name });
                        }
                    }

                    metaint = parseInt((head.match(/^icy-metaint:\s*(\d+)/im) || [])[1], 10);
                    if (!metaint || metaint > 1048576) {
                        phase = 'done';
                        sock.destroy();
                        return giveUp('station sends no in-band song metadata');
                    }
                    phase = 'audio';
                    audioLeft = metaint;
                    // Fall through: body bytes usually arrive with the headers.
                }

                // Walk the interleaved audio/metadata framing. Audio is dropped;
                // ffmpeg's separate connection is the one that matters.
                while (buf.length) {
                    if (phase === 'audio') {
                        const n = Math.min(audioLeft, buf.length);
                        buf = buf.subarray(n);
                        audioLeft -= n;
                        if (audioLeft === 0) phase = 'metalen';
                    } else if (phase === 'metalen') {
                        metaLeft = buf[0] * 16;
                        buf = buf.subarray(1);
                        if (metaLeft === 0) {
                            phase = 'audio';
                            audioLeft = metaint;
                        } else {
                            phase = 'meta';
                        }
                    } else if (phase === 'meta') {
                        if (buf.length < metaLeft) return; // wait for the full block
                        const meta = buf.toString('utf8', 0, metaLeft).replace(/\0+$/, '');
                        buf = buf.subarray(metaLeft);
                        phase = 'audio';
                        audioLeft = metaint;

                        const title = (meta.match(/StreamTitle='(.*?)';/) || [])[1];
                        if (title && title !== lastTitle) {
                            lastTitle = title;
                            this._emitMetadata(splitTitle(title));
                        }
                    } else {
                        return; // 'done'
                    }
                }
            });

            sock.on('error', (err) => reconnect(err.message));
            sock.on('close', () => {
                if (phase !== 'done') reconnect('station closed the connection');
            });
        };

        connect(sourceUri, 0);
    }
}

function hostOf(url) {
    try { return new URL(url).hostname; } catch { return ''; }
}

/**
 * Many station links are a .pls or .m3u listing the real streams, which ffmpeg can't open,
 * so this follows one to the first stream it names. HLS playlists go to ffmpeg as they are.
 */
async function resolveStream(url, fetchImpl, depth = 0) {
    if (depth >= MAX_PLAYLIST_DEPTH || !PLAYLIST_PATH.test(new URL(url).pathname)) return url;
    let text;
    try {
        const res = await fetchImpl(url, {
            headers: { 'User-Agent': 'WiiJukebox' },
            signal: AbortSignal.timeout(PLAYLIST_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const type = res.headers.get('content-type') || '';
        if (/^(audio|video)\//i.test(type) && !PLAYLIST_TYPE.test(type)) {
            await res.body?.cancel().catch(() => {});
            return url;
        }
        text = (await readCapped(res, MAX_PLAYLIST_BYTES)).toString('utf8');
    } catch (err) {
        throw new Error(`couldn't read the station's playlist (${err.message})`);
    }
    if (/^#EXT-X-/m.test(text)) return url;
    const entries = /^\s*\[playlist\]/i.test(text)
        ? [...text.matchAll(/^\s*File\d+\s*=\s*(\S+)/gim)].map((match) => match[1])
        : text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    const next = entries.find((entry) => /^https?:\/\/\S+$/i.test(entry));
    if (!next) throw new Error("the station's playlist names no stream");
    return resolveStream(next, fetchImpl, depth + 1);
}

/**
 * Stations almost universally pack "Artist - Title" into one field. Splitting it
 * lets the WebUI show them separately; the pipeline recombines them for the Wii,
 * which only has one line anyway.
 */
function splitTitle(raw) {
    const text = raw.trim();
    const dash = text.indexOf(' - ');
    if (dash > 0) {
        return {
            artist: text.slice(0, dash).trim(),
            title: text.slice(dash + 3).trim(),
            album: '',
            artwork: null,
            duration: null,
        };
    }
    return { artist: '', title: text, album: '', artwork: null, duration: null };
}

module.exports = { RadioSource, splitTitle, resolveStream };
