// SPDX-License-Identifier: GPL-3.0-only
// The web home screen's data: recent plays from the history, and one set of rows per
// configured service. Each service answers on its own, so a slow or broken one cannot
// hold up or break the rest.

const { REGISTRY } = require('../sources');

// Libraries first, then the shows and links people open most.
const ORDER = ['subsonic', 'jellyfin', 'plex', 'podcasts', 'radio', 'ytmusic', 'ytdlp'];
const ROW_LIMIT = 12;
const RECENT_LIMIT = 24;
const CACHE_MS = 60 * 1000;
const ROW_TIMEOUT_MS = 20 * 1000;

const reason = (err) => String(err?.message || err).slice(0, 200);

function timeout(promise, ms) {
    let timer;
    const late = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('took too long to answer')), ms);
        timer.unref?.();
    });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

class HomeService {
    constructor({ registry, history, art, cacheMs = CACHE_MS, rowTimeoutMs = ROW_TIMEOUT_MS, now = Date.now }) {
        this.registry = registry;
        this.history = history;
        this.art = art;
        this.cacheMs = cacheMs;
        this.rowTimeoutMs = rowTimeoutMs;
        this.now = now;
        this._cache = new Map();
    }

    /** Local data only, so it answers at once: recent plays and which rows each service has. */
    overview() {
        const configured = this._configured();
        const services = [...configured.values()]
            .filter((source) => classFor(source.id).homeRows.length)
            .sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))
            .map((source) => ({
                id: source.id, label: source.label,
                rows: classFor(source.id).homeRows.map(({ id, title }) => ({ id, title })),
            }));
        const recent = this.history.list().filter((entry) => configured.has(entry.source)).slice(0, RECENT_LIMIT)
            .map((entry) => ({
                id: entry.id, source: entry.source, sourceLabel: configured.get(entry.source).label, type: entry.type,
                title: entry.title, subtitle: entry.subtitle, artwork: this.art.link(entry.art), at: entry.at,
                item: this._publish({ ...entry.item, artwork: entry.art || entry.item.artwork }),
            }));
        return { recent, services };
    }

    /** One service's rows. A row that fails carries its own error; a service that will not connect has one. */
    async service(id) {
        const source = this._configured().get(id);
        const rows = source && classFor(id).homeRows;
        if (!rows?.length) throw Object.assign(new Error(`no home rows for ${id}`), { code: 404 });
        try {
            const instance = rows.some((row) => row.remote) ? await this.registry.connect(id) : this.registry.get(id);
            const settled = await Promise.all(rows.map(async (row) => {
                try {
                    const items = await this._row(instance, row);
                    return { id: row.id, title: row.title, items: items.map((item) => this._publish(item)) };
                } catch (err) {
                    return { id: row.id, title: row.title, error: reason(err) };
                }
            }));
            return { source: id, label: source.label, rows: settled };
        } catch (err) {
            return { source: id, label: source.label, error: reason(err) };
        }
    }

    /** Settings or subscriptions changed, so what was cached for this service is stale. */
    forget(id) {
        for (const key of this._cache.keys()) if (key.startsWith(`${id}:`)) this._cache.delete(key);
    }

    _configured() {
        return new Map(this.registry.describe().filter((source) => source.configured).map((source) => [source.id, source]));
    }

    // Only rows that come from a service are cached; saved stations and recent links must show edits at once.
    _row(instance, row) {
        const ctx = { limit: ROW_LIMIT, history: this.history };
        if (!row.remote) return instance.homeRow(row.id, ctx);
        const key = `${instance.id}:${row.id}`;
        const hit = this._cache.get(key);
        if (hit && this.now() - hit.at < this.cacheMs) return hit.promise;
        const promise = timeout(instance.homeRow(row.id, ctx), this.rowTimeoutMs);
        this._cache.set(key, { at: this.now(), promise });
        promise.catch(() => {
            if (this._cache.get(key)?.promise === promise) this._cache.delete(key);
        });
        return promise;
    }

    _publish(item) {
        return { ...item, artwork: this.art.link(item.artwork) };
    }
}

function classFor(id) {
    return REGISTRY.find((source) => source.id === id);
}

module.exports = { HomeService };
