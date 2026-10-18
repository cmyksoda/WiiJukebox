// SPDX-License-Identifier: GPL-3.0-only
// What Local files knows about the chosen folders. Tags are kept on disk, so a rescan only
// rereads files whose size or modification time changed.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { EventEmitter } = require('node:events');
const { readTags, AUDIO_EXTENSIONS } = require('./local-tags');

const CACHE_VERSION = 1;
const IMAGE_FILE = /\.(jpe?g|png|webp)$/i;
const PLAYLIST_FILE = /\.m3u8?$/i;
const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'albumart'];
const DISC_FOLDER = /^(cd|dis[ck])\s*\d+$/i;
const MAX_DEPTH = 32;
const MAX_FILES = 250000;
const MAX_PLAYLIST_BYTES = 1024 * 1024;
const READ_CONCURRENCY = 4;
const REBUILD_EVERY_MS = 2000;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = (key) => (a, b) => collator.compare(a[key], b[key]);
const hash = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
/** For matching and grouping only: case, accents and full-width forms don't make a different name. */
const fold = (text) => String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
const fileKey = (root, rel) => `${root}\n${rel}`;

class LocalLibrary extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string[]} opts.folders  absolute paths
     * @param {string} [opts.cacheFile]
     * @param {Function} [opts.readTags]  for tests
     */
    constructor({ folders, cacheFile = null, readTags: read = readTags, ffmpegPath = 'ffmpeg' }) {
        super();
        this.folders = folders.slice();
        this.cacheFile = cacheFile;
        this._read = (file) => read(file, { ffmpegPath });
        this.files = new Map(); // fileKey -> { root, rel, size, mtime, tags }
        this.covers = new Map(); // fileKey of a folder -> cover image name
        this.lists = new Map(); // fileKey of a playlist -> [fileKey of each entry]
        this.missing = [];
        this.scannedAt = null;
        this.progress = null;
        this._scanning = null;
        this._closed = false;
        this._build();
    }

    /** A library whose folders were changed stops scanning, so it can't overwrite the new index. */
    close() {
        this._closed = true;
    }

    get scanning() {
        return Boolean(this._scanning);
    }

    load() {
        if (!this.cacheFile) return;
        let saved;
        try {
            saved = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
        } catch {
            return;
        }
        if (saved?.version !== CACHE_VERSION) return;
        const wanted = new Set(this.folders);
        for (const [root, rel, size, mtime, tags] of saved.files || []) {
            if (wanted.has(root)) this.files.set(fileKey(root, rel), { root, rel, size, mtime, tags });
        }
        for (const [key, name] of saved.covers || []) if (wanted.has(key.split('\n')[0])) this.covers.set(key, name);
        for (const [key, entries] of saved.lists || []) if (wanted.has(key.split('\n')[0])) this.lists.set(key, entries);
        this.scannedAt = saved.scannedAt || null;
        this._build();
    }

    _save() {
        if (!this.cacheFile) return;
        const data = {
            version: CACHE_VERSION,
            scannedAt: this.scannedAt,
            files: [...this.files.values()].map((f) => [f.root, f.rel, f.size, f.mtime, f.tags]),
            covers: [...this.covers],
            lists: [...this.lists],
        };
        const temp = `${this.cacheFile}.${process.pid}.tmp`;
        try {
            fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
            fs.writeFileSync(temp, JSON.stringify(data));
            fs.renameSync(temp, this.cacheFile);
        } catch (err) {
            fs.rmSync(temp, { force: true });
            this.emit('warning', `could not save the Local files index: ${err.message}`);
        }
    }

    /** One scan at a time; asking again while one runs waits for it. */
    scan() {
        if (!this._scanning) {
            this._scanning = this._scan().finally(() => {
                this._scanning = null;
                this.progress = null;
            });
        }
        return this._scanning;
    }

    async _scan() {
        const found = new Map();
        const covers = new Map();
        const playlists = [];
        const missing = [];
        this.progress = { found: 0, read: 0, toRead: 0 };
        for (const root of this.folders) {
            try {
                if (!(await fs.promises.stat(root)).isDirectory()) throw new Error('not a folder');
            } catch {
                // An unplugged drive keeps what was known about it, ready for when it's back.
                missing.push(root);
                for (const [key, file] of this.files) if (file.root === root) found.set(key, file);
                for (const [key, name] of this.covers) if (key.startsWith(`${root}\n`)) covers.set(key, name);
                continue;
            }
            await this._walk(root, found, covers, playlists);
        }

        const stale = [...found.values()].filter((file) => {
            const known = this.files.get(fileKey(file.root, file.rel));
            if (known && known.size === file.size && known.mtime === file.mtime && known.tags) {
                file.tags = known.tags;
                return false;
            }
            return true;
        });
        this.progress.toRead = stale.length;
        let rebuilt = Date.now();
        await mapLimit(stale, READ_CONCURRENCY, async (file) => {
            if (this._closed) return;
            file.tags = compactTags(await this._read(path.join(file.root, file.rel)).catch(() => null));
            this.files.set(fileKey(file.root, file.rel), file);
            this.progress.read++;
            // A first scan of a big folder shows its music as it goes.
            if (Date.now() - rebuilt > REBUILD_EVERY_MS) {
                rebuilt = Date.now();
                this._build();
            }
        });

        if (this._closed) return;
        this.files = new Map([...found].map(([key, file]) => [key, this.files.get(key) || file]));
        this.covers = covers;
        this.lists = new Map();
        for (const list of playlists) this.lists.set(list.key, await this._readPlaylist(list));
        this.missing = missing;
        this.scannedAt = Date.now();
        this._build();
        this._save();
    }

    async _walk(root, found, covers, playlists) {
        const seenDirs = new Set();
        const stack = [{ dir: root, rel: '', depth: 0 }];
        while (stack.length) {
            const { dir, rel, depth } = stack.pop();
            let real;
            try {
                real = await fs.promises.realpath(dir);
            } catch {
                continue;
            }
            // Symlinked folders are followed once, so a link back up the tree can't loop.
            if (seenDirs.has(real)) continue;
            seenDirs.add(real);
            let entries;
            try {
                entries = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch {
                continue;
            }
            const images = [];
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue;
                const abs = path.join(dir, entry.name);
                const childRel = rel ? `${rel}/${entry.name}` : entry.name;
                let stat;
                try {
                    stat = entry.isSymbolicLink() ? await fs.promises.stat(abs) : null;
                } catch {
                    continue;
                }
                const isDir = stat ? stat.isDirectory() : entry.isDirectory();
                const isFile = stat ? stat.isFile() : entry.isFile();
                if (isDir) {
                    if (depth < MAX_DEPTH) stack.push({ dir: abs, rel: childRel, depth: depth + 1 });
                } else if (isFile && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                    if (found.size >= MAX_FILES) continue;
                    try {
                        const info = stat || await fs.promises.stat(abs);
                        found.set(fileKey(root, childRel), { root, rel: childRel, size: info.size, mtime: Math.round(info.mtimeMs) });
                        this.progress.found = found.size;
                    } catch {
                        /* gone since the listing */
                    }
                } else if (isFile && IMAGE_FILE.test(entry.name)) {
                    images.push(entry.name);
                } else if (isFile && PLAYLIST_FILE.test(entry.name)) {
                    playlists.push({ key: fileKey(root, childRel), abs, root, rel: childRel });
                }
            }
            const cover = pickCover(images);
            if (cover) covers.set(fileKey(root, rel), cover);
        }
    }

    /** The playlist's entries that are songs in these folders; anything else is left out. */
    async _readPlaylist({ abs }) {
        let text;
        try {
            const handle = await fs.promises.open(abs, 'r');
            try {
                const buffer = Buffer.alloc(MAX_PLAYLIST_BYTES);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                text = buffer.subarray(0, bytesRead).toString('utf8');
            } finally {
                await handle.close();
            }
        } catch {
            return [];
        }
        const entries = [];
        for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
            let line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            if (/^file:\/\//i.test(line)) {
                try {
                    line = fileURLToPath(line);
                } catch {
                    continue;
                }
            } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) continue;
            const target = path.resolve(path.dirname(abs), line.replace(/\\/g, path.sep));
            const key = this._keyFor(target);
            if (key && this.files.has(key)) entries.push(key);
        }
        return entries;
    }

    _keyFor(abs) {
        for (const root of this.folders) {
            const rel = path.relative(root, abs);
            if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return fileKey(root, rel.split(path.sep).join('/'));
        }
        return null;
    }

    // --- views ------------------------------------------------------------------

    _build() {
        const tracks = new Map();
        const byKey = new Map();
        const groups = new Map();
        const dirs = new Map();
        const roots = this.folders.filter((root) => !this.missing.includes(root));
        const rootDirs = roots.map((root) => this._dir(dirs, root, ''));

        for (const [key, file] of this.files) {
            if (!file.tags || this.missing.includes(file.root)) continue;
            const t = file.tags;
            const parts = file.rel.split('/');
            const name = parts.pop();
            const dirRel = parts.join('/');
            const dir = this._dir(dirs, file.root, dirRel);
            const track = {
                id: hash(key), key, file: path.join(file.root, ...file.rel.split('/')),
                title: t.title || name.replace(/\.[^.]+$/, ''), artist: t.artist || null,
                albumArtist: t.albumArtist || null, album: t.album || null, track: t.track ?? null,
                disc: t.disc ?? null, year: t.year ?? null, duration: t.duration ?? null,
                hasPicture: Boolean(t.hasPicture), compilation: Boolean(t.compilation),
                added: file.mtime, name, dir: dir.id,
            };
            tracks.set(track.id, track);
            byKey.set(key, track.id);
            dir.tracks.push(track.id);

            // Tracks of one album sit in one folder (or its CD1/CD2 folders) unless an album artist ties them together.
            const home = DISC_FOLDER.test(parts.at(-1) || '') ? parts.slice(0, -1).join('/') : dirRel;
            const owner = track.albumArtist ? `aa:${fold(track.albumArtist)}` : `dir:${fileKey(file.root, home)}`;
            const title = track.album || (home ? home.split('/').pop() : path.basename(file.root));
            const groupKey = `${fold(title)}\n${owner}`;
            if (!groups.has(groupKey)) groups.set(groupKey, { id: hash(groupKey), title, tracks: [], dirs: new Set() });
            const group = groups.get(groupKey);
            group.tracks.push(track);
            group.dirs.add(fileKey(file.root, dirRel)).add(fileKey(file.root, home));
            track.albumId = group.id;
        }

        const albums = new Map();
        const artists = new Map();
        for (const group of groups.values()) {
            group.tracks.sort(trackOrder);
            const artist = albumArtistOf(group.tracks);
            const cover = [...group.dirs].map((key) => this.covers.get(key) && path.join(...dirPath(key), this.covers.get(key))).find(Boolean);
            const album = {
                id: group.id, title: group.title, artist, year: Math.max(0, ...group.tracks.map((t) => t.year || 0)) || null,
                tracks: group.tracks.map((t) => t.id), added: Math.max(...group.tracks.map((t) => t.added)),
                cover: cover || null, pictureTrack: group.tracks.find((t) => t.hasPicture)?.id || null,
            };
            albums.set(album.id, album);
            const artistId = hash(fold(artist));
            if (!artists.has(artistId)) artists.set(artistId, { id: artistId, name: artist, albums: [] });
            artists.get(artistId).albums.push(album.id);
        }
        for (const artist of artists.values()) {
            artist.albums.sort((a, b) => (albums.get(a).year || 0) - (albums.get(b).year || 0) ||
                collator.compare(albums.get(a).title, albums.get(b).title));
        }

        for (const dir of dirs.values()) {
            dir.tracks.sort((a, b) => trackOrder(tracks.get(a), tracks.get(b)));
            dir.cover = this.covers.get(fileKey(dir.root, dir.rel)) ? path.join(dir.abs, this.covers.get(fileKey(dir.root, dir.rel))) : null;
            dir.album = dir.tracks.length ? tracks.get(dir.tracks[0]).albumId : null;
        }
        // Only folders with music somewhere inside them are worth showing.
        const keep = new Set();
        for (const dir of dirs.values()) {
            if (!dir.tracks.length) continue;
            for (let at = dir; at && !keep.has(at.id); at = dirs.get(at.parent)) keep.add(at.id);
        }
        for (const dir of dirs.values()) {
            dir.dirs = dir.dirs.filter((id) => keep.has(id)).sort((a, b) => collator.compare(dirs.get(a).name, dirs.get(b).name));
        }

        const playlists = new Map();
        for (const [key, entries] of this.lists) {
            const ids = entries.map((entry) => byKey.get(entry)).filter(Boolean);
            if (!ids.length) continue;
            const id = hash(key);
            playlists.set(id, { id, name: key.split('\n')[1].split('/').pop().replace(/\.m3u8?$/i, ''), tracks: ids });
        }

        this.view = {
            tracks, albums, artists, dirs, playlists, rootDirs: rootDirs.map((dir) => dir.id),
            songList: [...tracks.values()].sort((a, b) => collator.compare(a.title, b.title) || trackOrder(a, b)).map((t) => t.id),
            albumList: [...albums.values()].sort((a, b) => collator.compare(a.title, b.title) || collator.compare(a.artist, b.artist)).map((a) => a.id),
            artistList: [...artists.values()].sort(byName('name')).map((a) => a.id),
            playlistList: [...playlists.values()].sort(byName('name')).map((p) => p.id),
        };
    }

    _dir(dirs, root, rel) {
        const id = hash(fileKey(root, rel));
        if (dirs.has(id)) return dirs.get(id);
        const parent = rel ? this._dir(dirs, root, rel.split('/').slice(0, -1).join('/')) : null;
        const dir = {
            id, root, rel, abs: path.join(root, ...(rel ? rel.split('/') : [])),
            name: rel ? rel.split('/').pop() : path.basename(root) || root,
            parent: parent?.id || null, dirs: [], tracks: [],
        };
        dirs.set(id, dir);
        if (parent) parent.dirs.push(id);
        return dir;
    }

    /** Accent- and case-blind matches of `query` in names, albums and titles. */
    search(query, limit = 50) {
        const words = fold(query).split(/\s+/).filter(Boolean);
        if (!words.length) return { artists: [], albums: [], tracks: [] };
        const hit = (...fields) => {
            const text = fold(fields.filter(Boolean).join(' '));
            return words.every((word) => text.includes(word));
        };
        const { artists, albums, tracks } = this.view;
        return {
            artists: this.view.artistList.filter((id) => hit(artists.get(id).name)).slice(0, limit),
            albums: this.view.albumList.filter((id) => hit(albums.get(id).title, albums.get(id).artist)).slice(0, limit),
            tracks: this.view.songList.filter((id) => {
                const t = tracks.get(id);
                return hit(t.title, t.artist, t.album);
            }).slice(0, limit),
        };
    }
}

function trackOrder(a, b) {
    return (a.disc ?? 0) - (b.disc ?? 0) || (a.track ?? Infinity) - (b.track ?? Infinity) ||
        collator.compare(a.name, b.name);
}

function albumArtistOf(tracks) {
    const tagged = mostCommon(tracks.map((t) => t.albumArtist).filter(Boolean));
    if (tagged) return tagged;
    const names = new Set(tracks.map((t) => t.artist).filter(Boolean).map(fold));
    if (tracks.some((t) => t.compilation) || names.size > 1) return 'Various Artists';
    return tracks.find((t) => t.artist)?.artist || 'Unknown artist';
}

function mostCommon(values) {
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function pickCover(images) {
    if (!images.length) return null;
    const named = (name) => COVER_NAMES.indexOf(name.replace(/\.[^.]+$/, '').toLowerCase());
    const ranked = images.slice().sort((a, b) => {
        const ra = named(a);
        const rb = named(b);
        return (ra < 0 ? Infinity : ra) - (rb < 0 ? Infinity : rb) || collator.compare(a, b);
    });
    return ranked[0];
}

function dirPath(key) {
    const [root, rel] = key.split('\n');
    return [root, ...(rel ? rel.split('/') : [])];
}

/** The tags worth keeping, without empty fields, so the saved index stays small. */
function compactTags(tags) {
    const out = {};
    for (const [key, value] of Object.entries(tags || {})) {
        if (value !== null && value !== undefined && value !== '' && value !== false) out[key] = value;
    }
    return out;
}

async function mapLimit(items, limit, fn) {
    let next = 0;
    const worker = async () => {
        while (next < items.length) await fn(items[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

module.exports = { LocalLibrary };
