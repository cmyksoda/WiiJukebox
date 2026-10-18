// SPDX-License-Identifier: GPL-3.0-only
// YouTube Music: music.youtube.com search, albums and playlists.
//
// Playback is yt-dlp, exactly as for the Web links source, so a
// Premium account works by passing the user's own browser cookies through
// sources.ytmusic.extraArgs (--cookies-from-browser firefox). Search uses the
// same public endpoint the music.youtube.com page calls, which is what
// ytmusicapi and similar open-source clients do; it needs no account.

const { YtdlpSource } = require('./ytdlp');

const SEARCH_URL = 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false';
const SEARCH_TIMEOUT_MS = 10000;
const ART_CACHE_LIMIT = 500;

// Result-type filters, as sent by the music.youtube.com search tabs.
const FILTERS = {
    songs: { params: 'EgWKAQIIAWoMEA4QChADEAQQCRAF', limit: 12 },
    albums: { params: 'EgWKAQIYAWoMEA4QChADEAQQCRAF', limit: 8 },
    playlists: { params: 'Eg-KAQwIABAAGAAgACgBMABqChAEEAMQCRAFEAo=', limit: 6 },
    artists: { params: 'EgWKAQIgAWoMEA4QChADEAQQCRAF', limit: 4 },
};
const GROUP_TITLES = { songs: 'Songs', albums: 'Albums', playlists: 'Playlists', artists: 'Artists' };
const TYPE_LABELS = new Set(['Song', 'Video', 'Album', 'EP', 'Single', 'Playlist', 'Artist', 'Profile']);
const ALBUMS_PREFIX = 'albums/';

const videoId = (url) => /[?&]v=([\w-]{11})/.exec(String(url || ''))?.[1] || null;
const hasCookies = (args) => Array.isArray(args) &&
    args.some((arg) => arg === '--cookies' || arg === '--cookies-from-browser');

function parseClock(text) {
    if (!/^\d+(:\d{1,2}){1,2}$/.test(text || '')) return null;
    return text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

/** Split a subtitle's text runs into the groups the page separates with bullets. */
function subtitleGroups(runs) {
    const groups = [[]];
    for (const run of runs || []) {
        if (run.text.trim() === '•') groups.push([]);
        else groups.at(-1).push(run.text);
    }
    return groups.map((parts) => parts.join('').trim()).filter(Boolean);
}

function pickArtwork(renderer) {
    const thumbs = renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
    const best = thumbs.filter((t) => t?.url).at(-1)?.url;
    if (!best) return null;
    // Square covers come from a size-parameterized host; ask for something sharper.
    return best.replace(/=w\d+-h\d+/, '=w400-h400');
}

/** One music shelf row -> the item shape the WebUI and Wii protocol use. */
function parseRow(kind, renderer) {
    const columns = renderer.flexColumns || [];
    const title = columns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
    if (!title) return null;
    let groups = subtitleGroups(columns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
    if (TYPE_LABELS.has(groups[0])) groups = groups.slice(1);
    const artwork = pickArtwork(renderer);
    const browseId = renderer.navigationEndpoint?.browseEndpoint?.browseId || '';

    if (kind === 'songs') {
        const id = renderer.playlistItemData?.videoId;
        if (!id) return null;
        const duration = parseClock(groups.at(-1));
        const [artist = '', album = ''] = groups;
        return {
            id: `https://music.youtube.com/watch?v=${id}`, type: 'track', title,
            subtitle: [artist, album].filter(Boolean).join(' — '),
            artist, album: duration === null ? '' : album, duration, artwork,
        };
    }
    if (kind === 'albums' && browseId.startsWith('MPRE')) {
        return {
            id: `list/https://music.youtube.com/browse/${browseId}`, type: 'album', title,
            subtitle: groups.join(' — '), artwork,
        };
    }
    if (kind === 'playlists' && browseId.startsWith('VL')) {
        return {
            id: `list/https://music.youtube.com/playlist?list=${browseId.slice(2)}`, type: 'playlist', title,
            subtitle: groups.join(' — '), artwork,
        };
    }
    if (kind === 'artists' && browseId) {
        return { id: `${ALBUMS_PREFIX}${title}`, type: 'artist', title, subtitle: 'Albums', artwork };
    }
    return null;
}

function parseSearch(kind, response, limit) {
    const sections = response?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]
        ?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    const rows = sections.flatMap((section) => section.musicShelfRenderer?.contents || []);
    const items = [];
    for (const row of rows) {
        const item = row.musicResponsiveListItemRenderer && parseRow(kind, row.musicResponsiveListItemRenderer);
        if (item) items.push({ ...item, group: GROUP_TITLES[kind] });
        if (items.length >= limit) break;
    }
    return items;
}

class YtMusicSource extends YtdlpSource {
    static id = 'ytmusic';
    static label = 'YouTube Music';
    static family = 'pull';

    constructor(config = {}, deps = {}) {
        super(config, deps);
        this._art = new Map();
    }

    _remember(items) {
        for (const item of items) {
            const id = item.artwork && videoId(item.id);
            if (!id) continue;
            this._art.delete(id);
            this._art.set(id, item.artwork);
        }
        while (this._art.size > ART_CACHE_LIMIT) this._art.delete(this._art.keys().next().value);
        return items;
    }

    // Search results carry square album covers; yt-dlp only knows the video frame.
    _emitMetadata(meta) {
        const cover = this._art.get(videoId(this._current?.id)) || this._current?.artwork;
        super._emitMetadata(cover ? { ...meta, artwork: cover } : meta);
    }

    _decoratePlaylist(info, items) {
        const covers = (info.thumbnails || []).filter((t) => t?.url);
        const cover = covers.at(-1)?.url || null;
        const album = /^Album - (.+)$/.exec(info.title || '')?.[1] || '';
        return items.map((item) => (item.type === 'track'
            ? { ...item, artwork: cover || item.artwork, album: item.album || album }
            : item));
    }

    async _searchKind(kind, query) {
        const { params, limit } = FILTERS[kind];
        const now = new Date();
        const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
        const res = await (this.deps.fetch || fetch)(SEARCH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: 'https://music.youtube.com' },
            body: JSON.stringify({
                context: { client: { clientName: 'WEB_REMIX', clientVersion: `1.${stamp}.01.00`, hl: 'en' } },
                query, params,
            }),
            signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`YouTube Music search: HTTP ${res.status}`);
        return parseSearch(kind, await res.json(), limit);
    }

    async search(query, opts = {}) {
        const text = String(query || '').trim();
        if (!text || /^https?:\/\//i.test(text)) return super.search(text, opts);
        const kinds = opts.kind ? [opts.kind] : Object.keys(FILTERS);
        const settled = await Promise.allSettled(kinds.map((kind) => this._searchKind(kind, text)));
        const items = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
        if (!items.length && settled.every((r) => r.status === 'rejected')) return this._fallbackSearch(text);
        this._remember(items);
        return { items, total: items.length };
    }

    // If the page format changes, plain titles from yt-dlp still beat an error.
    async _fallbackSearch(query) {
        const out = await this._run([
            '--dump-json', '--flat-playlist', '--no-warnings', '--ignore-config', ...this._extraArgs(),
            '--playlist-end', '20', '--', `https://music.youtube.com/search?q=${encodeURIComponent(query)}#songs`,
        ], { timeoutMs: 30000, what: 'searching' });
        const items = out.split('\n').map((line) => {
            try { return JSON.parse(line); } catch { return null; }
        }).filter((entry) => entry?.url && entry.title).map((entry) => ({
            id: entry.url, type: 'track', title: entry.title, subtitle: '', group: GROUP_TITLES.songs,
        }));
        return { items, total: items.length };
    }

    async browse(opts = {}) {
        const { path = '', offset = 0, limit = 100 } = opts;
        if (path.startsWith(ALBUMS_PREFIX)) {
            const { items } = await this.search(path.slice(ALBUMS_PREFIX.length), { kind: 'albums' });
            return { items: items.slice(offset, offset + limit), total: items.length };
        }
        if (path) return super.browse(opts);

        const root = await super.browse({ offset: 0, limit: 500 });
        const items = root.items.map((item) => (/(\/browse\/MPRE|[?&]list=|\/playlist)/.test(item.id)
            ? { ...item, id: `list/${item.id}`, type: 'playlist' } : item));
        if (hasCookies(this.config.extraArgs)) {
            items.unshift({
                id: 'list/https://music.youtube.com/playlist?list=LM', type: 'playlist',
                title: 'Liked Music', subtitle: 'Your account',
            });
        }
        return { items: items.slice(offset, offset + limit), total: items.length };
    }
}

module.exports = { YtMusicSource, parseSearch };
