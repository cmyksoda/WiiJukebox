// SPDX-License-Identifier: GPL-3.0-only
// Desktop shell: runs the WiiJukebox server, shows its web UI in a window and keeps the
// music playing from the tray or menu bar after the window is closed.

const { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, shell, dialog, clipboard, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { detect, searchPath } = require('./lib/tools');
const { ServerProcess } = require('./lib/server');
const { installYtdlp } = require('./lib/ytdlp-install');
const { Settings, closeAction } = require('./lib/settings');
const { createAutostart, HIDDEN_ARG } = require('./lib/autostart');
const { serverConfig } = require('./lib/server-config');
const { wiiAddress, probeDiscovery, findFreePort, portIsFree } = require('./lib/network');
const { guidance, allowWindowsFirewall } = require('./lib/firewall');
const { openLog } = require('./lib/logfile');

const APP_ID = 'org.wiijukebox.desktop';
const TRAY_NAMES = { darwin: 'menu bar', win32: 'notification area', linux: 'system tray' };

// Lets tests and curious users keep the app's data apart from the real install.
if (process.env.WIIJUKEBOX_USER_DATA) app.setPath('userData', process.env.WIIJUKEBOX_USER_DATA);
// The server keeps its settings under XDG_CONFIG_HOME; Windows has no such default.
if (process.platform === 'win32' && !process.env.XDG_CONFIG_HOME) process.env.XDG_CONFIG_HOME = app.getPath('appData');
// An AppImage cannot ship the setuid sandbox helper; the windows only show our own server's pages.
if (process.platform === 'linux' && (process.env.APPIMAGE || process.argv.includes('--no-sandbox'))) {
    app.commandLine.appendSwitch('no-sandbox');
}
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

const packaged = app.isPackaged;
const serverRoot = packaged ? path.join(process.resourcesPath, 'server') : path.join(__dirname, '..', '..');
const bundledBin = packaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, 'app', 'bin');
const userBin = path.join(app.getPath('userData'), 'bin');
const logFile = path.join(app.getPath('userData'), 'logs', 'server.log');

const settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
const autostart = createAutostart({ app });
const serverSettings = serverConfig(serverRoot);

// Pointing these at a missing file makes the app behave as if the program were not installed.
const overrides = { ffmpeg: process.env.WIIJUKEBOX_FFMPEG, ytdlp: process.env.WIIJUKEBOX_YTDLP };
// Never shows any window (tests). Separate from --hidden, which only starts quietly and still shows problems.
const neverShow = Boolean(process.env.WIIJUKEBOX_HIDDEN);
const startedQuietly = process.argv.includes(HIDDEN_ARG) ||
    (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);

let win = null;
let guideWin = null;
let tray = null;
let server = null;
let log = null;
let tools = null;
let serverUrl = null;
let quitting = false;
let setupChosen = false;
let withoutFfmpeg = false;
let currentPage = 'starting';
let queue = Promise.resolve();
const notes = [];

const bg = () => (nativeTheme.shouldUseDarkColors ? '#0d141c' : '#f3f6f9');
const trayName = TRAY_NAMES[process.platform] || 'system tray';

function toolDirs() {
    return searchPath({ bundledDir: bundledBin, userBinDir: userBin, overrides });
}

// Tests read this to learn where the server is and which tools were found.
function writeState() {
    const file = process.env.WIIJUKEBOX_STATE_FILE;
    if (!file) return;
    const state = {
        pid: process.pid,
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        resources: process.resourcesPath,
        page: currentPage,
        setupDone: settings.get('setupDone'),
        openAtLogin: autostart.isEnabled(),
        serverUrl,
        ffmpeg: tools?.ffmpeg || null,
        ytdlp: tools?.ytdlp || null,
    };
    fs.writeFileSync(`${file}.part`, JSON.stringify(state));
    fs.renameSync(`${file}.part`, file);
}

function windowOptions(extra) {
    return {
        backgroundColor: bg(),
        title: 'WiiJukebox',
        icon: path.join(__dirname, 'assets', 'icon.png'),
        autoHideMenuBar: true,
        show: false,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
        ...extra,
    };
}

async function loadPage(target, page, params = {}) {
    const search = new URLSearchParams({ mode: page, ...params }).toString();
    // A newer navigation replacing this one is normal, not an error.
    await target.loadFile(path.join(__dirname, 'ui', 'app.html'), { search }).catch((err) => {
        if (err.code !== 'ERR_ABORTED') throw err;
    });
}

async function showPage(page, params = {}) {
    currentPage = page;
    writeState();
    await loadPage(win, page, params);
}

function showMainWindow() {
    if (neverShow) return;
    if (!win) createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
}

function createWindow() {
    win = new BrowserWindow(windowOptions({ width: 1280, height: 820, minWidth: 360, minHeight: 560 }));
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
    win.on('close', onWindowClose);
    win.on('closed', () => { win = null; });
}

function onWindowClose(event) {
    const action = closeAction({ quitting, mode: settings.get('onClose'), setupDone: settings.get('setupDone') });
    if (action === 'close') return;
    event.preventDefault();
    if (action === 'hide') win.hide();
    else askWhatClosingDoes();
}

async function askWhatClosingDoes() {
    const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Keep playing in the background', 'Quit WiiJukebox', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        message: 'Keep WiiJukebox running?',
        detail: `Your Wii can keep listening while the window is closed. WiiJukebox waits in the ${trayName}; ` +
            'choose Quit from its menu to stop it. You can change this later from that menu.',
    });
    if (response === 2) return;
    settings.set('onClose', response === 0 ? 'background' : 'quit');
    buildMenus();
    if (response === 0) win.hide();
    else app.quit();
}

function openGuide() {
    if (guideWin) {
        guideWin.show();
        guideWin.focus();
        return;
    }
    guideWin = new BrowserWindow(windowOptions({ width: 600, height: 780, minWidth: 380, minHeight: 480, title: 'Connect your Wii' }));
    guideWin.removeMenu();
    guideWin.on('closed', () => { guideWin = null; });
    loadPage(guideWin, 'connect', { help: '1' }).then(() => { if (!neverShow) guideWin?.show(); });
}

function step(text) {
    win?.webContents.send('desktop:step', text);
}

async function describeServer() {
    const config = serverSettings.read();
    const address = wiiAddress(config.hostIp, serverSettings.detectHostIp);
    const running = Boolean(server?.child && serverUrl);
    return {
        platform: process.platform,
        version: app.getVersion(),
        address,
        port: config.port,
        discoveryPort: config.discoveryPort,
        streamUrl: `http://${address}:${config.port}${config.mount}`,
        serverRunning: running,
        discovery: running ? await probeDiscovery(config.discoveryPort) : false,
        tools: { ffmpeg: tools?.ffmpeg?.version || null, ytdlp: tools?.ytdlp?.version || null },
        firewall: guidance({ platform: process.platform, port: config.port, discoveryPort: config.discoveryPort }),
        notes,
    };
}

// A server that never came up is shown as a busy port when that is why, otherwise as a crash.
async function showStartFailure(err) {
    const lines = server?.log.slice(-12).join('\n') || '';
    showMainWindow();
    if (/EADDRINUSE/.test(`${err.message}\n${lines}`)) {
        const { port } = serverSettings.read();
        await showPage('port-busy', { port, suggested: await findFreePort(port + 100) });
        return;
    }
    await showPage('crashed', { detail: `${err.message}\n\n${lines}` });
}

async function startServer() {
    log?.close();
    log = openLog(logFile);
    server = new ServerProcess({
        entry: path.join(serverRoot, 'src', 'main.js'),
        cwd: serverRoot,
        env: { PATH: toolDirs().join(path.delimiter) },
        nodePath: process.execPath,
    });
    server.on('line', (line) => log.write(line));
    server.on('crashed', async (reason) => {
        serverUrl = null;
        buildMenus();
        if (quitting || !win) return;
        showMainWindow();
        await showPage('crashed', { detail: `${reason}\n\n${server.log.slice(-12).join('\n')}` });
    });
    try {
        serverUrl = await server.start();
    } catch (err) {
        serverUrl = null;
        if (!quitting) await showStartFailure(err);
        return false;
    } finally {
        buildMenus();
    }
    writeState();
    return true;
}

// Starting and restarting never overlap, so a double click cannot leave two servers fighting over a port.
function serialized(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
}

const launch = () => serialized(launchNow);

// Finds the tools, then starts the server and shows whatever comes next: setup, errors or the player.
async function launchNow() {
    tools = await detect(toolDirs(), overrides);
    if (!tools.ffmpeg && !withoutFfmpeg) {
        showMainWindow();
        await showPage('ffmpeg', { platform: process.platform });
        return;
    }
    if (!settings.get('setupDone') && !setupChosen) {
        showMainWindow();
        await showPage('welcome');
        return;
    }
    if (!(await startServer())) return;
    if (settings.get('setupDone')) {
        await showPlayer();
        return;
    }
    settings.set('setupDone', true);
    showMainWindow();
    await showPage('connect');
}

async function showPlayer() {
    currentPage = 'player';
    writeState();
    await win.loadURL(serverUrl);
    win.setTitle('WiiJukebox');
}

async function openPlayer() {
    showMainWindow();
    if (serverUrl) await showPlayer();
}

const restartServer = () => serialized(async () => {
    await server?.stop();
    serverUrl = null;
    await launchNow();
});

async function beginSetup({ ytdlp, login }) {
    try {
        step('Saving your choices');
        autostart.set(Boolean(login));
        if (ytdlp) {
            step('Downloading yt-dlp');
            try {
                await installYtdlp(userBin);
            } catch (err) {
                notes.push(`yt-dlp could not be downloaded (${err.message}). Choose Install or update yt-dlp from the WiiJukebox menu to try again.`);
            }
        }
        setupChosen = true;
        step('Starting the music server');
        buildMenus();
        await launch();
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

async function runYtdlpInstall() {
    try {
        const file = await installYtdlp(userBin);
        notes.length = 0;
        await dialog.showMessageBox(win, { type: 'info', message: 'yt-dlp installed', detail: file });
        await restartServer();
    } catch (err) {
        dialog.showErrorBox('Could not install yt-dlp', err.message);
    }
}

function setOpenAtLogin(enabled) {
    try {
        autostart.set(enabled);
    } catch (err) {
        dialog.showErrorBox('Could not change start at login', err.message);
    }
    buildMenus();
}

function setKeepRunning(enabled) {
    settings.set('onClose', enabled ? 'background' : 'quit');
    buildMenus();
}

async function copyAddress(kind) {
    const info = await describeServer();
    clipboard.writeText(kind === 'stream' ? info.streamUrl : `${info.address}:${info.port}`);
}

// Entries shared by the application menu and the tray menu.
function commonItems() {
    return [
        { label: 'Connect your Wii…', click: openGuide },
        { label: 'Copy Wii address', click: () => copyAddress('wii') },
        { label: 'Copy stream address', click: () => copyAddress('stream') },
        { label: 'Open in browser', enabled: Boolean(serverUrl), click: () => shell.openExternal(serverUrl) },
        { type: 'separator' },
        { label: 'Restart server', click: () => restartServer() },
        { label: 'Install or update yt-dlp…', click: () => runYtdlpInstall() },
        { type: 'separator' },
        { label: 'Start at login', type: 'checkbox', checked: autostart.isEnabled(), click: (item) => setOpenAtLogin(item.checked) },
        {
            label: 'Keep playing when the window is closed',
            type: 'checkbox',
            checked: settings.get('onClose') !== 'quit',
            click: (item) => setKeepRunning(item.checked),
        },
        { type: 'separator' },
        { label: 'Show settings folder', click: () => shell.openPath(path.dirname(serverSettings.file)) },
        { label: 'Show server log', click: () => shell.showItemInFolder(logFile) },
    ];
}

function buildMenus() {
    const isMac = process.platform === 'darwin';
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
            label: 'WiiJukebox',
            submenu: [
                ...(isMac ? [{ role: 'about' }, { type: 'separator' }] : []),
                ...commonItems(),
                { type: 'separator' },
                ...(isMac ? [{ role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }] : []),
                { role: 'quit' },
            ],
        },
        { role: 'editMenu' },
        { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    ]));
    tray?.setContextMenu(Menu.buildFromTemplate([
        { label: serverUrl ? 'WiiJukebox is running' : 'WiiJukebox is not running', enabled: false },
        { label: 'Open WiiJukebox', click: () => openPlayer() },
        { type: 'separator' },
        ...commonItems(),
        { type: 'separator' },
        { label: 'Quit WiiJukebox', click: () => app.quit() },
    ]));
}

function createTray() {
    const mac = process.platform === 'darwin';
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', mac ? 'trayTemplate.png' : 'tray.png')));
    tray.setToolTip('WiiJukebox');
    tray.on('click', () => openPlayer());
}

// The pages with buttons are our own local files; nothing the server serves may call these.
function trusted(event) {
    if (!event.senderFrame?.url.startsWith('file:')) throw new Error('not allowed');
}

function handle(channel, fn) {
    ipcMain.handle(channel, (event, ...args) => {
        trusted(event);
        return fn(...args);
    });
}

handle('desktop:info', () => describeServer());
handle('desktop:begin-setup', (options) => beginSetup(options));
handle('desktop:open-player', () => openPlayer());
handle('desktop:recheck', () => launch());
handle('desktop:continue', () => {
    withoutFfmpeg = true;
    return launch();
});
handle('desktop:restart', () => restartServer());
handle('desktop:copy', (text) => {
    if (typeof text === 'string' && text.length < 2000) clipboard.writeText(text);
});
handle('desktop:set-port', async (port) => {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return { ok: false, error: 'Choose a number from 1024 to 65535.' };
    if (!(await portIsFree(port))) return { ok: false, error: `Port ${port} is in use as well. Try another.` };
    serverSettings.setPort(port);
    await restartServer();
    return { ok: true };
});
handle('desktop:allow-firewall', async () => {
    try {
        await allowWindowsFirewall(process.execPath);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    // A second launch brings the window back; "--quit" lets scripts and installers stop the app.
    app.on('second-instance', (event, argv) => {
        if (argv.includes('--quit')) app.quit();
        else showMainWindow();
    });
    app.on('activate', () => showMainWindow());
    app.on('before-quit', (event) => {
        quitting = true;
        if (!server?.child) return;
        event.preventDefault();
        server.stop().finally(() => app.quit());
    });
    app.on('will-quit', () => {
        tray?.destroy();
        log?.close();
    });
    app.on('window-all-closed', () => app.quit());
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.quit());

    app.whenReady().then(async () => {
        if (process.argv.includes('--quit')) return app.quit();
        createWindow();
        createTray();
        buildMenus();
        await showPage('starting');
        if (!startedQuietly) showMainWindow();
        await launch();
    });
}
