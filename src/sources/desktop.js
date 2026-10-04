// SPDX-License-Identifier: GPL-3.0-only
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Source } = require('./base');
const run = promisify(execFile);

class DesktopSource extends Source {
    static id = 'desktop';
    static label = 'Desktop audio (Linux)';
    static family = 'pull';

    get capabilities() { return { play: true, stop: true, browse: true }; }

    async _monitors() {
        const execute = this.deps.execFile || run;
        let stdout;
        try {
            ({ stdout } = await execute('pactl', ['--format=json', 'list', 'sources'],
                { timeout: 5000, maxBuffer: 2 * 1024 * 1024 }));
        } catch { throw new Error('desktop audio needs pactl and a running PulseAudio or PipeWire-Pulse session'); }
        const sources = JSON.parse(stdout);
        // Monitor sources represent rendered output, not microphones. Never
        // silently select the default input device on a new installation.
        return sources.filter((s) => typeof s.name === 'string' && s.name.endsWith('.monitor'));
    }

    async connect() {
        try {
            if (!(await this._monitors()).length) throw new Error('no output monitors found');
            this._setState('ready');
        } catch (err) { this._setState('error', err.message); throw err; }
    }

    async browse({ offset = 0, limit = 100 } = {}) {
        const monitors = await this._monitors();
        return { items: monitors.slice(offset, offset + limit).map((s) => ({
            id: s.name, type: 'station', title: s.description || s.name,
            subtitle: 'Capture this output while selected. Stop ends capture.',
        })), total: monitors.length };
    }

    async open(item) {
        const monitor = (await this._monitors()).find((s) => s.name === item?.id);
        if (!monitor) throw new Error('choose an available output monitor');
        this._emitMetadata({ title: monitor.description || monitor.name,
            artist: 'Desktop audio', album: '', artwork: null, duration: null });
        this._setState('playing');
        return { type: 'device', format: 'pulse', device: monitor.name };
    }

    async close() { this._setState('ready'); }
    async disconnect() { this._setState('idle'); }
}
module.exports = { DesktopSource };
