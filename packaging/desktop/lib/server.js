// SPDX-License-Identifier: GPL-3.0-only
// Runs the WiiJukebox server as a child process and reports where it is listening.

const { EventEmitter } = require('node:events');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const LOG_LINES = 400;
const START_TIMEOUT_MS = 20000;
// Wraps the server so it exits on its own if this app dies without stopping it.
const LAUNCHER = path.join(__dirname, 'server-entry.js');

class ServerProcess extends EventEmitter {
    /** @param {{entry: string, cwd: string, env: object, nodePath: string}} options */
    constructor({ entry, cwd, env, nodePath }) {
        super();
        this.entry = entry;
        this.cwd = cwd;
        this.env = env;
        this.nodePath = nodePath;
        this.child = null;
        this.log = [];
        this.stopping = false;
    }

    _record(chunk) {
        for (const line of String(chunk).split('\n')) {
            if (!line.trim()) continue;
            this.log.push(line);
            if (this.log.length > LOG_LINES) this.log.shift();
            this.emit('line', line);
        }
    }

    /** Starts the server; resolves with its local URL once the web UI is up. */
    start() {
        this.stopping = false;
        return new Promise((resolve, reject) => {
            const child = spawn(this.nodePath, [LAUNCHER, this.entry], {
                cwd: this.cwd,
                env: { ...process.env, ...this.env, ELECTRON_RUN_AS_NODE: '1' },
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
            child.stdin.on('error', () => {});
            this.child = child;
            let settled = false;
            const timer = setTimeout(() => finish(new Error('the server did not start in time')), START_TIMEOUT_MS);
            const finish = (err, url) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (err) reject(err);
                else resolve(url);
            };
            const onData = (chunk) => {
                this._record(chunk);
                const match = /WebUI\s+http:\/\/[^:\s]+:(\d+)/.exec(String(chunk));
                if (match) finish(null, `http://127.0.0.1:${match[1]}/`);
            };
            child.stdout.on('data', onData);
            child.stderr.on('data', (chunk) => this._record(chunk));
            child.on('error', (err) => finish(err));
            child.on('exit', (code, signal) => {
                this.child = null;
                const reason = `server exited (${signal || `code ${code}`})`;
                finish(new Error(this.log.at(-1) ? `${reason}: ${this.log.at(-1)}` : reason));
                if (!this.stopping) this.emit('crashed', reason);
            });
        });
    }

    /** Asks the server to shut down cleanly, then makes sure it is gone. */
    stop() {
        const child = this.child;
        if (!child) return Promise.resolve();
        this.stopping = true;
        return new Promise((resolve) => {
            const force = setTimeout(() => this._kill(child), 4000);
            child.once('exit', () => {
                clearTimeout(force);
                resolve();
            });
            // Windows has no SIGTERM, so closing the child's stdin is the polite request there.
            if (process.platform === 'win32') child.stdin.end();
            else child.kill('SIGTERM');
        });
    }

    // Windows has no SIGKILL either; take the whole tree so the server's ffmpeg goes too.
    _kill(child) {
        if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], () => {});
        else child.kill('SIGKILL');
    }
}

module.exports = { ServerProcess };
