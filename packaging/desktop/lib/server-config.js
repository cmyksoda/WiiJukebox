// SPDX-License-Identifier: GPL-3.0-only
// Reads and edits the server's own config.json (the app and the command-line server share it).

const fs = require('node:fs');
const path = require('node:path');

/** @param {string} serverRoot folder holding the server's `src/` */
function serverConfig(serverRoot) {
    const { Config, detectHostIp } = require(path.join(serverRoot, 'src', 'config'));
    const config = new Config();

    return {
        file: config.file,
        detectHostIp,
        /** Saved values merged over the server's defaults. */
        read() {
            return config.load();
        },
        /** Written straight to the file: the server's own save is debounced and this app restarts it at once. */
        setPort(port) {
            let saved = {};
            try {
                saved = JSON.parse(fs.readFileSync(config.file, 'utf8'));
            } catch (err) {
                if (err.code !== 'ENOENT') throw err;
            }
            fs.mkdirSync(path.dirname(config.file), { recursive: true });
            fs.writeFileSync(config.file, JSON.stringify({ ...saved, port }, null, 2), { mode: 0o600 });
        },
    };
}

module.exports = { serverConfig };
