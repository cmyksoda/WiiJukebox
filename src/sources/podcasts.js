// SPDX-License-Identifier: GPL-3.0-only
// Podcasts: show search and the top chart come from Apple's keyless iTunes
// endpoints, episodes from each show's own RSS feed. An episode plays alone
// (no queue): neighbors in a newest-first list are the wrong "next" for serials.

const { Source } = require('./base');

const SEARCH_URL = 'https://itunes.apple.com/search';
const LOOKUP_URL = 'https://itunes.apple.com/lookup';
const chartUrl = (country) => `https://rss.marketingtools.apple.com/api/v2/${country}/podcasts/top/25/podcasts.json`;

const USER_AGENT = 'WiiJukebox/0.1 (podcast client)';
const FEED_ACCEPT = 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5';
const REQUEST_TIMEOUT_MS = 15000;
// Past this the feed is cut off and the episodes read so far are used.
const MAX_FEED_BYTES = 8 * 1024 * 1024;
const FEED_TTL_MS = 10 * 60 * 1000;
const CHART_TTL_MS = 60 * 60 * 1000;
const FEED_CACHE_LIMIT = 32;
const RESULT_LIMIT = 25;
const HEAD_LIMIT = 256 * 1024;
const SHOW_PREFIX = 'show/';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—',
    ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©',
};
const AUDIO_EXTENSION = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac)$/i;

// --- feed parsing ---------------------------------------------------------

function decodeEntities(text) {
    return text.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (whole, dec, hex, name) => {
        if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
        const code = dec ? Number(dec) : parseInt(hex, 16);
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    });
}

/** Element text with entities decoded; CDATA is taken literally. */
function xmlText(raw) {
    let out = '';
    let last = 0;
    for (const cdata of raw.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)) {
        out += decodeEntities(raw.slice(last, cdata.index)) + cdata[1];
        last = cdata.index + cdata[0].length;
    }
    return (out + decodeEntities(raw.slice(last))).trim();
}

/** Feeds often entity-escape HTML inside CDATA, so decode once more after dropping tags. */
const stripMarkup = (text) => decodeEntities(text.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function parseAttributes(source) {
    const attrs = {};
    for (const match of source.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3]);
    }
    return attrs;
}

const patterns = new Map();
/** First <name> in a block as { attrs, text }, tolerating self-closing and unclosed tags. */
function element(block, name) {
    if (!patterns.has(name)) {
        patterns.set(name, new RegExp(`<${name}(?:\\s([^>]*?))?(?:/>|>(?:([\\s\\S]*?)</${name}\\s*>)?)`, 'i'));
    }
    const match = patterns.get(name).exec(block);
    return match && { attrs: parseAttributes(match[1] || ''), raw: match[2] ?? '' };
}

const textOf = (block, name) => {
    const found = element(block, name);
    return found ? xmlText(found.raw) : '';
};

/** itunes:duration is seconds, M:SS or H:MM:SS, sometimes with a fraction. */
function parseDuration(value) {
    const text = String(value || '').trim();
    if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(text)) return null;
    const seconds = Math.round(text.split(':').reduce((total, part) => total * 60 + Number(part), 0));
    return seconds > 0 ? seconds : null;
}

function isAudio({ type = '', url }) {
    if (/^(audio\/|application\/ogg)/i.test(type)) return true;
    if (type && !/^(application|binary)\/octet-stream$/i.test(type)) return false;
    return AUDIO_EXTENSION.test(new URL(url).pathname);
}

function enclosureOf(block) {
    for (const tag of ['enclosure', 'media:content']) {
        for (const match of block.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))) {
            const attrs = parseAttributes(match[1]);
            try {
                const url = httpLink(attrs.url);
                if (isAudio({ type: attrs.type, url })) return url;
            } catch { /* not a usable address; try the next candidate */ }
        }
    }
    return null;
}

function imageOf(block) {
    const href = element(block, 'itunes:image')?.attrs.href;
    try { return href ? httpLink(href) : ''; } catch { return ''; }
}

function parseEpisode(block) {
    const url = enclosureOf(block);
    if (!url) return null;
    const date = Date.parse(textOf(block, 'pubDate'));
    return {
        id: textOf(block, 'guid') || url,
        title: stripMarkup(textOf(block, 'title')) || 'Untitled episode',
        url,
        duration: parseDuration(textOf(block, 'itunes:duration')),
        published: Number.isNaN(date) ? null : date,
        artwork: imageOf(block),
    };
}

/** Find </item> with indexOf so a feed of unclosed tags cannot make this quadratic. */
function* itemBlocks(xml) {
    const open = /<item[\s>]/gi;
    for (let match = open.exec(xml); match; match = open.exec(xml)) {
        const end = xml.indexOf('</item>', match.index);
        if (end < 0) return;
        yield xml.slice(match.index, end);
        open.lastIndex = end;
    }
}

function parseFeed(xml) {
    if (!/<channel[\s>]/i.test(xml)) throw new Error('that address is not an RSS podcast feed');
    const firstItem = xml.search(/<item[\s>]/i);
    const head = xml.slice(0, Math.min(firstItem < 0 ? xml.length : firstItem, HEAD_LIMIT));
    // The logo's own <title> must not pass for the show's.
    const logo = head.search(/<image[\s>]/i);
    const logoEnd = logo < 0 ? -1 : head.indexOf('</image>', logo);
    const channel = logo < 0 ? head : head.slice(0, logo) + (logoEnd < 0 ? '' : head.slice(logoEnd + 8));
    const logoUrl = logo < 0 ? '' : textOf(head.slice(logo, logoEnd < 0 ? undefined : logoEnd), 'url');

    const owner = element(channel, 'itunes:owner');
    const episodes = [];
    for (const block of itemBlocks(xml)) {
        const episode = parseEpisode(block);
        if (episode) episodes.push(episode);
    }
    if (episodes.every((episode) => episode.published !== null)) episodes.sort((a, b) => b.published - a.published);

    return {
        title: stripMarkup(textOf(channel, 'title')),
        author: stripMarkup(textOf(channel, 'itunes:author') || textOf(owner?.raw || '', 'itunes:name')),
        description: stripMarkup(textOf(channel, 'itunes:summary') || textOf(channel, 'description')).slice(0, 600),
        artwork: imageOf(channel) || (/^https?:/i.test(logoUrl) ? logoUrl : ''),
        episodes,
    };
}

function decodeXml(bytes) {
    const declared = /<\?xml[^>]*encoding=["']([\w.:-]+)["']/i.exec(bytes.toString('latin1', 0, 200))?.[1];
    try {
        return new TextDecoder(declared || 'utf-8').decode(bytes);
    } catch {
        return bytes.toString('utf8');
    }
}

async function readCapped(res, limit) {
    if (!res.body?.getReader) return Buffer.from(await res.arrayBuffer()).subarray(0, limit);
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
    }
    await reader.cancel().catch(() => {});
    return Buffer.concat(chunks).subarray(0, limit);
}

// --- small helpers --------------------------------------------------------

function httpLink(value) {
    let link;
    try {
        link = new URL(String(value || '').trim());
    } catch {
        throw new Error('not a valid web address');
    }
    if (!/^https?:$/.test(link.protocol) || link.username || link.password) {
        throw new Error('use an HTTP(S) address without embedded credentials');
    }
    return link.toString();
}

/** Apple's artwork URLs carry their size; ask for one that suits cards and the Wii. */
const sizedArtwork = (url) => String(url || '').replace(/\/\d+x\d+(bb)?\.(jpg|png)$/i, '/400x400$1.$2');

const fmtClock = (seconds) => {
    if (!(seconds > 0)) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

const fmtDate = (ms) => {
    if (ms === null) return '';
    const date = new Date(ms);
    return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
};

const reason = (err) => (err.name === 'TimeoutError' ? 'timed out' : err.cause?.code || err.message);

function checkPage(offset, limit) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw new Error('invalid library page');
    }
}

class PodcastsSource extends Source {
    static id = 'podcasts';
    static label = 'Podcasts';
    static family = 'pull';

    constructor(config = {}, deps = {}) {
        super(config, deps);
        this._feeds = new Map();
        this._downloads = new Map();
        this._chart = null;
    }

    get capabilities() {
        return { play: true, pause: true, stop: true, seek: true, browse: true, search: true };
    }

    get _subscriptions() {
        return this.config.subscriptions || [];
    }

    get _country() {
        return /^[a-z]{2}$/i.test(this.config.country || '') ? this.config.country.toLowerCase() : 'us';
    }

    async connect() {
        this._setState('ready');
    }

    // --- network ------------------------------------------------------------

    async _get(url, accept) {
        const res = await (this.deps.fetch || fetch)(url, {
            headers: { 'User-Agent': USER_AGENT, Accept: accept },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res;
    }

    /** Apple's chart host answers 502/504 now and then, so one retry on a server error. */
    async _json(url) {
        for (let attempt = 1; ; attempt++) {
            try {
                return await (await this._get(url, 'application/json')).json();
            } catch (err) {
                if (attempt === 2 || !/^HTTP 5/.test(err.message)) throw new Error(`Apple Podcasts: ${reason(err)}`);
            }
        }
    }

    async _download(url) {
        try {
            return parseFeed(decodeXml(await readCapped(await this._get(url, FEED_ACCEPT), MAX_FEED_BYTES)));
        } catch (err) {
            throw new Error(`could not load the feed (${reason(err)})`);
        }
    }

    /** Parsed feed, cached briefly; a stale copy beats an error when the host is down. */
    async _feed(url) {
        const hit = this._feeds.get(url);
        if (hit && Date.now() - hit.at < FEED_TTL_MS) return hit.feed;
        if (!this._downloads.has(url)) {
            const task = this._download(url).then((feed) => {
                this._feeds.delete(url);
                this._feeds.set(url, { at: Date.now(), feed });
                while (this._feeds.size > FEED_CACHE_LIMIT) this._feeds.delete(this._feeds.keys().next().value);
                return feed;
            }).finally(() => this._downloads.delete(url));
            this._downloads.set(url, task);
        }
        try {
            return await this._downloads.get(url);
        } catch (err) {
            if (hit) return hit.feed;
            throw err;
        }
    }

    // --- items --------------------------------------------------------------

    _showItem({ feedUrl, title, author, artwork }) {
        const url = httpLink(feedUrl);
        return {
            id: `${SHOW_PREFIX}${url}`, type: 'folder', title: title || url, subtitle: author || '',
            artwork: sizedArtwork(artwork) || null, feedUrl: url,
            subscribed: this._subscriptions.some((saved) => saved.feedUrl === url),
        };
    }

    _subscriptionItems() {
        return [...this._subscriptions]
            .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
            .map((saved) => this._showItem(saved));
    }

    _episodeItem(episode, show) {
        return {
            id: episode.id, type: 'track', title: episode.title,
            subtitle: [fmtDate(episode.published), fmtClock(episode.duration)].filter(Boolean).join(' · '),
            artist: show.title, album: '', duration: episode.duration,
            published: episode.published === null ? null : new Date(episode.published).toISOString(),
            artwork: episode.artwork || show.artwork || null, url: episode.url,
        };
    }

    // --- browsing and search --------------------------------------------------

    /**
     * Browse paths:
     *   ''               -> Subscriptions and Top shows
     *   'subscriptions'  -> saved shows
     *   'top'            -> Apple's chart
     *   'show/<feedUrl>' -> that show's episodes, newest first
     */
    async browse({ path = '', offset = 0, limit = 100 } = {}) {
        checkPage(offset, limit);
        const page = (items) => ({ items: items.slice(offset, offset + limit), total: items.length });

        if (!path) {
            const count = this._subscriptions.length;
            return page([
                { id: 'subscriptions', type: 'folder', title: 'Subscriptions',
                    subtitle: `${count} ${count === 1 ? 'show' : 'shows'}` },
                { id: 'top', type: 'folder', title: 'Top shows', subtitle: 'Apple Podcasts chart' },
            ]);
        }
        if (path === 'subscriptions') return page(this._subscriptionItems());
        if (path === 'top') return page(await this._topShows());
        if (path.startsWith(SHOW_PREFIX)) return this._episodes(path.slice(SHOW_PREFIX.length), offset, limit);
        throw new Error(`unknown browse path: ${path}`);
    }

    async _episodes(feedUrl, offset, limit) {
        const url = httpLink(feedUrl);
        const feed = await this._feed(url);
        const saved = this._subscriptions.find((entry) => entry.feedUrl === url);
        const show = {
            id: `${SHOW_PREFIX}${url}`, feedUrl: url, title: feed.title || saved?.title || url,
            author: feed.author || saved?.author || '', description: feed.description,
            artwork: saved?.artwork || feed.artwork || null, subscribed: Boolean(saved),
        };
        return {
            items: feed.episodes.slice(offset, offset + limit).map((episode) => this._episodeItem(episode, show)),
            total: feed.episodes.length,
            show,
        };
    }

    async search(query) {
        const text = String(query || '').trim();
        if (!text) return { items: [], total: 0 };

        // A pasted feed address finds that one show, for feeds Apple does not list.
        if (/^https?:\/\//i.test(text)) {
            const url = httpLink(text);
            const feed = await this._feed(url);
            return { items: [this._showItem({ feedUrl: url, ...feed })], total: 1 };
        }

        const params = new URLSearchParams({ media: 'podcast', entity: 'podcast', term: text,
            limit: String(RESULT_LIMIT), country: this._country });
        const { results = [] } = await this._json(`${SEARCH_URL}?${params}`);
        return this._appleShows(results);
    }

    _appleShows(results) {
        const items = [];
        for (const result of results) {
            try {
                items.push(this._showItem({ feedUrl: result.feedUrl, title: result.collectionName,
                    author: result.artistName, artwork: result.artworkUrl600 || result.artworkUrl100 }));
            } catch { /* some listings have no usable feed address */ }
        }
        return { items, total: items.length };
    }

    /** The chart lists collection ids only, so the lookup API supplies each feed address. */
    async _topShows() {
        if (!this._chart || Date.now() - this._chart.at >= CHART_TTL_MS) {
            const chart = await this._json(chartUrl(this._country));
            const ids = (chart.feed?.results || []).map((entry) => String(entry.id)).filter((id) => /^\d+$/.test(id));
            let shows = [];
            if (ids.length) {
                const params = new URLSearchParams({ id: ids.join(','), entity: 'podcast', country: this._country });
                const { results = [] } = await this._json(`${LOOKUP_URL}?${params}`);
                const byId = new Map(results.map((result) => [String(result.collectionId), result]));
                shows = ids.map((id) => byId.get(id)).filter(Boolean);
            }
            this._chart = { at: Date.now(), shows };
        }
        return this._appleShows(this._chart.shows).items;
    }

    // --- subscriptions --------------------------------------------------------

    /** Called by the WebUI route POST /api/sources/podcasts/action/<name>. */
    async action(name, body = {}) {
        if (name === 'subscribe') return this._subscribe(body);
        if (name === 'unsubscribe') return this._unsubscribe(body);
        throw new Error(`unknown podcast action: ${name}`);
    }

    _saveSubscriptions(subscriptions) {
        this.config.subscriptions = subscriptions;
        this.emit('config', { subscriptions });
        return { ok: true, subscriptions: this._subscriptionItems() };
    }

    async _subscribe(body) {
        const feedUrl = httpLink(body.feedUrl);
        // Search results already carry the details; only a bare address needs the feed.
        const feed = body.title ? null : await this._feed(feedUrl);
        const artwork = String(body.artwork || feed?.artwork || '');
        const entry = {
            feedUrl, title: String(body.title || feed?.title || feedUrl).slice(0, 200),
            author: String(body.author || feed?.author || '').slice(0, 200),
            artwork: /^https?:\/\//i.test(artwork) ? artwork : '',
        };
        return this._saveSubscriptions([...this._subscriptions.filter((saved) => saved.feedUrl !== feedUrl), entry]);
    }

    async _unsubscribe(body) {
        const feedUrl = httpLink(body.feedUrl);
        return this._saveSubscriptions(this._subscriptions.filter((saved) => saved.feedUrl !== feedUrl));
    }

    // --- playback -------------------------------------------------------------

    async open(item) {
        const episode = typeof item === 'string' ? { url: item } : item;
        if (!episode?.url) throw new Error('choose an episode to play');
        const url = httpLink(episode.url);
        const duration = episode.duration > 0 ? Number(episode.duration) : null;

        this._emitMetadata({
            title: episode.title || new URL(url).hostname, artist: episode.artist || '', album: '',
            artwork: episode.artwork || null, duration,
        });
        this._setState('playing');

        // Some hosts refuse ffmpeg's default agent; ranges serve the seek bar.
        return { type: 'uri', uri: url, headers: { 'User-Agent': USER_AGENT }, seekable: true };
    }

    /** A finished episode ends playback rather than starting an older one. */
    async advance() {
        return null;
    }

    async disconnect() {
        await this.close();
        this._setState('idle');
    }

    async close() {
        this._setState('ready');
    }
}

module.exports = { PodcastsSource, parseFeed, parseDuration };
