// SPDX-License-Identifier: GPL-3.0-only
// Desktop shell: starts the WiiJukebox server and shows its web UI in a window.

const { app, BrowserWindow, Menu, shell, dialog, clipboard, ipcMain, nativeTheme } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detect, searchPath } = require('./lib/tools');
const { ServerProcess } = require('./lib/server');
const { installYtdlp } = require('./lib/ytdlp-install');

// An AppImage cannot ship the setuid sandbox helper; the window only shows our own server's pages.
if (process.platform === 'linux' && (process.env.APPIMAGE || process.argv.includes('--no-sandbox'))) {
    app.commandLine.appendSwitch('no-sandbox');
}

const packaged = app.isPackaged;
const serverRoot = packaged ? path.join(process.resourcesPath, 'server') : path.join(__dirname, '..', '..');
const bundledBin = packaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, 'app', 'bin');
const userBin = path.join(app.getPath('userData'), 'bin');

let win = null;
let server = null;
let tools = null;
let serverUrl = null;
let quitting = false;

const bg = () => (nativeTheme.shouldUseDarkColors ? '#0d141c' : '#f3f6f9');

// Pointing these at a missing file makes the app behave as if the program were not installed.
const overrides = { ffmpeg: process.env.WIIJUKEBOX_FFMPEG, ytdlp: process.env.WIIJUKEBOX_YTDLP };

function toolDirs() {
    return searchPath({ bundledDir: bundledBin, userBinDir: userBin, overrides });
}

function serverEnvironment() {
    const env = { PATH: toolDirs().join(path.delimiter) };
    // The server keeps its settings in an XDG-style folder; Windows has no such default.
    if (process.platform === 'win32' && !process.env.XDG_CONFIG_HOME) env.XDG_CONFIG_HOME = app.getPath('appData');
    return env;
}

function showPage(page, params = {}) {
    const query = new URLSearchParams(params).toString();
    return win.loadFile(path.join(__dirname, page), { search: query });
}

async function startServer() {
    server = new ServerProcess({
        entry: path.join(serverRoot, 'src', 'main.js'),
        cwd: serverRoot,
        env: serverEnvironment(),
        nodePath: process.execPath,
    });
    server.on('crashed', (reason) => {
        if (quitting || !win) return;
        showPage('setup.html', { mode: 'crashed', detail: `${reason}\n\n${server.log.slice(-12).join('\n')}` });
    });
    try {
        serverUrl = await server.start();
    } catch (err) {
        await showPage('setup.html', { mode: 'crashed', detail: `${err.message}\n\n${server?.log.slice(-12).join('\n') || ''}` });
        return false;
    }
    await win.loadURL(serverUrl);
    win.setTitle('WiiJukebox');
    return true;
}

async function launch() {
    tools = await detect(toolDirs(), overrides);
    if (!tools.ffmpeg) {
        await showPage('setup.html', { mode: 'ffmpeg', platform: process.platform });
        return;
    }
    if (await startServer()) offerYtdlp();
}

// yt-dlp is optional, so ask once instead of blocking the app on it.
async function offerYtdlp() {
    if (tools.ytdlp) return;
    const flag = path.join(app.getPath('userData'), 'ytdlp-offered');
    if (fs.existsSync(flag)) return;
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    fs.writeFileSync(flag, '1');
    const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Install yt-dlp', 'Not now'],
        defaultId: 0,
        cancelId: 1,
        message: 'Install yt-dlp?',
        detail: 'YouTube, YouTube Music, SoundCloud and Bandcamp links need yt-dlp. ' +
            'It is a small free program and will be saved inside this app\'s own folder.',
    });
    if (response === 0) await runYtdlpInstall();
}

async function runYtdlpInstall() {
    try {
        const file = await installYtdlp(userBin);
        await dialog.showMessageBox(win, { type: 'info', message: 'yt-dlp installed', detail: file });
        tools = await detect(toolDirs(), overrides);
        await restartServer();
    } catch (err) {
        dialog.showErrorBox('Could not install yt-dlp', err.message);
    }
}

async function restartServer() {
    if (server) await server.stop();
    await launch();
}

function createWindow() {
    win = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 360,
        minHeight: 560,
        backgroundColor: bg(),
        title: 'WiiJukebox',
        autoHideMenuBar: true,
        show: !process.env.WIIJUKEBOX_HIDDEN,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            sandbox: true,
        },
    });
    // Links to other sites (such as a service's sign-in page) open in the real browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
        if (serverUrl && !url.startsWith(serverUrl) && /^https?:/.test(url)) {
            event.preventDefault();
            shell.openExternal(url);
        }
    });
    win.on('closed', () => { win = null; });
}

function buildMenu() {
    const template = [
        {
            label: 'WiiJukebox',
            submenu: [
                { label: 'Copy Wii stream address', click: () => serverUrl && clipboard.writeText(`${serverUrl.replace('127.0.0.1', lanAddress())}stream`) },
                { label: 'Open in browser', click: () => serverUrl && shell.openExternal(serverUrl) },
                { label: 'Restart server', click: () => restartServer() },
                { type: 'separator' },
                { label: 'Install or update yt-dlp…', click: () => runYtdlpInstall() },
                { label: 'Show settings folder', click: () => shell.openPath(path.dirname(configFile())) },
                { type: 'separator' },
                { role: 'quit' },
            ],
        },
        { role: 'editMenu' },
        { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function configFile() {
    const base = process.env.XDG_CONFIG_HOME ||
        (process.platform === 'win32' ? app.getPath('appData')
            : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
                : path.join(os.homedir(), '.config'));
    return path.join(base, 'wiijukebox', 'config.json');
}

function lanAddress() {
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const addr of addrs || []) {
            if (addr.family === 'IPv4' && !addr.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(addr.address)) return addr.address;
        }
    }
    return '127.0.0.1';
}

ipcMain.handle('desktop:recheck', async () => {
    await launch();
});
ipcMain.handle('desktop:continue', async () => {
    if (await startServer()) offerYtdlp();
});
ipcMain.handle('desktop:restart', async () => {
    await restartServer();
});
ipcMain.handle('desktop:install-ytdlp', async () => {
    await runYtdlpInstall();
});

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });
    app.whenReady().then(async () => {
        buildMenu();
        createWindow();
        await launch();
    });
    app.on('before-quit', async (event) => {
        if (quitting || !server?.child) return;
        quitting = true;
        event.preventDefault();
        await server.stop();
        app.quit();
    });
    app.on('window-all-closed', () => app.quit());
}
