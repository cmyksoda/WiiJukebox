// SPDX-License-Identifier: GPL-3.0-only
// Writes a small Node script that stands in for an external program in tests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const made = [];
process.on('exit', () => {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/** Removed when the test process exits, so tests need not clean up after themselves. */
function tempDir(prefix = 'wiijukebox-test-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    made.push(dir);
    return dir;
}

/** The body runs as the program; `process.argv.slice(2)` holds its arguments. */
function fakeBinary(dir, name, body) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
    return file;
}

const waitFor = async (check, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('timed out waiting for condition');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
};

module.exports = { tempDir, fakeBinary, waitFor };
