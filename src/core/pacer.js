// Real-time PCM pacer: the thing that makes the stream *persistent*.
//
// Sources push decoded PCM in at whatever rate they happen to produce it -- a
// radio stream arrives at roughly real time, a local file decodes far faster
// than real time, an AirPlay receiver arrives in bursts. The encoder, meanwhile,
// must be fed at exactly real time forever, because the moment it runs dry or
// gets overrun the MP3 stream hiccups and listeners may drop the connection.
//
// So everything funnels through here: push() fills a buffer, and a timer drains
// exactly BYTES_PER_SECOND into the encoder no matter what. When the buffer runs
// dry the pacer emits silence instead of stalling. That single behaviour is what
// lets a source disconnect, be swapped, and reconnect without the Wii ever
// noticing the stream went away.

const { EventEmitter } = require('events');
const { BYTES_PER_SECOND, FRAME_BYTES, alignToFrame, bytesForMs } = require('./format');

// How often the drain timer fires. Short enough that an underrun costs only a
// few ms of silence, long enough not to spin the event loop needlessly.
const TICK_MS = 20;

// How much PCM to accumulate before the pacer starts draining a newly-connected
// source. Absorbs network jitter so a momentary stall doesn't punch a hole in
// the audio. ~600ms is well under what anyone notices when switching tracks.
const PREBUFFER_MS = 600;

// Hard ceiling on the buffer. On overflow the oldest audio is dropped, since for
// a live stream stale audio is worthless. This is a last resort for sources that
// cannot be throttled -- a source that *can* be paused should never reach it.
const MAX_BUFFER_MS = 4000;

// Backpressure threshold. push() reports "full" here rather than at capacity,
// leaving headroom for audio already in flight: a paused ffmpeg still has
// decoded bytes sitting in the OS pipe, and the gap between asking it to stop
// and it actually stopping has to fit under the ceiling or we drop audio anyway.
const HIGH_WATER_MS = 1500;

// Resume threshold. Deliberately well below HIGH_WATER_MS so the producer runs
// in bursts instead of oscillating on and off at every tick.
const LOW_WATER_MS = 500;

class Pacer extends EventEmitter {
    /**
     * @param {object} [opts]
     * @param {(chunk: Buffer) => boolean} opts.write  sink for paced PCM; returns
     *   false when the sink is backed up, exactly like stream.write()
     */
    constructor({ write } = {}) {
        super();
        this._write = write;
        this._chunks = [];
        this._buffered = 0;
        this._maxBuffered = bytesForMs(MAX_BUFFER_MS);
        this._highWater = bytesForMs(HIGH_WATER_MS);
        this._lowWater = bytesForMs(LOW_WATER_MS);
        this._prebufferBytes = bytesForMs(PREBUFFER_MS);

        this._timer = null;
        this._startedAt = 0;
        this._bytesEmitted = 0;
        this._playedBytes = 0;

        // Gate that opens once enough audio has accumulated. Re-arms whenever a
        // source detaches, so each new source gets its own prebuffer window.
        this._priming = true;

        // Underrun bookkeeping, surfaced so the UI can show a source struggling
        // rather than leaving the user wondering why they're hearing silence.
        this._silentTicks = 0;
        this._reportedStarving = false;

        // Reusable silence block; avoids allocating a fresh buffer every tick.
        this._silence = Buffer.alloc(bytesForMs(TICK_MS * 4));
    }

    get buffered() {
        return this._buffered;
    }

    get position() {
        return this._playedBytes / BYTES_PER_SECOND;
    }

    /** Maximum bytes the buffer will hold before dropping the oldest audio. */
    get capacity() {
        return this._maxBuffered;
    }

    /** Level at which push() starts reporting backpressure. */
    get highWater() {
        return this._highWater;
    }

    /** Level at which a paused producer should resume. */
    get lowWater() {
        return this._lowWater;
    }

    /** True when the pacer is currently filling the gap with silence. */
    get starving() {
        return this._reportedStarving;
    }

    start() {
        if (this._timer) return;
        this._startedAt = Date.now();
        this._bytesEmitted = 0;
        this._timer = setInterval(() => this._tick(), TICK_MS);
        // Unref'd so the pacer alone never keeps the process alive; the HTTP
        // server is what should decide that.
        if (this._timer.unref) this._timer.unref();
    }

    stop() {
        if (!this._timer) return;
        clearInterval(this._timer);
        this._timer = null;
    }

    /**
     * Hand decoded PCM to the pacer. Returns false when the buffer is full,
     * which callers should treat as backpressure and pause their source.
     */
    push(chunk) {
        if (!chunk || !chunk.length) return true;

        this._chunks.push(chunk);
        this._buffered += chunk.length;

        if (this._priming && this._buffered >= this._prebufferBytes) {
            this._priming = false;
            this.emit('primed');
        }

        while (this._buffered > this._maxBuffered && this._chunks.length > 1) {
            const dropped = this._chunks.shift();
            this._buffered -= dropped.length;
            this.emit('overflow', dropped.length);
        }

        // Report backpressure at the high-water mark, not at capacity. By the
        // time capacity is reached the loop above has already discarded audio,
        // so a producer told to stop only then would be told too late.
        return this._buffered < this._highWater;
    }

    /**
     * Drop everything buffered and re-arm the prebuffer gate. Called when a
     * source detaches so the next source doesn't inherit its leftover audio --
     * without this you'd hear a fragment of the previous track after switching.
     */
    reset() {
        this._chunks = [];
        this._buffered = 0;
        this._priming = true;
        this._playedBytes = 0;
    }

    finishInput() {
        // Short tracks must drain even when they never filled the prebuffer.
        this._priming = false;
    }

    _tick() {
        if (!this._write) return;

        // Derive how much to emit from wall-clock elapsed rather than from a
        // per-tick constant. setInterval drifts, and over hours that drift would
        // compound into the encoder being meaningfully ahead of or behind real
        // time.
        const elapsedMs = Date.now() - this._startedAt;
        const target = alignToFrame(Math.floor((BYTES_PER_SECOND * elapsedMs) / 1000));
        let owed = target - this._bytesEmitted;

        if (owed < FRAME_BYTES) return;

        // A long stall (laptop suspend, GC pause) could leave us owing minutes of
        // audio. Emitting all of it would flood the encoder, so cap the catch-up
        // and resync the clock instead.
        const maxCatchUp = bytesForMs(TICK_MS * 10);
        if (owed > maxCatchUp) {
            owed = maxCatchUp;
            this._startedAt = Date.now();
            this._bytesEmitted = 0;
            this.emit('resync');
        }

        const emitted = this._priming || this.paused ? 0 : this._drain(owed);

        if (emitted < owed) {
            this._fillSilence(owed - emitted);
            // Priming is the expected quiet moment right after a source change,
            // not a fault, so it must not be reported as one -- otherwise every
            // track change would raise a spurious "underrun" in the UI.
            if (this._priming || this.paused) {
                this._bytesEmitted += owed;
                return;
            }
            this._silentTicks++;
            // Two consecutive silent ticks is a real stall, not a scheduling
            // blip, and worth telling the UI about.
            if (this._silentTicks > 2 && !this._reportedStarving) {
                this._reportedStarving = true;
                this.emit('starving');
            }
        } else if (this._silentTicks) {
            this._silentTicks = 0;
            if (this._reportedStarving) {
                this._reportedStarving = false;
                this.emit('recovered');
            }
        }

        this._bytesEmitted += owed;
    }

    /** Emit up to `wanted` bytes of real audio. Returns how much was emitted. */
    _drain(wanted) {
        let remaining = wanted;

        while (remaining >= FRAME_BYTES && this._chunks.length) {
            const head = this._chunks[0];

            if (head.length <= remaining) {
                this._chunks.shift();
                this._buffered -= head.length;
                this._write(head, { audio: true, position: this.position });
                this._playedBytes += head.length;
                remaining -= head.length;
            } else {
                // Split mid-chunk, but only ever on a frame boundary -- slicing
                // between the two bytes of a sample would inject a click.
                const take = alignToFrame(remaining);
                if (take < FRAME_BYTES) break;
                this._write(head.subarray(0, take), { audio: true, position: this.position });
                this._playedBytes += take;
                this._chunks[0] = head.subarray(take);
                this._buffered -= take;
                remaining -= take;
            }
        }

        const played = wanted - remaining;
        return played;
    }

    _fillSilence(bytes) {
        let remaining = alignToFrame(bytes);
        while (remaining > 0) {
            const take = Math.min(remaining, this._silence.length);
            this._write(this._silence.subarray(0, take), { audio: false, position: this.position });
            remaining -= take;
        }
    }
}

module.exports = { Pacer, TICK_MS, PREBUFFER_MS };
