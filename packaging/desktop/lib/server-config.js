// SPDX-License-Identifier: GPL-3.0-only
// Reads and edits the server's own config.json (the app and the command-line server share it).

const fs = require('node:fs');
const path = require('node:path');
const { portIsFree } = require('./network');

const MAX_NAME_LENGTH = 80;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

/** The name the Wii lists: trimmed, not empty, at most 80 characters (what discovery sends) and one line. */
function validateServerName(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name) return { ok: false, error: "Give the server a name. It is what the Wii's server list shows." };
    if (Array.from(name).length > MAX_NAME_LENGTH) return { ok: false, error: `Keep the name to ${MAX_NAME_LENGTH} characters or fewer.` };
    if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: 'The name cannot contain line breaks or other control characters.' };
    return { ok: true, value: name };
}

function validatePort(value) {
    if (!Number.isInteger(value) || value < MIN_PORT || value > MAX_PORT) {
        return { ok: false, error: `Choose a number from ${MIN_PORT} to ${MAX_PORT}.` };
    }
    return { ok: true, value };
}

/** What the user typed, checked: both values valid and the port free, unless `keepPort` (the running server's own) is chosen again. */
async function checkServerChoice(choice, keepPort = null) {
    const name = validateServerName(choice?.name);
    if (!name.ok) return name;
    const port = validatePort(choice?.port);
    if (!port.ok) return port;
    if (port.value !== keepPort && !(await portIsFree(port.value))) {
        return { ok: false, error: `Port ${port.value} is in use by another program. Try a different number.` };
    }
    return { ok: true, name: name.value, port: port.value };
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** @param {string} serverRoot folder holding the server's `src/` */
function serverConfig(serverRoot) {
    const { Config, detectHostIp } = require(path.join(serverRoot, 'src', 'config'));
    const config = new Config();

    // Written straight to the file: the server's own save is debounced and this app restarts it at once.
    function edit(change) {
        let saved = {};
        try {
            saved = JSON.parse(fs.readFileSync(config.file, 'utf8'));
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
        fs.mkdirSync(path.dirname(config.file), { recursive: true });
        fs.writeFileSync(config.file, JSON.stringify({ ...saved, ...change(saved) }, null, 2), { mode: 0o600 });
    }

    return {
        file: config.file,
        detectHostIp,
        /** Saved values merged over the server's defaults. */
        read() {
            return config.load();
        },
        setPort(port) {
            edit(() => ({ port }));
        },
        /** Sets the web port and the name on the Wii's server list; the discovery port stays where the Wii looks. */
        setServer({ name, port }) {
            const checked = [validateServerName(name), validatePort(port)];
            const bad = checked.find((result) => !result.ok);
            if (bad) throw new Error(bad.error);
            edit((saved) => ({
                port: checked[1].value,
                station: { ...(isObject(saved.station) ? saved.station : {}), name: checked[0].value },
            }));
        },
    };
}

module.exports = { serverConfig, checkServerChoice, validateServerName, validatePort, MAX_NAME_LENGTH };
