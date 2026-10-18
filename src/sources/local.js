// SPDX-License-Identifier: GPL-3.0-only
// Local files: the music in folders on this computer, browsed by its tags or by its folders.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { QueueSource } = require('./queue');
const { LocalLibrary } = require('./local-library');
const { readPicture } = require('./local-tags');
const { shrinkImage } = require('./artwork');

const ART_PREFIX = 'local-art:';
const RESCAN_AFTER_MS = 10 * 60 * 1000;
// A small folder is indexed before its first page is shown; a big one fills in as it goes.
const FIRST_SCAN_WAIT_MS = 1500;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FOLDERS = 50;
const MAX_LISTED_FOLDERS = 1000;
const ART_MEMORY = 64;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const count = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

class LocalSource extends QueueSource {
    static id = 'local';
    static label = 'Local files';
    static family = 'pull';
    static suggests = true;
    static homeRows = [
        { id: 'newest', title: 'Recently added', remote: true },
        { id: 'random', title: 'Random albums', remote: true },
    ];

    constructor(config = {}, deps = {}) {
        super(config, deps);
        this.library = null;
        this._lastScan = 0;
        this._art = new Map();
    }

    get capabilities() {
        return { play: true, pause: true, stop: true, seek: true, browse: true, search: true, ...this.queueCapabilities };
    }

    get folders() {
        return Array.isArray(this.config.folders) ? this.config.folders : [];
    }

    get _ffmpeg() {
        return this.deps.ffmpegPath || 'ffmpeg';
    }

    /** The folders to save, checked and tidied: real folders, each once, none inside another. */
    static cleanFolders(folders) {
        if (!Array.isArray(folders) || folders.length > MAX_FOLDERS || folders.some((f) => typeof f !== 'string')) {
            throw Object.assign(new Error('folders must be a list of folder paths'), { code: 400 });
        }
        const real = [];
        for (const typed of folders) {
            const trimmed = typed.trim().replace(/^~(?=$|[\\/])/, os.homedir());
            if (!trimmed) continue;
            if (!path.isAbsolute(trimmed)) throw Object.assign(new Error(`“${typed}” is not a full folder path`), { code: 400 });
            let resolved;
            try {
                resolved = fs.realpathSync(trimmed);
                if (!fs.statSync(resolved).isDirectory()) throw new Error('not a folder');
            } catch {
                throw Object.assign(new Error(`“${typed}” is not a folder on this computer`), { code: 400 });
            }
            if (!real.includes(resolved)) real.push(resolved);
        }
        const inside = (child, parent) => {
            const rel = path.relative(parent, child);
            return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
        };
        return real.filter((folder) => !real.some((other) => inside(folder, other)));
    }

    _library() {
        if (!this.library) {
            this.library = new LocalLibrary({
                folders: this.folders, ffmpegPath: this._ffmpeg,
                cacheFile: this.deps.configDir ? path.join(this.deps.configDir, 'local-files.json') : null,
            });
            this.library.on('warning', (message) => this._warn(message));
            this.library.load();
        }
        return this.library;
    }

    async connect() {
        if (!this.folders.length) throw new Error('choose a music folder first');
        const library = this._library();
        this._setState('ready');
        const scan = this._rescan(true);
        if (scan && !library.files.size) await Promise.race([scan, delay(FIRST_SCAN_WAIT_MS)]);
    }

    /** Folders change while the server runs, so a library that was scanned a while ago is checked again. */
    _rescan(force = false) {
        const library = this.library;
        if (!library || library.scanning) return null;
        if (!force && Date.now() - this._lastScan < RESCAN_AFTER_MS) return null;
        this._lastScan = Date.now();
        return library.scan().catch((err) => this._warn(`could not scan your music folders: ${err.message}`));
    }

    get _view() {
        return this._library().view;
    }

    // --- browsing -----------------------------------------------------------------

    /**
     *   ''               Artists, Albums, Songs, Folders and, when there are any, Playlists
     *   'artist/<id>'    that artist's albums
     *   'album/<id>'     that album's songs
     *   'dir/<id>'       a folder's folders, then its songs
     *   'playlist/<id>'  the songs of an .m3u playlist found in the folders
     */
    async browse({ path: where = '', offset = 0, limit = 100 } = {}) {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
            throw new Error('invalid library page');
        }
        this._rescan();
        const v = this._view;
        const [kind, id] = String(where).split('/');
        const page = (list, toItem) => ({ items: list.slice(offset, offset + limit).map(toItem), total: list.length });
        const known = (item) => {
            if (!item) throw new Error('that is no longer in your music folders');
            return item;
        };

        if (!kind) return page(this._top(), (item) => item);
        if (kind === 'artists') return page(v.artistList, (artistId) => this._artistItem(v.artists.get(artistId)));
        if (kind === 'artist') return page(known(v.artists.get(id)).albums, (albumId) => this._albumItem(v.albums.get(albumId)));
        if (kind === 'albums') return page(v.albumList, (albumId) => this._albumItem(v.albums.get(albumId)));
        if (kind === 'album') return page(known(v.albums.get(id)).tracks, (trackId) => this._trackItem(trackId));
        if (kind === 'songs') return page(v.songList, (trackId) => this._trackItem(trackId));
        if (kind === 'playlists') return page(v.playlistList, (listId) => this._playlistItem(v.playlists.get(listId)));
        if (kind === 'playlist') return page(known(v.playlists.get(id)).tracks, (trackId) => this._trackItem(trackId));
        if (kind === 'folders' && v.rootDirs.length !== 1) {
            return page(v.rootDirs, (dirId) => this._dirItem(v.dirs.get(dirId)));
        }
        if (kind === 'folders' || kind === 'dir') {
            const dir = known(v.dirs.get(kind === 'dir' ? id : v.rootDirs[0]));
            const entries = [...dir.dirs.map((dirId) => ['dir', dirId]), ...dir.tracks.map((trackId) => ['track', trackId])];
            return page(entries, ([type, entryId]) => (type === 'dir' ? this._dirItem(v.dirs.get(entryId)) : this._trackItem(entryId)));
        }
        throw new Error(`unknown browse path: ${where}`);
    }

    _top() {
        const v = this._view;
        const sofar = this.library.scanning ? ' so far' : '';
        return [
            { id: 'artists', type: 'folder', title: 'Artists', subtitle: count(v.artistList.length, 'artist') },
            { id: 'albums', type: 'folder', title: 'Albums', subtitle: count(v.albumList.length, 'album') },
            // A playlist, so the Wii and the web can play or shuffle everything at once.
            { id: 'songs', type: 'playlist', title: 'Songs', subtitle: count(v.songList.length, 'song') + sofar },
            { id: 'folders', type: 'folder', title: 'Folders', subtitle: 'As they are on this computer' },
            v.playlistList.length ? { id: 'playlists', type: 'folder', title: 'Playlists',
                subtitle: count(v.playlistList.length, 'playlist') } : null,
        ].filter(Boolean);
    }

    async homeRow(row, { limit }) {
        const v = this._view;
        const albums = [...v.albums.values()];
        if (row === 'newest') albums.sort((a, b) => b.added - a.added);
        else if (row === 'random') shuffle(albums);
        else throw new Error(`unknown home row: ${row}`);
        return albums.slice(0, limit).map((album) => this._albumItem(album));
    }

    async search(query, { limit = 50 } = {}) {
        const v = this._view;
        const found = this.library.search(query, limit);
        const items = [
            ...found.artists.map((id) => this._artistItem(v.artists.get(id))),
            ...found.albums.map((id) => this._albumItem(v.albums.get(id))),
            ...found.tracks.map((id) => this._trackItem(id)),
        ];
        return { items, total: items.length };
    }

    _artistItem(artist) {
        const first = this._view.albums.get(artist.albums[0]);
        return {
            id: `artist/${artist.id}`, type: 'artist', title: artist.name,
            subtitle: count(artist.albums.length, 'album'), artwork: first ? this._albumArt(first) : null,
        };
    }

    _albumItem(album) {
        return {
            id: `album/${album.id}`, type: 'album', title: album.title,
            subtitle: [album.artist, album.year].filter(Boolean).join(' · '), artwork: this._albumArt(album),
        };
    }

    _trackItem(id) {
        const v = this._view;
        const track = v.tracks.get(id);
        const album = v.albums.get(track.albumId);
        return {
            id: track.id, type: 'track', title: track.title,
            subtitle: [track.artist, track.album].filter(Boolean).join(' · '),
            artist: track.artist, album: track.album, duration: track.duration,
            artwork: album ? this._albumArt(album) : null,
        };
    }

    // A folder that holds songs plays like an album, so choosing one song queues its neighbors.
    _dirItem(dir) {
        const v = this._view;
        const album = dir.album ? v.albums.get(dir.album) : null;
        const parts = [dir.dirs.length ? count(dir.dirs.length, 'folder') : null, dir.tracks.length ? count(dir.tracks.length, 'song') : null];
        return {
            id: `dir/${dir.id}`, type: dir.tracks.length ? 'album' : 'folder', title: dir.name,
            subtitle: parts.filter(Boolean).join(', '),
            artwork: album ? this._albumArt(album) : dir.cover ? `${ART_PREFIX}dir/${dir.id}` : this._insideArt(dir),
        };
    }

    // A folder of folders, like an artist's, shows the first cover inside it.
    _insideArt(dir) {
        const v = this._view;
        for (let at = dir, depth = 0; at?.dirs.length && depth < 8; depth++) {
            at = v.dirs.get(at.dirs[0]);
            if (at?.album && this._albumArt(v.albums.get(at.album))) return this._albumArt(v.albums.get(at.album));
            if (at?.cover) return `${ART_PREFIX}dir/${at.id}`;
        }
        return null;
    }

    _playlistItem(list) {
        return { id: `playlist/${list.id}`, type: 'playlist', title: list.name, subtitle: count(list.tracks.length, 'song') };
    }

    _albumArt(album) {
        return album.cover || album.pictureTrack ? `${ART_PREFIX}album/${album.id}` : null;
    }

    // --- playback -----------------------------------------------------------------

    async open(item) {
        if (!item) throw new Error('nothing selected');
        const ref = typeof item === 'string' ? { id: item, type: 'track' } : item;
        const v = this._view;
        let ids;
        if (ref.type === 'track') {
            ids = v.tracks.has(ref.id) ? [ref.id] : null;
        } else {
            const [kind, id] = String(ref.id).split('/');
            if (kind === 'album') ids = v.albums.get(id)?.tracks;
            else if (kind === 'dir') ids = v.dirs.get(id)?.tracks;
            else if (kind === 'playlist') ids = v.playlists.get(id)?.tracks;
            else if (kind === 'songs') ids = v.songList;
        }
        if (!ids) throw new Error('that is no longer in your music folders; scan again and try again');
        if (!ids.length) throw new Error('nothing playable in that selection');
        this._queue.load(ids.map((id) => this._trackItem(id)), ref.type === 'track' ? {} : ref);
        return this._openQueueItem();
    }

    async _openQueueItem() {
        const item = this._queue.current;
        if (!item) throw new Error('queue exhausted');
        const track = this._view.tracks.get(item.id);
        try {
            if (!track) throw new Error('gone');
            await fs.promises.access(track.file, fs.constants.R_OK);
        } catch {
            throw new Error(`“${item.title}” isn't in your music folders any more; scan again and try again`);
        }
        this._emitMetadata({
            title: item.title, artist: item.artist || '', album: item.album || '',
            artwork: item.artwork || null, duration: item.duration || null,
        });
        this._startTrack(item);
        this._setState('playing');
        // file: keeps a name that starts with a dash or holds a colon from reading as an option or protocol.
        return { type: 'uri', uri: `file:${track.file}`, seekable: true };
    }

    async disconnect() {
        await this.close();
        this.library?.close();
        this.library = null;
        this._setState('idle');
    }

    async close() {
        this._queue.clear();
        this._setState('ready');
    }

    // --- cover art --------------------------------------------------------------

    /** Cover art for a `local-art:` link, as a JPEG no bigger than 300 pixels: { data, mime } or null. */
    async art(url) {
        if (typeof url !== 'string' || !url.startsWith(ART_PREFIX)) return null;
        const [kind, id] = url.slice(ART_PREFIX.length).split('/');
        const v = this._view;
        const album = kind === 'album' ? v.albums.get(id) : null;
        const embedded = album?.pictureTrack ? v.tracks.get(album.pictureTrack)?.file : null;
        // Pictures inside the files tend to be sharper than the small folder.jpg some players leave behind.
        const source = kind === 'dir' ? v.dirs.get(id)?.cover : embedded || album?.cover;
        if (!source) return null;
        let stat;
        try {
            stat = await fs.promises.stat(source);
        } catch {
            return null;
        }
        const key = crypto.createHash('sha1').update(`${source}\n${stat.size}\n${stat.mtimeMs}`).digest('hex');
        if (!this._art.has(key)) {
            this._art.set(key, this._renderArt(source, source === embedded, key).catch(() => null));
            while (this._art.size > ART_MEMORY) this._art.delete(this._art.keys().next().value);
        }
        const data = await this._art.get(key);
        if (!data) this._art.delete(key);
        return data ? { data, mime: 'image/jpeg' } : null;
    }

    async _renderArt(source, embedded, key) {
        const cacheFile = this.deps.configDir ? path.join(this.deps.configDir, 'local-art', `${key}.jpg`) : null;
        if (cacheFile) {
            try {
                return await fs.promises.readFile(cacheFile);
            } catch {
                /* not made yet */
            }
        }
        const image = embedded ? (await readPicture(source, { ffmpegPath: this._ffmpeg }))?.data : await readSmall(source);
        const jpeg = await shrinkImage(image, { ffmpegPath: this._ffmpeg, size: 300 });
        if (jpeg && cacheFile) {
            await fs.promises.mkdir(path.dirname(cacheFile), { recursive: true });
            await fs.promises.writeFile(cacheFile, jpeg).catch(() => {});
        }
        return jpeg;
    }

    // --- settings -----------------------------------------------------------------

    info() {
        const library = this.folders.length ? this._library() : null;
        const v = library?.view;
        return {
            folders: this.folders,
            suggested: suggestedFolder(),
            scanning: Boolean(library?.scanning),
            progress: library?.progress || null,
            songs: v?.songList.length || 0,
            albums: v?.albumList.length || 0,
            artists: v?.artistList.length || 0,
            scannedAt: library?.scannedAt || null,
            missing: library?.missing || [],
        };
    }

    async action(name, body = {}) {
        if (name === 'rescan') {
            if (!this.folders.length) throw new Error('choose a music folder first');
            this._library();
            this._rescan(true);
            return this.info();
        }
        if (name === 'folders') return listFolders(body.path);
        throw new Error(`${this.label} has no such action`);
    }
}

/** The system's Music folder when it exists: the one to offer before anything is chosen. */
function suggestedFolder() {
    const candidates = [process.env.WIIJUKEBOX_MUSIC_DIR, xdgMusicFolder(), path.join(os.homedir(), 'Music')];
    return candidates.find((folder) => {
        try {
            return folder && path.isAbsolute(folder) && fs.statSync(folder).isDirectory();
        } catch {
            return false;
        }
    }) || null;
}

// Linux desktops name the Music folder in the user's language, recorded in user-dirs.dirs.
function xdgMusicFolder() {
    if (process.platform !== 'linux') return null;
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    try {
        const text = fs.readFileSync(path.join(configHome, 'user-dirs.dirs'), 'utf8');
        const value = /^XDG_MUSIC_DIR="([^"]*)"/m.exec(text)?.[1];
        return value ? value.replace(/^\$HOME(?=\/|$)/, os.homedir()) : null;
    } catch {
        return null;
    }
}

/** The folders inside `where` (the home folder when unset), for choosing a music folder from any device. */
async function listFolders(where) {
    const home = os.homedir();
    const typed = typeof where === 'string' && where.trim() ? where.trim().replace(/^~(?=$|[\\/])/, home) : home;
    const dir = path.resolve(typed);
    let entries;
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
        throw new Error(`can't open “${typed}”`);
    }
    const folders = [];
    for (const entry of entries) {
        if (entry.name.startsWith('.') || folders.length >= MAX_LISTED_FOLDERS) continue;
        const abs = path.join(dir, entry.name);
        let isDir = entry.isDirectory();
        if (entry.isSymbolicLink()) {
            try {
                isDir = (await fs.promises.stat(abs)).isDirectory();
            } catch {
                isDir = false;
            }
        }
        if (isDir) folders.push({ name: entry.name, path: abs });
    }
    folders.sort((a, b) => collator.compare(a.name, b.name));
    const parent = path.dirname(dir);
    return { path: dir, parent: parent === dir ? null : parent, home, suggested: suggestedFolder(), folders };
}

async function readSmall(file) {
    const handle = await fs.promises.open(file, 'r');
    try {
        const { size } = await handle.stat();
        if (size > MAX_IMAGE_BYTES) return null;
        const buffer = Buffer.alloc(size);
        await handle.read(buffer, 0, size, 0);
        return buffer;
    } finally {
        await handle.close();
    }
}

function shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

module.exports = { LocalSource, ART_PREFIX, suggestedFolder };
