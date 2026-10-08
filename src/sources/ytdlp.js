// YouTube, SoundCloud, Bandcamp -- anything yt-dlp can resolve.
//
// yt-dlp is a program rather than a library, so this source is a careful
// wrapper around spawning it. Two properties of the tool shape everything
// below.
//
// First, *resolve late*. yt-dlp turns a page URL into a direct media URL that
// is signed and time-limited -- often a few hours, sometimes much less. Playing
// a sixty-track playlist by resolving all sixty up front would leave the last
// ones expired long before they were reached. So the queue holds page URLs and
// the direct URL is fetched one track at a time, at the moment it is needed.
//
// Second, *never let extraction stall the stream*. Every call reaches out to
// the network and can hang, so each one is spawned with a timeout and killed if
// it overruns. While that happens the pacer fills with silence exactly as it
// does for any other source swap, so the Wii keeps its connection either way.
//
// Nothing here needs configuring: if yt-dlp is on PATH the source just works.
// `sources.ytdlp` in config.json can override the binary path or the format
// selector, and `extraArgs` passes through anything else the user needs
// (--cookies-from-browser, --proxy) since we deliberately ignore yt-dlp's own
// config file -- see _extract().

const { spawn } = require('child_process');

const YOUTUBE_URL = /^https?:\/\/([a-z0-9-]+\.)?(youtube\.com|youtu\.be)\//i;
const { splitTitle } = require('./radio');
const { QueueSource } = require('./queue');

// How many results a search asks for. Enough to be useful, small enough that
// the flat listing comes back in a couple of seconds.
const SEARCH_LIMIT = 25;

// Extraction is network-bound and occasionally hangs on a dead host. These are
// generous enough for a slow connection and short enough that a wedged process
// does not leave the WebUI waiting forever.
const VERSION_TIMEOUT_MS = 10000;
const SEARCH_TIMEOUT_MS = 30000;
const EXTRACT_TIMEOUT_MS = 60000;

// A flat playlist entry is a few hundred bytes, so this allows tens of
// thousands of them while still refusing to buffer a runaway process.
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

// Channel URLs can expand to thousands of videos. Keeping the whole thing would
// work, but the WebUI would be unusable and nobody queues 5000 tracks on
// purpose, so take a prefix and say so.
const MAX_QUEUE = 500;

// A channel holds tabs which hold playlists which hold videos. Three levels is
// past anything real and stops a malformed link recursing forever.
const MAX_NESTING = 3;

// Marks a browse path as "expand this link" rather than a track to play.
const LIST_PREFIX = 'list/';

const DEFAULT_BINARY = 'yt-dlp';
// bestaudio first because a video stream would be decoded and thrown away;
// /best is the fallback for sites that only publish muxed formats.
const DEFAULT_FORMAT = 'bestaudio/best';

class YtdlpSource extends QueueSource {
    static id = 'ytdlp';
    static label = 'YouTube / SoundCloud';
    static family = 'pull';

    constructor(config = {}, deps = {}) {
        super(config, deps);
        this._current = null;
        this._version = null;
        // Every live child process, so close() can kill an extraction that is
        // still running when the user changes their mind.
        this._procs = new Set();
    }

    get _binary() {
        return this.config.binary || DEFAULT_BINARY;
    }

    get _format() {
        return this.config.format || DEFAULT_FORMAT;
    }

    get capabilities() {
        return {
            play: true,
            pause: true,
            stop: true,
            browse: true,
            search: true,
            ...this.queueCapabilities,
            queue: this._queue.length > 0,
            // The pipeline reports seek itself: finite videos reopen their
            // resolved URL at an offset, while live streams cannot seek.
        };
    }

    // --- running yt-dlp -------------------------------------------------------

    /**
     * Spawn yt-dlp and collect stdout. Rejects with a message written for the
     * user, since the WebUI shows it verbatim.
     *
     * @param {string[]} args
     * @param {{timeoutMs: number, what: string}} opts
     * @returns {Promise<string>}
     */
    _run(args, { timeoutMs, what }) {
        return new Promise((resolve, reject) => {
            let proc;
            try {
                proc = spawn(this._binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (err) {
                return reject(new Error(`could not run ${this._binary}: ${err.message}`));
            }

            this._procs.add(proc);

            let out = '';
            let errText = '';
            let overflowed = false;
            let timedOut = false;

            const timer = setTimeout(() => {
                timedOut = true;
                proc.kill('SIGKILL');
            }, timeoutMs);
            timer.unref?.();

            const finish = (err, value) => {
                clearTimeout(timer);
                this._procs.delete(proc);
                if (err) reject(err);
                else resolve(value);
            };

            proc.stdout.setEncoding('utf8');
            proc.stdout.on('data', (chunk) => {
                if (overflowed) return;
                out += chunk;
                if (out.length > MAX_OUTPUT_BYTES) {
                    overflowed = true;
                    proc.kill('SIGKILL');
                }
            });

            proc.stderr.setEncoding('utf8');
            proc.stderr.on('data', (chunk) => {
                // Only the tail matters; the useful ERROR line is always last.
                errText = (errText + chunk).slice(-8192);
            });

            proc.on('error', (err) => {
                if (err.code === 'ENOENT') {
                    return finish(
                        new Error(
                            `${this._binary} not found. Install yt-dlp (your package manager, ` +
                                `or "pipx install yt-dlp") and restart, or set sources.ytdlp.binary ` +
                                `in config.json to its full path.`,
                        ),
                    );
                }
                finish(new Error(`could not run ${this._binary}: ${err.message}`));
            });

            proc.on('close', (code) => {
                if (timedOut) {
                    return finish(new Error(`${what} timed out after ${Math.round(timeoutMs / 1000)}s`));
                }
                if (overflowed) {
                    return finish(new Error(`${what} returned more data than expected; giving up`));
                }
                if (code !== 0) {
                    return finish(new Error(cleanError(errText, `${what} failed (exit ${code})`)));
                }
                finish(null, out);
            });
        });
    }

    /** Kill anything still extracting. */
    _killAll() {
        for (const proc of this._procs) {
            try {
                proc.kill('SIGKILL');
            } catch {
                /* already gone */
            }
        }
        this._procs.clear();
    }

    /**
     * Ask yt-dlp what is behind a URL. Returns its info JSON: `_type: 'playlist'`
     * with flat `entries` for anything containing several tracks, otherwise a
     * single item whose `url` is the resolved media stream.
     *
     * @param {string} url
     * @param {{noPlaylist?: boolean, timeoutMs?: number}} [opts]
     */
    async _extract(url, { noPlaylist = false, timeoutMs = EXTRACT_TIMEOUT_MS } = {}) {
        const target = normaliseUrl(url);

        const args = [
            '--dump-single-json',
            // Flat means playlist entries are listed without extracting each
            // one, which is the difference between a playlist opening instantly
            // and taking a minute. Single items are unaffected and still come
            // back fully resolved.
            '--flat-playlist',
            '--no-warnings',
            // A user's own yt-dlp config could set --extract-audio or a custom
            // output template, which would break the JSON we parse here. Ignore
            // it and let config.extraArgs pass through what is actually wanted.
            '--ignore-config',
            '-f',
            this._format,
        ];
        if (noPlaylist) args.push('--no-playlist');
        args.push(...this._extraArgs());
        // Everything after -- is a URL, never an option, however it is spelled.
        args.push('--', target);

        const out = await this._run(args, { timeoutMs, what: 'looking up that link' });

        let info;
        try {
            info = JSON.parse(out);
        } catch {
            throw new Error('yt-dlp returned something unreadable for that link');
        }
        if (!info || typeof info !== 'object') {
            throw new Error('yt-dlp found nothing at that link');
        }
        return info;
    }

    // YouTube history (which YouTube Music scrobblers read) only learns of plays from a
    // signed-in client, so this needs the user's cookies in extraArgs.
    async reportPlayed(track) {
        const signedIn = this._extraArgs().some((arg) => /^--cookies(-from-browser)?(=|$)/.test(arg));
        if (!signedIn || !YOUTUBE_URL.test(track.url || '')) return;
        await this._run(['--mark-watched', '--simulate', '--quiet', '--no-warnings', ...this._extraArgs(), track.url],
            { timeoutMs: 60000, what: 'marking it watched' });
    }

    /** Extra flags from config, ignored unless they are a list of strings. */
    _extraArgs() {
        const extra = this.config.extraArgs;
        if (!Array.isArray(extra)) return [];
        return extra.filter((a) => typeof a === 'string' && a.length);
    }

    // --- lifecycle ------------------------------------------------------------

    async connect() {
        this._setState('connecting');
        try {
            const out = await this._run(['--version'], {
                timeoutMs: VERSION_TIMEOUT_MS,
                what: 'checking yt-dlp',
            });
            this._version = out.trim().split('\n')[0] || 'unknown';
        } catch (err) {
            this._setState('error', err.message);
            throw err;
        }
        this._setState('ready');
    }

    async disconnect() {
        this._killAll();
        this._queue.clear();
        this._current = null;
        this._setState('idle');
    }

    async close() {
        this._killAll();
        this._queue.clear();
        this._current = null;
        this._setState('ready');
    }

    // --- browsing -------------------------------------------------------------

    /**
     * There is no library to page through here, so browsing means one thing:
     * expanding a link that holds several tracks.
     *
     *   ''                -> nothing; the WebUI offers the paste box instead
     *   'list/<url>'      -> the tracks inside that playlist, album or channel
     */
    async browse({ path = '', offset = 0, limit = 100 } = {}) {
        if (!path) {
            const links = this.config.links || [];
            return { items: links.slice(offset, offset + limit).map((link) => ({
                id: link.url, type: 'track', title: link.name, subtitle: link.url,
            })), total: links.length };
        }

        const url = path.startsWith(LIST_PREFIX) ? path.slice(LIST_PREFIX.length) : path;
        const info = await this._extract(url);

        if (info._type !== 'playlist') {
            // A single track: show it as one row rather than erroring, so
            // drilling into something that turned out not to be a list still
            // gives the user something to click.
            return { items: [this._itemFor(info, url)], total: 1 };
        }

        const entries = (info.entries || []).filter(Boolean);
        const items = this._decoratePlaylist(info, entries.map((entry) => this._itemFor(entry, entryUrl(entry))));
        return { items: items.slice(offset, offset + limit), total: entries.length };
    }

    /** Hook for subclasses to enrich a playlist's tracks (shared cover, album name). */
    _decoratePlaylist(_info, items) {
        return items;
    }

    async search(query, { limit = SEARCH_LIMIT } = {}) {
        const q = String(query || '').trim();
        if (!q) return { items: [], total: 0 };

        // A pasted link is not a search term. Hand it straight back as a
        // playable row rather than asking YouTube to search for the URL text.
        // Deliberately without extracting it first: search runs on every pause
        // in typing, and a slow site would make the box feel frozen. open()
        // fetches the real title a moment later, when it is actually wanted.
        if (isHttpUrl(q)) {
            return {
                items: [{ id: q, type: 'track', title: q, subtitle: 'Paste — click to play' }],
                total: 1,
            };
        }

        const count = Math.max(1, Math.min(Number(limit) || SEARCH_LIMIT, 100));
        const args = [
            '--dump-json',
            '--flat-playlist',
            '--no-warnings',
            '--ignore-config',
            ...this._extraArgs(),
            '--',
            `ytsearch${count}:${q}`,
        ];

        const out = await this._run(args, {
            timeoutMs: SEARCH_TIMEOUT_MS,
            what: 'searching',
        });

        // --dump-json emits one JSON object per line, not an array.
        const items = [];
        for (const line of out.split('\n')) {
            const text = line.trim();
            if (!text) continue;
            let entry;
            try {
                entry = JSON.parse(text);
            } catch {
                continue; // a stray non-JSON line should not lose the results
            }
            const url = entryUrl(entry);
            if (url) items.push(this._itemFor(entry, url));
        }

        return { items, total: items.length };
    }

    /** Turn a yt-dlp info or flat entry into the item shape the WebUI renders. */
    _itemFor(info, url) {
        const meta = metaFor(info);
        const uploader = info.uploader || info.channel || '';

        if (isPlaylistish(info)) {
            return {
                id: `${LIST_PREFIX}${url}`,
                type: 'playlist',
                title: info.title || url,
                subtitle: [uploader, countLabel(info)].filter(Boolean).join(' — '),
                artwork: meta.artwork,
            };
        }

        return {
            id: url,
            type: 'track',
            title: meta.title || info.title || url,
            subtitle: [meta.artist, meta.album].filter(Boolean).join(' — ') || uploader,
            artist: meta.artist,
            album: meta.album,
            duration: meta.duration,
            artwork: meta.artwork,
        };
    }

    // --- playback -------------------------------------------------------------

    /**
     * Play a link. A playlist, album or channel becomes a queue so that picking
     * one plays the whole thing -- the same shape Subsonic uses, so next and
     * previous behave identically wherever the audio came from.
     */
    async open(item) {
        if (!item) throw new Error('nothing selected');

        const target = itemUrl(item);
        if (!target) throw new Error('no link to play');

        this._setState('connecting');

        // "watch?v=X&list=Y" means the video, not the list it happens to sit in.
        // Every other player treats it that way and yt-dlp would otherwise
        // queue the entire playlist.
        const info = await this._extract(target, { noPlaylist: isVideoInPlaylist(target) });

        if (info._type === 'playlist') {
            const entries = (info.entries || []).filter((e) => e && entryUrl(e));
            if (!entries.length) throw new Error('that link has nothing playable in it');

            if (entries.length > MAX_QUEUE) {
                this._warn(
                    `that link holds ${entries.length} tracks; queueing the first ${MAX_QUEUE}`,
                );
            }

            // A track picked inside a list (e.g. from the Wii) starts there.
            this._queue.load(this._decoratePlaylist(info, entries
                .slice(0, MAX_QUEUE)
                .map((entry) => this._itemFor(entry, entryUrl(entry)))), item);
            return this._openQueueItem();
        }

        // A single item: the probe resolved the media URL already, so there is
        // no second round trip to make.
        const track = this._itemFor(info, target);
        this._queue.load([track]);
        return this._handleFor(info, track);
    }

    /** Resolve the current queue entry and hand the pipeline its audio. */
    async _openQueueItem(depth = 0) {
        const track = this._queue.current;
        if (!track) throw new Error('queue exhausted');

        // Resolved late, one at a time: see the note at the top of this file.
        // Via itemUrl because a queue entry may be a nested list, and those
        // carry the browse prefix.
        const info = await this._extract(itemUrl(track), { noPlaylist: true });

        // A channel link expands into its tabs, so a queue entry can itself
        // turn out to be a list. Splice the contents in where it stood and
        // carry on -- that flattens one level per attempt, without ever having
        // to extract an entire channel up front.
        if (info._type === 'playlist') {
            if (depth >= MAX_NESTING) {
                throw new Error(`${track.title || 'that link'}: nested too deeply to follow`);
            }
            const nested = (info.entries || [])
                .filter((entry) => entry && entryUrl(entry))
                .slice(0, MAX_QUEUE)
                .map((entry) => this._itemFor(entry, entryUrl(entry)));
            if (!nested.length) {
                throw new Error(`${track.title || 'that link'}: nothing playable inside`);
            }
            this._queue.expandCurrent(nested, MAX_QUEUE);
            return this._openQueueItem(depth + 1);
        }

        return this._handleFor(info, track);
    }

    _handleFor(info, track) {
        const uri = info.url;
        if (!uri) {
            throw new Error(`${track.title || 'that link'}: no audio stream to play`);
        }

        this._current = track;
        const meta = metaFor(info, track);
        this._emitMetadata(meta);
        this._startTrack({ ...meta, url: info.webpage_url || itemUrl(track) });
        this._setState('playing');

        return {
            type: 'uri',
            uri,
            // Several sites, YouTube included, hand back a URL that only works
            // with the user-agent it was issued for.
            headers: info.http_headers || undefined,
            seekable: meta.duration > 0,
        };
    }

    /**
     * One dead video should not end the album. Skip past what will not
     * resolve, in whichever direction we were already travelling, trying each
     * track at most once so a queue of dead links under repeat-all cannot spin.
     */
    async _move(step) {
        const onward = step === 'previous' ? 'previous' : 'next';
        let moved = this._queue[step]();
        for (let tried = 1; moved; tried++) {
            try {
                return await this._openQueueItem();
            } catch (err) {
                const failed = this._queue.current;
                this._warn(`skipping ${failed ? failed.title : 'a track'}: ${err.message}`);
                moved = tried < this._queue.length && this._queue[onward]();
            }
        }
        return null;
    }
}

// --- helpers ------------------------------------------------------------------

/** Best-effort now-playing from a yt-dlp info object. */
function metaFor(info, fallback = {}) {
    const duration =
        info.is_live || info.live_status === 'is_live' || !Number.isFinite(info.duration)
            ? null
            : info.duration > 0
              ? info.duration
              : null;

    const artwork = info.thumbnail || pickThumbnail(info.thumbnails) || fallback.artwork || null;
    const uploader = info.uploader || info.channel || '';

    // Music sites and YouTube Music tag things properly; use that when it is
    // there, since it is always better than anything guessed from a title.
    if (info.track || info.artist) {
        return {
            title: info.track || info.title || fallback.title || '',
            artist: info.artist || uploader,
            album: info.album || '',
            artwork,
            duration,
        };
    }

    // Otherwise the uploader has almost certainly written "Artist - Title" into
    // the title field, exactly as a radio station packs it into one ICY line --
    // so the same splitter earns its keep a second time.
    const split = splitTitle(info.title || fallback.title || '');
    return {
        title: split.title,
        artist: split.artist || uploader,
        album: '',
        artwork,
        duration,
    };
}

/** Largest thumbnail yt-dlp listed, which is the last one by convention. */
function pickThumbnail(thumbnails) {
    if (!Array.isArray(thumbnails) || !thumbnails.length) return null;
    const withUrl = thumbnails.filter((t) => t && t.url);
    if (!withUrl.length) return null;
    const sized = withUrl.filter((t) => Number.isFinite(t.width));
    if (!sized.length) return withUrl[withUrl.length - 1].url;
    return sized.reduce((a, b) => (b.width > a.width ? b : a)).url;
}

/**
 * Does this info object describe several tracks rather than one?
 *
 * Note what is *not* used: `playlist_count`. Every entry of a flat listing
 * carries it, describing the listing it came from rather than itself -- so a
 * search for 25 videos hands back 25 entries all claiming `playlist_count: 25`.
 * Trusting it labelled every search result a playlist.
 *
 * The remaining gap is a playlist nested inside another listing, which yt-dlp
 * reports as a bare `_type: 'url'`. The extractor key usually gives it away;
 * when it does not, the item shows as a track and playing it queues the whole
 * thing, which is a harmless way to be wrong.
 */
function isPlaylistish(info) {
    if (info._type === 'playlist' || Array.isArray(info.entries)) return true;
    return /(playlist|tab|set|album)$/i.test(String(info.ie_key || ''));
}

function countLabel(info) {
    const n = Array.isArray(info.entries)
        ? info.entries.length
        : info._type === 'playlist'
          ? info.playlist_count
          : null;
    if (!Number.isFinite(n)) return '';
    return `${n} track${n === 1 ? '' : 's'}`;
}

/** The page URL for a flat playlist entry or a search result. */
function entryUrl(entry) {
    if (!entry) return '';
    return String(entry.webpage_url || entry.url || entry.original_url || '').trim();
}

/** The URL a WebUI item refers to, with any browse prefix stripped. */
function itemUrl(item) {
    const raw =
        typeof item === 'string'
            ? item
            : item && typeof item === 'object'
              ? item.url || item.webpage_url || item.id || ''
              : '';
    const text = String(raw).trim();
    return text.startsWith(LIST_PREFIX) ? text.slice(LIST_PREFIX.length) : text;
}

function isHttpUrl(text) {
    try {
        return /^https?:$/.test(new URL(text).protocol);
    } catch {
        return false;
    }
}

/**
 * Refuse anything that is not a plain web link before it reaches yt-dlp, which
 * happily accepts local file paths and other extractors we have no business
 * handing arbitrary WebUI input to.
 */
function normaliseUrl(url) {
    const text = String(url || '').trim();
    if (!text) throw new Error('no link given');
    if (!isHttpUrl(text)) throw new Error(`not a web link: ${text}`);
    return text;
}

/** True for "watch?v=X&list=Y" -- a video that merely sits inside a playlist. */
function isVideoInPlaylist(url) {
    try {
        const params = new URL(url).searchParams;
        return Boolean(params.get('v') && params.get('list'));
    } catch {
        return false;
    }
}

/** Pull the human-readable line out of yt-dlp's stderr. */
function cleanError(stderr, fallback) {
    const lines = String(stderr || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

    const line = lines.reverse().find((l) => /^ERROR:/i.test(l)) || lines[0];
    if (!line) return fallback;

    return (
        line
            .replace(/^ERROR:\s*/i, '')
            // Extractor prefixes and yt-dlp's bug-report boilerplate are noise
            // on a settings screen.
            .replace(/^\[[^\]]+\]\s*/, '')
            .replace(/;\s*please report this issue.*$/i, '')
            .trim() || fallback
    );
}

module.exports = { YtdlpSource };
