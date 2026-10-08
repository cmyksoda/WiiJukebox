// The persistent MP3 encoder.
//
// One ffmpeg process, started at boot and never intentionally stopped. It reads
// the paced PCM stream on stdin and writes a continuous MP3 bitstream on stdout,
// which the broadcaster fans out to listeners.
//
// Nothing about a source change reaches this process: sources are swapped
// upstream of the pacer, which keeps feeding real-time PCM throughout. From
// ffmpeg's point of view it is encoding one infinitely long recording, which is
// exactly what makes the mount persistent.

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { FFMPEG_PCM_INPUT, SAMPLE_RATE, mp3Output } = require('./format');

// If ffmpeg dies anyway (OOM, someone kills it, a bad build), come back up
// rather than leaving a dead mount. Backoff avoids a hot loop when the binary is
// missing entirely.
const RESTART_DELAY_MS = 500;
const RESTART_DELAY_MAX_MS = 10000;

class Encoder extends EventEmitter {
    /**
     * @param {object} [opts]
     * @param {string} [opts.ffmpegPath]  path to the ffmpeg binary
     * @param {number} [opts.bitrate]     MP3 bitrate in kbps
     * @param {number} [opts.sampleRate]  MP3 sample rate in Hz
     */
    constructor({ ffmpegPath = 'ffmpeg', bitrate, sampleRate } = {}) {
        super();
        this._ffmpegPath = ffmpegPath;
        const output = mp3Output({ bitrate, sampleRate });
        this._bitrate = output.bitrate;
        this._sampleRate = output.sampleRate;
        this._proc = null;
        this._stopping = false;
        this._restartDelay = RESTART_DELAY_MS;
        this._restartTimer = null;

        // Set false by write() on backpressure, true again on drain. The pacer
        // reads it so a wedged encoder doesn't silently accumulate PCM.
        this._writable = false;
    }

    get running() {
        return Boolean(this._proc && !this._proc.killed);
    }

    get bitrate() { return this._bitrate; }

    get sampleRate() { return this._sampleRate; }

    get writable() {
        return this._writable;
    }

    start() {
        if (this._proc || this._stopping) return;

        const args = [
            '-hide_banner',
            '-loglevel', 'error',
            ...FFMPEG_PCM_INPUT,
            '-i', 'pipe:0',
            // A longer windowed-sinc filter than the default; this runs once on
            // the server instead of the Wii's nearest-sample resampler.
            ...(this._sampleRate === SAMPLE_RATE ? [] : ['-af', `aresample=${this._sampleRate}:filter_size=64`]),
            '-c:a', 'libmp3lame',
            '-b:a', `${this._bitrate}k`,
            '-compression_level', '2',
            // CBR keeps the advertised bitrate and byte-based stream clock accurate.
            // Listeners also use icy-br to estimate their buffered duration.
            '-abr', '0',
            '-reservoir', '0',
            // Nothing downstream reads ID3, and a tag mid-bitstream would just be
            // noise a decoder has to skip past.
            '-write_xing', '0',
            '-id3v2_version', '0',
            '-f', 'mp3',
            'pipe:1',
        ];

        const proc = spawn(this._ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        this._proc = proc;
        this._writable = true;

        proc.stdout.on('data', (chunk) => this.emit('data', chunk));

        proc.stdin.on('drain', () => {
            this._writable = true;
            this.emit('drain');
        });

        // EPIPE here just means ffmpeg went away; the exit handler owns recovery,
        // so swallow it rather than letting it reach the process error handler.
        proc.stdin.on('error', (err) => {
            if (err.code !== 'EPIPE') this.emit('warning', `encoder stdin: ${err.message}`);
        });

        proc.stderr.on('data', (data) => {
            const text = data.toString().trim();
            if (text) this.emit('warning', `ffmpeg: ${text}`);
        });

        proc.on('error', (err) => {
            this.emit('warning', `encoder spawn failed: ${err.message}`);
        });

        proc.on('exit', (code, signal) => {
            this._proc = null;
            this._writable = false;
            if (this._stopping) return;

            this.emit('warning', `encoder exited (code=${code} signal=${signal}); restarting`);
            this._scheduleRestart();
        });

        // A clean run means the previous backoff no longer applies. Reset only
        // once it has clearly survived startup, so a binary that crashes
        // instantly still backs off properly.
        setTimeout(() => {
            if (this._proc === proc) this._restartDelay = RESTART_DELAY_MS;
        }, 5000).unref?.();

        this.emit('started');
    }

    _scheduleRestart() {
        if (this._restartTimer) return;
        const delay = this._restartDelay;
        this._restartDelay = Math.min(this._restartDelay * 2, RESTART_DELAY_MAX_MS);
        this._restartTimer = setTimeout(() => {
            this._restartTimer = null;
            this.start();
        }, delay);
        this._restartTimer.unref?.();
    }

    /** Feed PCM. Returns false on backpressure, matching stream.write(). */
    write(chunk) {
        const proc = this._proc;
        if (!proc || !proc.stdin.writable) return false;
        const ok = proc.stdin.write(chunk);
        if (!ok) this._writable = false;
        return ok;
    }

    stop() {
        this._stopping = true;
        if (this._restartTimer) {
            clearTimeout(this._restartTimer);
            this._restartTimer = null;
        }
        if (this._proc) {
            this._proc.stdin.end();
            this._proc.kill('SIGTERM');
            this._proc = null;
        }
        this._writable = false;
    }
}

module.exports = { Encoder };
