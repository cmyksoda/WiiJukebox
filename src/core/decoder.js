// Source decoder: anything -> the PCM interchange format.
//
// Sources hand the pipeline either a URI or a raw byte stream, in whatever
// container and codec they happen to use. This wraps one ffmpeg process that
// normalises it to 44.1 kHz stereo s16le so the pacer only ever sees one format.
//
// Deliberately *not* real-time paced (`-re` is absent): the pacer owns timing.
// Letting the decoder run ahead is what fills the jitter buffer, which is what
// survives a network stall without a dropout.

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { CHANNELS, FFMPEG_PCM_OUTPUT, SAMPLE_RATE } = require('./format');

class Decoder extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string} [opts.uri]          input URI, or omit to write to stdin
     * @param {object} [opts.headers]      extra HTTP headers (auth tokens etc.)
     * @param {number} [opts.seekSeconds]  start offset for seekable inputs
     * @param {string} [opts.ffmpegPath]
     * @param {string} [opts.parecPath]    records a PulseAudio/PipeWire `device`
     */
    constructor({ uri, headers, device, format, seekSeconds = 0, ffmpegPath = 'ffmpeg', parecPath = 'parec' } = {}) {
        super();
        this._uri = uri;
        this._device = device;
        this._format = format;
        this._headers = headers;
        this._seekSeconds = seekSeconds;
        this._ffmpegPath = ffmpegPath;
        this._parecPath = parecPath;
        this._proc = null;
        this._stopped = false;
        this._sawAudio = false;
        // ffmpeg reports failures on stderr and then exits; keeping the tail lets
        // the exit handler say *why* rather than just reporting a code.
        this._stderrTail = [];
    }

    get running() {
        return Boolean(this._proc);
    }

    /** True once any PCM has been produced -- i.e. the input really decoded. */
    get producedAudio() {
        return this._sawAudio;
    }

    _ffmpegArgs() {
        // Audio decodes on one core; FFmpeg's default pools only add threads.
        const args = ['-hide_banner', '-loglevel', 'warning', '-threads', '1', '-filter_threads', '1'];

        if (this._uri && /^https?:/i.test(this._uri)) {
            // Radio servers redirect constantly, and several of the self-hosted
            // ones bounce through a CDN.
            args.push('-reconnect', '1', '-reconnect_streamed', '1');
            args.push('-reconnect_delay_max', '10');

            if (this._headers) {
                const lines = Object.entries(this._headers)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join('\r\n');
                if (lines) args.push('-headers', `${lines}\r\n`);
            }
        }

        // Before -i, so ffmpeg seeks rather than decoding and discarding.
        if (this._seekSeconds > 0) args.push('-ss', String(this._seekSeconds));
        args.push('-i', this._uri || 'pipe:0');

        // Some sources are video containers (YouTube), some carry cover art as a
        // still image "video" stream. Either would make ffmpeg fail on a
        // PCM-only output, so pin the mapping to audio.
        args.push('-vn', '-map', '0:a:0?');
        args.push(...FFMPEG_PCM_OUTPUT, 'pipe:1');
        return args;
    }

    start() {
        if (this._proc || this._stopped) return;

        let command = this._ffmpegPath;
        let args;
        if (this._device) {
            if (this._format !== 'pulse') throw new Error('unsupported capture device');
            // parec records the interchange format itself, so capture needs no FFmpeg built with PulseAudio.
            command = this._parecPath;
            args = [`--device=${this._device}`, '--raw', '--format=s16le', `--rate=${SAMPLE_RATE}`,
                `--channels=${CHANNELS}`, '--latency-msec=50'];
        } else args = this._ffmpegArgs();

        const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        this._proc = proc;

        proc.stdout.on('data', (chunk) => {
            if (!this._sawAudio) {
                this._sawAudio = true;
                this.emit('opened');
            }
            this.emit('data', chunk);
        });

        proc.stderr.on('data', (data) => {
            const text = data.toString().trim();
            if (!text) return;
            this._stderrTail.push(text);
            if (this._stderrTail.length > 10) this._stderrTail.shift();
            this.emit('log', text);
        });

        proc.stdin.on('error', () => {
            /* EPIPE when the decoder exits first; exit handler owns recovery */
        });

        proc.on('error', (err) => {
            this._proc = null;
            this._stopped = true;
            this.emit('error', new Error(`decoder spawn failed: ${err.message}`));
        });

        proc.on('close', (code, signal) => {
            this._proc = null;
            if (this._stopped) return;

            if (code === 0) {
                // Clean exit means the input ran out -- end of track, or a radio
                // server closing. The pipeline decides what happens next.
                this.emit('ended');
            } else {
                const why = this._stderrTail.join('; ') || `code ${code} signal ${signal}`;
                this.emit('error', new Error(why));
            }
        });
    }

    /**
     * Stop reading decoded output. Essential for anything that decodes faster
     * than real time -- a local library file goes through ffmpeg at tens of
     * times playback speed, and without this the pacer's buffer would overflow
     * and silently discard most of the track.
     *
     * Pausing stdout lets the OS pipe fill, which blocks ffmpeg's writes and
     * throttles decoding at the source rather than dropping audio downstream.
     */
    pause() {
        this._proc?.stdout.pause();
    }

    resume() {
        this._proc?.stdout.resume();
    }

    /** For stdin-fed decoders: push encoded bytes in. */
    write(chunk) {
        if (!this._proc || !this._proc.stdin.writable) return false;
        return this._proc.stdin.write(chunk);
    }

    /** Signal end-of-input for stdin-fed decoders. */
    endInput() {
        if (this._proc && this._proc.stdin.writable) this._proc.stdin.end();
    }

    stop() {
        this._stopped = true;
        if (this._proc) {
            const proc = this._proc;
            this._proc = null;
            try {
                proc.stdin.destroy();
            } catch {
                /* already closed */
            }
            proc.kill('SIGKILL');
        }
    }
}

module.exports = { Decoder };
