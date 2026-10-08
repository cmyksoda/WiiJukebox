// SPDX-License-Identifier: GPL-3.0-only
// "Start at login": Electron's login items on Windows and macOS, an autostart entry on Linux.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The app opens quietly in the tray, so the music is ready without a window appearing at sign-in.
const HIDDEN_ARG = '--hidden';

// Exec values escape these characters inside double quotes (freedesktop Desktop Entry spec).
const quoteExec = (file) => `"${file.replace(/(["`$\\])/g, '\\$1')}"`;

function linuxEntry(executable) {
    return [
        '[Desktop Entry]',
        'Type=Application',
        'Name=WiiJukebox',
        'Comment=Plays your music to the Wii',
        `Exec=${quoteExec(executable)} ${HIDDEN_ARG}`,
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
        '',
    ].join('\n');
}

/**
 * @param {{app: object, platform?: string, executable?: string, configHome?: string}} options
 *   `executable` is what to start at login; an AppImage must name itself, not its temporary mount.
 */
function createAutostart({
    app,
    platform = process.platform,
    executable = process.env.APPIMAGE || process.execPath,
    configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
}) {
    if (platform === 'linux') {
        const file = path.join(configHome, 'autostart', 'wiijukebox.desktop');
        return {
            isEnabled: () => fs.existsSync(file),
            set(enabled) {
                if (!enabled) return fs.rmSync(file, { force: true });
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, linuxEntry(executable));
            },
        };
    }
    const query = { path: executable, args: [HIDDEN_ARG] };
    return {
        isEnabled: () => app.getLoginItemSettings(query).openAtLogin,
        set: (enabled) => app.setLoginItemSettings({ ...query, openAtLogin: enabled }),
    };
}

module.exports = { createAutostart, HIDDEN_ARG, linuxEntry };
