// SPDX-License-Identifier: GPL-3.0-only
// The desktop app's own small settings file (the server keeps its settings in config.json).

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
    // False until the first-run window has been completed.
    setupDone: false,
    // What closing the window does: 'ask' the first time, then 'background' or 'quit'.
    onClose: 'ask',
    // Prefer the FFmpeg that ships with the app; off means the one already on this computer.
    useBundledFfmpeg: true,
};

class Settings {
    constructor(file) {
        this.file = file;
        this.data = { ...DEFAULTS };
        try {
            const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
            for (const key of Object.keys(DEFAULTS)) {
                if (typeof saved[key] === typeof DEFAULTS[key]) this.data[key] = saved[key];
            }
        } catch (err) {
            // A missing or damaged file just means a fresh start.
            if (err.code !== 'ENOENT') console.warn(`desktop settings unreadable (${err.message}); using defaults`);
        }
    }

    get(key) {
        return this.data[key];
    }

    set(key, value) {
        if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`unknown setting: ${key}`);
        this.data[key] = value;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    }
}

/**
 * What closing the window does: 'close' it for real, 'hide' it and keep playing, or 'ask' first.
 * Nothing is playing before setup finishes, so that window just closes the app.
 */
function closeAction({ quitting, mode, setupDone }) {
    if (quitting || mode === 'quit' || !setupDone) return 'close';
    return mode === 'background' ? 'hide' : 'ask';
}

module.exports = { Settings, closeAction };
