// SPDX-License-Identifier: GPL-3.0-only
const { Source } = require('./base');
const { REPEAT_MODES } = require('../core/play-modes');

function queueStart(items, selection) {
    if (selection.startId === undefined) return 0;
    // Prefer the original position so repeated songs in playlists stay distinct.
    const index = Number.isSafeInteger(selection.startIndex) &&
        items[selection.startIndex]?.id === selection.startId
        ? selection.startIndex : items.findIndex((item) => item.id === selection.startId);
    if (index < 0) throw new Error('selected track is no longer in this album or playlist; refresh and try again');
    return index;
}

// Next and Previous walk a fixed play order, so under shuffle Previous returns to what
// actually played; repeat-all appends a fresh pass so Previous can cross the wrap.
class PlayQueue {
    constructor({ random = Math.random } = {}) {
        this._random = random;
        this._items = [];
        this._order = []; // indexes into _items
        this._pos = -1; // into _order
        this.shuffle = false;
        this.repeat = 'off';
    }

    get items() { return this._items; }
    get length() { return this._items.length; }
    /** Where the current track sits in the original list, or -1. */
    get index() { return this._pos < 0 ? -1 : this._order[this._pos]; }
    get current() { return this._items[this.index] ?? null; }
    get canNext() { return this._pos >= 0 && (this._pos + 1 < this._order.length || this.repeat === 'all'); }
    get canPrevious() { return this._pos > 0; }

    /** A picked track plays first; an unpicked list under shuffle starts anywhere. */
    load(items, selection = {}) {
        const start = queueStart(items, selection);
        this._items = items.slice();
        const all = this._indexes();
        if (!this.shuffle) {
            this._order = all;
            this._pos = start;
            return;
        }
        const first = selection.startId === undefined ? Math.floor(this._random() * all.length) : start;
        this._order = [first, ...this._shuffled(all.filter((i) => i !== first))];
        this._pos = 0;
    }

    clear() {
        this._items = [];
        this._order = [];
        this._pos = -1;
    }

    /** Keeps what has played and the current track; only what is left changes order. */
    setShuffle(on) {
        if (Boolean(on) === this.shuffle) return;
        this.shuffle = Boolean(on);
        if (this._pos < 0) return;
        const played = this._order.slice(0, this._pos + 1);
        this._order = played.concat(this.shuffle
            ? this._shuffled(this._order.slice(this._pos + 1))
            : this._indexes().slice(this.index + 1));
    }

    setRepeat(mode) {
        this.repeat = REPEAT_MODES.includes(mode) ? mode : 'off';
    }

    /** An explicit Next moves on even under repeat-one. Null at the end of the queue. */
    next() {
        if (this._pos < 0) return null;
        if (this._pos + 1 < this._order.length) this._pos++;
        else if (this.repeat === 'all') this._wrap();
        else return null;
        return this.current;
    }

    previous() {
        if (this._pos <= 0) return null;
        this._pos--;
        return this.current;
    }

    /** The current track ended on its own; repeat-one plays it again. */
    advance() {
        return this.repeat === 'one' && this._pos >= 0 ? this.current : this.next();
    }

    save() {
        return { order: this._order.slice(), pos: this._pos };
    }

    restore(saved) {
        this._order = saved.order;
        this._pos = saved.pos;
    }

    /** Swaps the current entry for the tracks it turned out to hold, keeping at most `limit`. */
    expandCurrent(nested, limit) {
        const at = this.index;
        const grow = nested.length - 1;
        const order = [];
        let cursor = 0;
        this._order.forEach((entry, i) => {
            if (i !== this._pos) {
                order.push(entry > at ? entry + grow : entry);
                return;
            }
            cursor = order.length;
            nested.forEach((_, k) => order.push(at + k));
        });
        this._items.splice(at, 1, ...nested);
        this._items.length = Math.min(this._items.length, limit);
        this._pos = order.slice(0, cursor).filter((entry) => entry < limit).length;
        this._order = order.filter((entry) => entry < limit);
    }

    _indexes() {
        return Array.from(this._items, (_, i) => i);
    }

    _shuffled(list) {
        const out = list.slice();
        for (let i = out.length - 1; i > 0; i--) {
            const j = Math.floor(this._random() * (i + 1));
            [out[i], out[j]] = [out[j], out[i]];
        }
        return out;
    }

    _same(a, b) {
        const id = this._items[a]?.id;
        return a === b || (id !== undefined && id === this._items[b]?.id);
    }

    _wrap() {
        const last = this._order[this._pos];
        const pass = this.shuffle ? this._shuffled(this._indexes()) : this._indexes();
        if (this.shuffle && this._same(pass[0], last)) {
            // The track that just played must not open the next pass.
            const others = pass.flatMap((entry, k) => (this._same(entry, last) ? [] : [k]));
            if (others.length) {
                const k = others[Math.floor(this._random() * others.length)];
                [pass[0], pass[k]] = [pass[k], pass[0]];
            }
        }
        this._order = this._order.concat(pass);
        this._pos++;
        // Two passes are enough for Previous to cross the boundary.
        const excess = this._order.length - this._items.length * 2;
        if (excess > 0) {
            this._order.splice(0, excess);
            this._pos -= excess;
        }
    }
}

// A source whose tracks come from a PlayQueue; subclasses supply _openQueueItem(),
// which opens the queue's current track.
class QueueSource extends Source {
    constructor(config, deps) {
        super(config, deps);
        this._queue = new PlayQueue();
    }

    get queue() {
        return { items: this._queue.items, index: this._queue.index };
    }

    /** The queue-related capabilities, for a subclass to spread into its own. */
    get queueCapabilities() {
        return { queue: true, next: this._queue.canNext, previous: this._queue.canPrevious, shuffle: true, repeat: true };
    }

    async setShuffle(on) {
        this._queue.setShuffle(on);
    }

    async setRepeat(mode) {
        this._queue.setRepeat(mode);
    }

    /** The current track ended; the pipeline asks what plays next. */
    async advance() {
        return this._move('advance');
    }

    async next() {
        return this._move('next');
    }

    async previous() {
        return this._move('previous');
    }

    /** Opens the track the queue moves to, or null at the end; a failed open leaves the queue where it was. */
    async _move(step) {
        const before = this._queue.save();
        try {
            return this._queue[step]() ? await this._openQueueItem() : null;
        } catch (err) {
            this._queue.restore(before);
            throw err;
        }
    }
}

module.exports = { queueStart, PlayQueue, QueueSource };
