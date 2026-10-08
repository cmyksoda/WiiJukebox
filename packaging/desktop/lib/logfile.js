// SPDX-License-Identifier: GPL-3.0-only
// Keeps the server's output in a file so a problem can be looked at after the window is gone.

const fs = require('node:fs');
const path = require('node:path');

/** Starts the file over when it has grown past `maxBytes`, then appends lines to it. */
function openLog(file, maxBytes = 1_000_000) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
        if (fs.statSync(file).size > maxBytes) fs.truncateSync(file);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    const stream = fs.createWriteStream(file, { flags: 'a' });
    stream.on('error', () => {});
    return {
        write: (line) => stream.write(`${new Date().toISOString()} ${line}\n`),
        close: () => stream.end(),
    };
}

module.exports = { openLog };
