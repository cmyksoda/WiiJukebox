// The pipeline: one persistent stream, many interchangeable sources.
//
//   source -> decoder -> pacer -> encoder -> broadcaster -> Wii
//              (to PCM)  (real   (to MP3)    (ICY fan-out)
//                         time)
//
// Everything from the pacer rightwards starts at boot and runs until shutdown.
// Only the left-hand side is ever torn down and rebuilt, and the pacer's silence
// fill covers the gap while that happens. The Wii's connection is therefore
// never interrupted by a source change -- which matters more than it sounds,
// because WiiRadio drops back to its station list the moment a stream ends, and
// having to walk back through the Wii's UI on every track change would make the
// whole thing unusable.

const { EventEmitter } = require('events');
const { Pacer } = require('./pacer');
const { Encoder } = require('./encoder');
const { Broadcaster } = require('./broadcaster');
const { Decoder } = require('./decoder');

class Pipeline extends EventEmitter {
    constructor({ ffmpegPath = 'ffmpeg', station = {} } = {}) {
        super();
        this._ffmpegPath = ffmpegPath;

        this.broadcaster = new Broadcaster(station);
        this.encoder = new Encoder({ ffmpegPath });
        this.pacer = new Pacer({ write: (chunk) => this.encoder.write(chunk) });

        // The currently attached source, and the decoder converting its output.
        this._source = null;
        this._decoder = null;
        this._pcmStream = null;
        // Whichever of the two is currently feeding the pacer, as a pause/resume
        // handle. Kept separate so backpressure works the same for both.
        this._input = null;
        this._paused = false;
        this._commands = Promise.resolve();
        this._endTimer = null;

        // What the WebUI shows and what goes out over ICY.
        this._nowPlaying = { title: '', artist: '', album: '', artwork: null };

        this._wireCore();
    }

    _wireCore() {
        this.encoder.on('data', (chunk) => this.broadcaster.write(chunk));
        this.encoder.on('warning', (msg) => this.emit('warning', msg));

        this.pacer.on('starving', () => {
            this.emit('warning', 'source underrun; filling with silence');
            this.emit('status', this.status);
        });
        this.pacer.on('recovered', () => this.emit('status', this.status));

        this.broadcaster.on('warning', (msg) => this.emit('warning', msg));
        this.broadcaster.on('listener-connected', (info) => {
            this.emit('listener-connected', info);
            this.emit('status', this.status);
        });
        this.broadcaster.on('listener-disconnected', (info) => {
            this.emit('listener-disconnected', info);
            this.emit('status', this.status);
        });
    }

    /** Bring the persistent half up. Safe to call once, at boot. */
    start() {
        this.encoder.start();
        this.pacer.start();
        this.emit('started');
    }

    command(work) {
        const result = this._commands.then(work);
        this._commands = result.catch(() => {});
        return result;
    }

    setPaused(paused) {
        this.pacer.paused = paused;
        this.emit('status', this.status);
    }

    get nowPlaying() {
        return { ...this._nowPlaying };
    }

    get activeSource() {
        return this._source;
    }

    get status() {
        return {
            source: this._source
                ? { id: this._source.id, label: this._source.label, state: this._source.state }
                : null,
            nowPlaying: this.nowPlaying,
            listeners: this.broadcaster.listenerCount,
            starving: this.pacer.starving,
            paused: Boolean(this.pacer.paused),
            capabilities: this._source
                ? { ...this._source.capabilities, seek: false, volume: false, shuffle: false, repeat: false }
                : {},
        };
    }

    /**
     * Make `source` the thing feeding the stream, detaching whatever was there.
     * The encoder is untouched throughout.
     *
     * @param {import('../sources/base').Source} source
     * @param {object} [item]  source-specific item to start with
     */
    async attach(source, item) {
        await this.detach();

        this._source = source;

        source.on('metadata', this._onSourceMetadata);
        source.on('warning', this._onSourceWarning);
        source.on('state', this._onSourceState);
        source.on('ended', this._onSourceEnded);

        try {
            const handle = await source.open(item);
            this._consume(handle);
            this.emit('status', this.status);
        } catch (err) {
            this.emit('warning', `${source.id}: ${err.message}`);
            // Leave the source attached but idle. The stream stays up on silence,
            // which is a far better failure mode than tearing the mount down and
            // making the user re-select the station on the Wii.
            source._setState?.('error', err.message);
            this.emit('status', this.status);
            throw err;
        }
    }

    /** Route whatever the source returned into the pacer. */
    _consume(handle) {
        if (!handle) throw new Error('source returned no audio handle');

        if (handle.type === 'pcm') {
            // Already interchange format; straight into the pacer.
            this._pcmStream = handle.stream;
            this._input = handle.stream;
            handle.stream.on('data', (chunk) => this._pushPcm(chunk));
            handle.stream.on('error', (err) => this.emit('warning', `pcm stream: ${err.message}`));
            handle.stream.on('end', () => this._onSourceEnded());
            return;
        }

        const decoder = new Decoder({
            uri: handle.type === 'uri' ? handle.uri : undefined,
            headers: handle.headers,
            seekSeconds: handle.seekSeconds,
            ffmpegPath: this._ffmpegPath,
        });
        this._decoder = decoder;

        decoder.on('data', (chunk) => {
            if (this._decoder === decoder) this._pushPcm(chunk);
        });
        decoder.on('log', (line) => this.emit('debug', line));
        decoder.on('ended', () => {
            if (this._decoder === decoder) this._onSourceEnded();
        });
        decoder.on('error', (err) => {
            if (this._decoder !== decoder) return;
            this.emit('warning', `decode failed: ${err.message}`);
            this._onSourceEnded();
        });

        decoder.start();
        this._input = decoder;

        // For 'encoded', the source pushes bytes and we decode them.
        if (handle.type === 'encoded' && handle.stream) {
            this._pcmStream = handle.stream;
            handle.stream.on('data', (chunk) => decoder.write(chunk));
            handle.stream.on('end', () => decoder.endInput());
            handle.stream.on('error', (err) => this.emit('warning', `input: ${err.message}`));
        }
    }

    _pushPcm(chunk) {
        if (this.pacer.push(chunk)) return;

        // Backpressure: the buffer is full because the source is running ahead of
        // real time. A local library file decodes at tens of times playback
        // speed, so this is the normal path for anything that isn't live -- not
        // an error. Throttle the input and let the pacer drain.
        //
        // Without this the pacer's overflow guard would discard the excess, and
        // since it drops the *oldest* buffered audio the listener would hear the
        // track skipping forward in chunks.
        const input = this._input;
        if (!input || this._paused) return;

        this._paused = true;
        input.pause?.();

        const resume = () => {
            if (this._input !== input) return; // source swapped while paused
            this._paused = false;
            input.resume?.();
        };
        // Wait until roughly half the buffer has drained rather than resuming on
        // a fixed timer, so the rate settles instead of oscillating.
        this._awaitDrain(resume, input);
    }

    /** Poll the pacer until its buffer has drained enough to accept more. */
    _awaitDrain(done, input) {
        const check = () => {
            if (this._input !== input) return;
            if (this.pacer.buffered <= this.pacer.lowWater) {
                done();
                return;
            }
            setTimeout(check, 50).unref?.();
        };
        setTimeout(check, 50).unref?.();
    }

    // Bound so they can be removed cleanly on detach.
    _onSourceMetadata = (meta) => {
        this._nowPlaying = { ...this._nowPlaying, ...meta };

        // WiiRadio has one line for this, so collapse artist/title the way every
        // other station does. Anything richer only reaches the WebUI.
        const parts = [];
        if (meta.artist) parts.push(meta.artist);
        if (meta.title) parts.push(meta.title);
        const icyTitle = parts.join(' - ') || meta.title || '';
        if (icyTitle) this.broadcaster.setMetadata({ title: icyTitle });

        this.emit('metadata', this.nowPlaying);
        this.emit('status', this.status);
    };

    _onSourceWarning = (msg) => {
        this.emit('warning', `${this._source ? this._source.id : 'source'}: ${msg}`);
    };

    _onSourceState = (info) => {
        this.emit('status', this.status);
        this.emit('source-state', info);
    };

    _onSourceEnded = () => {
        if (this._endTimer) return;
        const source = this._source;
        this.pacer.finishInput();
        this._endTimer = setInterval(() => {
            if (this.pacer.buffered || this.pacer.paused) return;
            clearInterval(this._endTimer);
            this._endTimer = null;
            this.emit('track-ended', { source });
        }, 20);
        this._endTimer.unref?.();
    };

    /** Stop the current source and clear the left-hand side of the pipeline. */
    async detach() {
        clearInterval(this._endTimer);
        this._endTimer = null;
        this.pacer.paused = false;
        this._input = null;
        this._paused = false;
        if (this._decoder) {
            this._decoder.stop();
            this._decoder = null;
        }
        if (this._pcmStream) {
            this._pcmStream.removeAllListeners?.();
            this._pcmStream.destroy?.();
            this._pcmStream = null;
        }
        if (this._source) {
            const source = this._source;
            source.off('metadata', this._onSourceMetadata);
            source.off('warning', this._onSourceWarning);
            source.off('state', this._onSourceState);
            source.off('ended', this._onSourceEnded);
            this._source = null;
            try {
                await source.close();
            } catch (err) {
                this.emit('warning', `closing source: ${err.message}`);
            }
        }

        // Drop buffered audio from the old source so the next one doesn't start
        // with a fragment of the last track.
        this.pacer.reset();
        this._nowPlaying = { title: '', artist: '', album: '', artwork: null };
        this.broadcaster.setMetadata({ title: '' });
        this.emit('status', this.status);
    }

    /**
     * Play the next item from the same source without detaching it -- the normal
     * path when a track finishes and a queue advances.
     */
    async playHandle(handle) {
        clearInterval(this._endTimer);
        this._endTimer = null;
        this.pacer.paused = false;
        this._input = null;
        this._paused = false;
        if (this._decoder) {
            this._decoder.stop();
            this._decoder = null;
        }
        if (this._pcmStream) {
            this._pcmStream.removeAllListeners?.();
            this._pcmStream.destroy?.();
            this._pcmStream = null;
        }
        this.pacer.reset();
        this._consume(handle);
    }

    async shutdown() {
        await this.detach();
        this.pacer.stop();
        this.encoder.stop();
        this.broadcaster.close();
    }
}

module.exports = { Pipeline };
