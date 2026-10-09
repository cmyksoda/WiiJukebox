// SPDX-License-Identifier: GPL-3.0-only
// What was started recently, newest first, so the web home screen can offer it again.
// Kept in its own small file rather than config.json, which the settings endpoint reads.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HISTORY_LIMIT = 40;
const MAX_ITEM_BYTES = 8192;
const SAVE_DELAY_MS = 250;

const isUrl = (text) => /^https?:\/\//i.test(text);
const hostOf = (url) => {
    try { return new URL(url).hostname; } catch { return ''; }
};
const text = (value, max = 300) => String(value ?? '').trim().slice(0, max);
const picture = (url) => (typeof url === 'string' && isUrl(url) && url.length <= 2000 ? url : null);

/** One entry per album, playlist, station or loose track, whichever track it started on. */
function identity(source, item) {
    const ref = item.type === 'station' ? item.url || item.id : item.id ?? item.url;
    return ref === undefined ? null : `${source}|${item.type || 'track'}|${ref}`;
}

class PlayHistory {
    /** @param {{file?: string|null, limit?: number, warn?: Function}} [opts] no file keeps it in memory only */
    constructor({ file = null, limit = HISTORY_LIMIT, warn = () => {} } = {}) {
        this.file = file;
        this.limit = limit;
        this._warn = warn;
        this._entries = [];
        this._timer = null;
        this._dirty = false;
        this._load();
    }

    /** Records whatever the pipeline starts, from every entry point (web, Wii, restart). */
    listen(pipeline) {
        pipeline.on('attached', ({ source, item }) => {
            if (source.constructor.replayable === false) return;
            const now = pipeline.nowPlaying;
            // A pasted link has no title of its own; the source learns it while opening.
            this.record(source.id, item, {
                title: source.listTitle || now.title, subtitle: source.listTitle ? '' : now.artist, artwork: now.artwork,
            });
        });
    }

    /** Never throws: remembering a play must not be able to break playing it. */
    record(sourceId, item, hints = {}) {
        try {
            if (!item || typeof item !== 'object') return null;
            const key = identity(sourceId, item);
            const saved = JSON.stringify(item);
            if (!key || saved.length > MAX_ITEM_BYTES) return null;

            let title = text(item.title);
            let subtitle = text(item.type === 'track' ? item.artist || item.subtitle : item.subtitle);
            if (isUrl(subtitle)) subtitle = hostOf(subtitle);
            if (!title || isUrl(title)) {
                const url = item.url || (isUrl(title) ? title : '');
                title = text(item.type === 'station' ? hostOf(url) : hints.title) || hostOf(url) || title;
                subtitle = item.type === 'station' ? '' : text(hints.subtitle);
            }
            if (!title) return null;

            const entry = {
                id: crypto.createHash('sha1').update(key).digest('hex').slice(0, 12), key, source: sourceId,
                type: item.type || 'track', title, subtitle, art: picture(item.artwork) || picture(hints.artwork),
                item: JSON.parse(saved), at: Date.now(),
            };
            this._entries = [entry, ...this._entries.filter((old) => old.key !== key)].slice(0, this.limit);
            this._changed();
            return entry;
        } catch (err) {
            this._warn(`could not record play history (${err.message})`);
            return null;
        }
    }

    list({ source, limit = this.limit } = {}) {
        const entries = source ? this._entries.filter((entry) => entry.source === source) : this._entries;
        return entries.slice(0, limit).map((entry) => structuredClone(entry));
    }

    /** Forgets everything and rewrites the file at once; unlike a lazy save, a failure here is the caller's to report. */
    clear() {
        this._entries = [];
        this._dirty = true;
        this._write();
    }

    /** Writes any pending change now; for shutdown and tests. */
    flush() {
        try {
            this._write();
        } catch (err) {
            this._warn(`could not save play history (${err.message})`);
        }
    }

    _write() {
        clearTimeout(this._timer);
        this._timer = null;
        if (!this._dirty || !this.file) return;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const temp = `${this.file}.tmp`;
        // Artwork links can carry a service token, so keep it owner-only like config.json.
        fs.writeFileSync(temp, JSON.stringify({ version: 1, entries: this._entries }), { mode: 0o600 });
        fs.renameSync(temp, this.file);
        this._dirty = false;
    }

    _changed() {
        this._dirty = true;
        if (this._timer || !this.file) return;
        this._timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
        this._timer.unref?.();
    }

    _load() {
        if (!this.file) return;
        try {
            const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            this._entries = (Array.isArray(saved.entries) ? saved.entries : [])
                .filter((e) => e && typeof e.key === 'string' && typeof e.source === 'string' &&
                    typeof e.title === 'string' && e.item && typeof e.item === 'object')
                .slice(0, this.limit);
        } catch (err) {
            // A damaged history is only a convenience lost; start over rather than refuse to boot.
            if (err.code !== 'ENOENT') this._warn(`play history unreadable (${err.message}); starting empty`);
        }
    }
}

module.exports = { PlayHistory };
