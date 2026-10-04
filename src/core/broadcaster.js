// ICY broadcaster -- the Icecast replacement.
//
// The old bridge needed a real Icecast container because it juggled up to 20
// mountpoints. With exactly one persistent mount that whole dependency
// collapses into this file: an HTTP server that speaks the SHOUTcast/ICY dialect
// WiiRadio expects, and fans the encoder's MP3 bitstream out to every listener.
//
// Dropping Icecast is what makes the "single executable, no Docker" goal
// reachable -- there is no second process left to orchestrate.
//
// The ICY protocol, in full:
//   - Client sends `Icy-MetaData: 1` to opt into in-band metadata.
//   - Server replies with `icy-metaint: N`.
//   - Body is then N bytes of audio, one length byte, (length * 16) bytes of
//     metadata, N bytes of audio, and so on forever. A length byte of 0 means
//     "no change", which is what we send the vast majority of the time.

const { EventEmitter } = require('events');
const http = require('http');
const { MP3_BITRATE_KBPS } = require('./format');

// Bytes of audio between metadata blocks. 16000 is what Icecast and SHOUTcast
// both default to and what WiiRadio is known to handle; there is no upside to
// being clever here.
const METAINT = 16000;

// Audio held back to hand a client the instant it connects. Without it the Wii
// sits silent until its own buffer fills from live bytes alone, which reads as
// several seconds of "nothing happened" after selecting the station. Icecast
// calls this burst-on-connect. 64 KB at 128 kbps is about four seconds.
const BURST_BYTES = 64 * 1024;

// A listener that cannot keep up gets dropped once this much audio has queued
// for it, rather than being allowed to balloon the server's memory.
const CLIENT_BACKLOG_LIMIT = 512 * 1024;

/** ICY headers are latin1 and unframed, so a newline would forge a header. */
function icySafe(value) {
    return String(value == null ? '' : value)
        .replace(/[\r\n]+/g, ' ')
        .trim();
}

/**
 * Build one ICY metadata block: a length byte counting 16-byte units, then the
 * payload padded with NULs to fill them.
 */
function buildMetaBlock(title, url) {
    if (!title && !url) return Buffer.from([0]);

    // Single quotes terminate each field, so they cannot survive inside one.
    const clean = (v) => icySafe(v).replace(/'/g, '');
    let payload = `StreamTitle='${clean(title)}';`;
    if (url) payload += `StreamUrl='${clean(url)}';`;

    let body = Buffer.from(payload, 'utf8');

    // The length byte counts 16-byte units, so a block can never exceed 255*16.
    // Truncate on a UTF-8 boundary rather than splitting a multi-byte character,
    // which would render as a replacement glyph on the Wii.
    const maxBytes = 255 * 16;
    if (body.length > maxBytes) {
        body = body.subarray(0, maxBytes);
        while (body.length && (body[body.length - 1] & 0xc0) === 0x80) {
            body = body.subarray(0, body.length - 1);
        }
    }

    const units = Math.ceil(body.length / 16);
    const block = Buffer.alloc(1 + units * 16);
    block[0] = units;
    body.copy(block, 1);
    return block;
}

class Broadcaster extends EventEmitter {
    /**
     * @param {object} [opts]
     * @param {string} [opts.mount]    path listeners connect to
     * @param {string} [opts.name]     station name, shown in WiiRadio's UI
     * @param {string} [opts.genre]    fills WiiRadio's $GENRE menu line
     */
    constructor({
        mount = '/stream',
        name = 'WiiJukebox',
        genre = 'Various',
        description = 'WiiJukebox',
        bitrate = MP3_BITRATE_KBPS,
    } = {}) {
        super();
        this.mount = mount.startsWith('/') ? mount : `/${mount}`;
        this.name = name;
        this.genre = genre;
        this.description = description;
        this.bitrate = bitrate;

        this._clients = new Set();
        this._burst = [];
        this._burstBytes = 0;

        // Current metadata, and a dirty flag so a block is emitted once per
        // change rather than repeatedly.
        this._title = '';
        this._url = '';
        this._metaDirty = false;
    }

    get listenerCount() {
        return this._clients.size;
    }

    /** Snapshot of connected listeners, for the WebUI. */
    get listeners() {
        return [...this._clients].map((c) => ({
            id: c.id,
            address: c.address,
            userAgent: c.userAgent,
            connectedAt: c.connectedAt,
            wantsMetadata: c.metaint > 0,
        }));
    }

    /**
     * True when this request is for the audio mount.
     *
     * Routing is left to the caller rather than done by attaching our own
     * 'request' listener: a second listener would race the app's, and whichever
     * ran first would send headers the other then tried to send again.
     */
    handles(req) {
        const path = (req.url || '').split('?')[0];
        return path === this.mount || path === `${this.mount}.mp3`;
    }

    /** Serve one listener. Call only when handles(req) is true. */
    handleRequest(req, res) {
        // HEAD is how some players probe before committing; answer headers only.
        const headOnly = req.method === 'HEAD';

        const wantsMeta = String(req.headers['icy-metadata'] || '') === '1';
        const metaint = wantsMeta ? METAINT : 0;

        const headers = {
            'Content-Type': 'audio/mpeg',
            // Suppress every layer of buffering between here and the Wii. A proxy
            // that chunks or caches this would break the live stream outright.
            'Cache-Control': 'no-cache, no-store',
            Connection: 'close',
            // Node HTTP headers cannot carry Unicode station names; metadata
            // bodies still retain UTF-8 titles.
            'icy-name': icySafe(this.name).replace(/[^\x20-\x7e]/g, '?'),
            'icy-genre': icySafe(this.genre).replace(/[^\x20-\x7e]/g, '?'),
            'icy-description': icySafe(this.description).replace(/[^\x20-\x7e]/g, '?'),
            'icy-br': String(this.bitrate),
            'icy-sr': '44100',
            'icy-pub': '0',
        };
        if (metaint) headers['icy-metaint'] = String(metaint);

        // ICY clients predate HTTP/1.1 chunking and will happily treat a chunked
        // body's framing bytes as audio, so the transfer must stay unframed.
        res.useChunkedEncodingByDefault = false;
        res.writeHead(200, headers);

        if (headOnly) {
            res.end();
            return;
        }

        const client = {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            res,
            socket: req.socket,
            address: req.socket.remoteAddress,
            userAgent: req.headers['user-agent'] || 'unknown',
            connectedAt: Date.now(),
            metaint,
            // Bytes of audio sent since the last metadata block.
            sinceMeta: 0,
            backlog: 0,
        };

        // Nagle would hold small writes back waiting for a full segment, adding
        // latency to a stream that is already tightly paced.
        req.socket.setNoDelay(true);
        // The stream is deliberately infinite, so the default socket timeout
        // must not apply.
        req.socket.setTimeout(0);

        this._clients.add(client);
        this.emit('listener-connected', {
            id: client.id,
            address: client.address,
            userAgent: client.userAgent,
        });

        const drop = () => this._dropClient(client);
        res.on('close', drop);
        res.on('error', drop);

        res.on('drain', () => {
            client.backlog = 0;
        });

        // Hand over the burst so playback starts promptly. A brand-new listener
        // gets the current title immediately rather than waiting for the next
        // track change, otherwise the Wii shows a blank display until then.
        if (this._burst.length) {
            for (const chunk of this._burst) this._sendAudio(client, chunk);
        }
        if (client.metaint && this._title) {
            client.pendingMeta = buildMetaBlock(this._title, this._url);
        }
    }

    _dropClient(client) {
        if (!this._clients.delete(client)) return;
        try {
            client.res.destroy();
        } catch {
            /* already gone */
        }
        this.emit('listener-disconnected', { id: client.id });
    }

    /**
     * Feed MP3 from the encoder. Everything downstream of here is fan-out.
     */
    write(chunk) {
        if (!chunk || !chunk.length) return;

        this._rememberBurst(chunk);

        if (this._metaDirty) {
            const block = buildMetaBlock(this._title, this._url);
            for (const client of this._clients) {
                if (client.metaint) client.pendingMeta = block;
            }
            this._metaDirty = false;
        }

        for (const client of this._clients) {
            this._sendAudio(client, chunk);
        }
    }

    /**
     * Write audio to one client, splicing in metadata at each metaint boundary.
     */
    _sendAudio(client, chunk) {
        const res = client.res;
        if (res.destroyed || res.writableEnded) return;

        // Slow listeners are dropped rather than buffered indefinitely; a Wii on
        // flaky wifi that has fallen this far behind is better off reconnecting.
        if (client.backlog > CLIENT_BACKLOG_LIMIT) {
            this.emit('warning', `dropping slow listener ${client.address}`);
            this._dropClient(client);
            return;
        }

        if (!client.metaint) {
            this._writeRaw(client, chunk);
            return;
        }

        let offset = 0;
        while (offset < chunk.length) {
            const room = client.metaint - client.sinceMeta;
            const take = Math.min(room, chunk.length - offset);

            this._writeRaw(client, chunk.subarray(offset, offset + take));
            offset += take;
            client.sinceMeta += take;

            if (client.sinceMeta >= client.metaint) {
                // Exactly one metadata block per interval. Almost always the
                // single zero byte meaning "unchanged".
                const block = client.pendingMeta || Buffer.from([0]);
                client.pendingMeta = null;
                this._writeRaw(client, block);
                client.sinceMeta = 0;
            }
        }
    }

    _writeRaw(client, buf) {
        if (!buf.length) return;
        const ok = client.res.write(buf);
        if (!ok) client.backlog += buf.length;
    }

    /** Keep the trailing BURST_BYTES of audio for instant start on connect. */
    _rememberBurst(chunk) {
        this._burst.push(chunk);
        this._burstBytes += chunk.length;
        while (this._burstBytes > BURST_BYTES && this._burst.length > 1) {
            this._burstBytes -= this._burst.shift().length;
        }
    }

    /**
     * Set the now-playing text WiiRadio displays. Takes effect at each listener's
     * next metaint boundary.
     */
    setMetadata({ title, url } = {}) {
        const nextTitle = icySafe(title);
        const nextUrl = icySafe(url);
        if (nextTitle === this._title && nextUrl === this._url) return;
        this._title = nextTitle;
        this._url = nextUrl;
        this._metaDirty = true;
        this.emit('metadata', { title: this._title, url: this._url });
    }

    /** Station-level identity, shown in WiiRadio's station list. */
    setStationInfo({ name, genre, description } = {}) {
        if (name != null) this.name = icySafe(name);
        if (genre != null) this.genre = icySafe(genre);
        if (description != null) this.description = icySafe(description);
    }

    close() {
        for (const client of [...this._clients]) this._dropClient(client);
    }
}

module.exports = { Broadcaster, METAINT, buildMetaBlock, icySafe };

// Keep http referenced for consumers that construct their own server alongside.
module.exports.http = http;
