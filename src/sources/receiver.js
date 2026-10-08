// SPDX-License-Identifier: GPL-3.0-only
// Shared plumbing for sources that run a receiver program (librespot,
// shairport-sync) and relay its raw PCM stdout into the pipeline.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Transform } = require('node:stream');
const { Source } = require('./base');
const { alignToFrame, bytesForMs } = require('../core/format');

const PROBE_TIMEOUT_MS = 10000;
const STOP_GRACE_MS = 2000;
const RESTART_DELAY_MS = 1000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60000;
const STDERR_LINES = 12;

/** Absolute path of an executable given as a path or a PATH lookup, else null. */
function findExecutable(nameOrPath) {
    if (!nameOrPath) return null;
    const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD').split(';')] : [''];
    const candidates = path.isAbsolute(nameOrPath) || nameOrPath.includes(path.sep)
        ? [nameOrPath]
        : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, nameOrPath));
    for (const candidate of candidates) {
        for (const ext of exts) {
            try {
                fs.accessSync(candidate + ext, fs.constants.X_OK);
                if (fs.statSync(candidate + ext).isFile()) return candidate + ext;
            } catch { /* try the next candidate */ }
        }
    }
    return null;
}

// The pacer slices on frame boundaries but assumes it is given whole frames.
class FrameAligner extends Transform {
    constructor() {
        super();
        this._rest = Buffer.alloc(0);
    }

    _transform(chunk, _encoding, done) {
        const data = this._rest.length ? Buffer.concat([this._rest, chunk]) : chunk;
        const whole = alignToFrame(data.length);
        this._rest = Buffer.from(data.subarray(whole));
        done(null, data.subarray(0, whole));
    }
}

class ReceiverSource extends Source {
    static family = 'push';

    /** Default executable name; overridden by config.binary. */
    static binaryName = '';

    /** Shown when the executable cannot be started. */
    static installHint = '';

    constructor(config = {}, deps = {}) {
        super(config, deps);
        this._child = null;
        this._stream = null;
        this._stopping = false;
        this._starts = [];
        this._stderrTail = [];
        this._timers = new Set();
    }

    get _binary() {
        return this.config.binary || this.constructor.binaryName;
    }

    get capabilities() {
        // Playback is driven from the sending device; Stop only drops the receiver.
        return { stop: true, browse: true };
    }

    /** Arguments, environment and setup for one run of the program. */
    async _prepare() {
        throw new Error(`${this.id}: _prepare() not implemented`);
    }

    /** Called with each line the program writes to stderr. */
    _onStderr(_line) {}

    /** Called after each (re)start, once the process exists. */
    _onStarted(_child) {}

    /** Called when the receiver stops, to clear stale now-playing state. */
    _onStopped() {}

    _idleMetadata() {
        return null;
    }

    _missingBinary(err) {
        const hint = this.constructor.installHint;
        const base = `${this._binary} not found`;
        return new Error(err?.code === 'ENOENT'
            ? `${base}. ${hint}`
            : `could not run ${this._binary}: ${err?.message || 'unknown error'}`);
    }

    _probeArgs() {
        return ['--version'];
    }

    /** Resolves with the first line of --version output. */
    _probe() {
        return new Promise((resolve, reject) => {
            let child;
            try {
                child = spawn(this._binary, this._probeArgs(), { stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (err) {
                return reject(this._missingBinary(err));
            }
            let out = '';
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error(`${this._binary} did not answer --version`));
            }, PROBE_TIMEOUT_MS);
            timer.unref?.();
            child.stdout.on('data', (chunk) => { out += chunk; });
            child.stderr.on('data', (chunk) => { out += chunk; });
            child.on('error', (err) => { clearTimeout(timer); reject(this._missingBinary(err)); });
            child.on('close', () => {
                clearTimeout(timer);
                resolve(out.trim().split('\n')[0] || 'unknown version');
            });
        });
    }

    async connect() {
        this._setState('connecting');
        try {
            this.version = await this._probe();
        } catch (err) {
            this._setState('error', err.message);
            throw err;
        }
        this._setState('ready');
    }

    async open() {
        if (this.state === 'idle' || this.state === 'error') await this.connect();
        await this._stopChild();
        this._stopping = false;
        this._starts = [];
        this._stream = new FrameAligner();
        // A little silence marks the stream as producing audio, so "Audio ready"
        // does not wait for someone to press play on the sending device.
        this._stream.write(Buffer.alloc(bytesForMs(100)));
        const idle = this._idleMetadata();
        if (idle) this._emitMetadata(idle);
        try {
            await this._start();
        } catch (err) {
            this._stream.destroy();
            this._stream = null;
            this._setState('error', err.message);
            throw err;
        }
        this._setState('playing');
        return { type: 'pcm', stream: this._stream };
    }

    async _start() {
        const { args, env } = await this._prepare();
        const child = spawn(this._binary, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, ...env },
        });
        this._child = child;
        this._stderrTail = [];

        // The first event decides whether the program could be launched at all.
        await new Promise((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', (err) => reject(this._missingBinary(err)));
        });

        this._starts.push(Date.now());
        child.stdout.pipe(this._stream, { end: false });
        let buffered = '';
        child.stderr.on('data', (chunk) => {
            buffered += chunk;
            const lines = buffered.split('\n');
            buffered = lines.pop();
            for (const raw of lines) {
                const line = raw.trim();
                if (!line) continue;
                this._stderrTail = [...this._stderrTail, line].slice(-STDERR_LINES);
                this._onStderr(line);
            }
        });
        child.on('exit', (code, signal) => this._exited(child, code, signal));
        this._onStarted(child);
    }

    _exited(child, code, signal) {
        if (this._child !== child) return;
        this._child = null;
        if (this._stopping) return;
        this._onStopped();

        const recent = this._starts.filter((t) => Date.now() - t < RESTART_WINDOW_MS);
        const why = this._stderrTail.at(-1) || `exit code ${code ?? signal}`;
        if (recent.length > MAX_RESTARTS) {
            this._setState('error', `${this.constructor.label} receiver keeps stopping: ${why}`);
            this._warn(`${this.constructor.label} receiver keeps stopping (${why}); stopped retrying`);
            return;
        }
        this._warn(`${this.constructor.label} receiver stopped (${why}); restarting`);
        const timer = setTimeout(() => {
            this._timers.delete(timer);
            if (this._stopping || !this._stream) return;
            this._start().catch((err) => {
                this._setState('error', err.message);
                this._warn(err.message);
            });
        }, RESTART_DELAY_MS);
        timer.unref?.();
        this._timers.add(timer);
    }

    async _stopChild() {
        for (const timer of this._timers) clearTimeout(timer);
        this._timers.clear();
        const child = this._child;
        if (!child) return;
        this._child = null;
        await new Promise((resolve) => {
            const force = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
            force.unref?.();
            child.once('exit', () => { clearTimeout(force); resolve(); });
            if (child.exitCode !== null || child.signalCode !== null) {
                clearTimeout(force);
                resolve();
            } else child.kill('SIGTERM');
        });
    }

    async close() {
        this._stopping = true;
        await this._stopChild();
        this._onStopped();
        if (this._stream) {
            this._stream.destroy();
            this._stream = null;
        }
        if (this._state !== 'idle') this._setState('ready');
    }

    async disconnect() {
        await this.close();
        this._setState('idle');
    }

    /** What the settings screen shows beside the controls. */
    info() {
        return { version: this.version || null, running: Boolean(this._child) };
    }
}

module.exports = { ReceiverSource, FrameAligner, findExecutable };
