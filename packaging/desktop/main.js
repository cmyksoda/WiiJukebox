// SPDX-License-Identifier: GPL-3.0-only
// Desktop shell: runs the WiiJukebox server, shows its web UI in a window and keeps the
// music playing from the tray or menu bar after the window is closed.

const { app, BaseWindow, BrowserWindow, WebContentsView, Menu, Tray, nativeImage, nativeTheme, shell, dialog, clipboard, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { detect, searchPath, findTool, ffmpegProblem, ffmpegVersionNumber } = require('./lib/tools');
const { ServerProcess } = require('./lib/server');
const { installYtdlp } = require('./lib/ytdlp-install');
const { Settings, closeAction } = require('./lib/settings');
const { createAutostart, HIDDEN_ARG } = require('./lib/autostart');
const { serverConfig, checkServerChoice, validatePort, MAX_NAME_LENGTH } = require('./lib/server-config');
const { wiiAddress, probeDiscovery, findFreePort, portIsFree } = require('./lib/network');
const { guidance, allowWindowsFirewall } = require('./lib/firewall');
const { openLog } = require('./lib/logfile');
const { APP_NAME, TitleFeed } = require('./lib/window-title');
const { READ_THEME, parsePageTheme, chooseThemeScript, forcedTheme, ThemeFeed } = require('./lib/page-theme');
const { BAR_HEIGHT, layoutViews } = require('./lib/window-layout');

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

// The main window holds the page (the web UI or one of our local pages) and, unless the system's own
// title bar is chosen, a small view of our own above it.
let win = null;
let content = null;
let bar = null;
let guideWin = null;
let serverWin = null;
let tray = null;
let server = null;
let log = null;
let tools = null;
let serverUrl = null;
let quitting = false;
let setupChosen = false;
let withoutFfmpeg = false;
let currentPage = 'starting';
let lastLoad = null;
let hiddenToTray = false;
let titleFeed = null;
let themeFeed = null;
// The web UI's own choice (System, Light or Dark), read back from the page; it also decides the window's backdrop.
let themeChoice = 'system';
let playbackTitle = APP_NAME;
let windowTitleText = APP_NAME;
let queue = Promise.resolve();
const notes = [];

const bg = () => ((themeChoice === 'system' ? nativeTheme.shouldUseDarkColors : themeChoice === 'dark') ? '#0d141c' : '#f3f6f9');
const trayName = TRAY_NAMES[process.platform] || 'system tray';

// A development run has no bundled FFmpeg, so the option to choose between the two does not exist there.
const bundledFfmpeg = () => findTool('ffmpeg', [bundledBin]);
const useBundled = () => Boolean(bundledFfmpeg()) && settings.get('useBundledFfmpeg');

let bundledVersion = null;
const bundledFfmpegVersion = () => {
    bundledVersion ??= detect([bundledBin]).then(({ ffmpeg }) => ffmpegVersionNumber(ffmpeg?.version));
    return bundledVersion;
};

function toolDirs() {
    return searchPath({ bundledDir: bundledBin, userBinDir: userBin, overrides, useBundled: useBundled() });
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
        useBundledFfmpeg: useBundled(),
        systemTitleBar: settings.get('systemTitleBar'),
        windowTitle: windowTitleText,
        theme: themeChoice,
        tray: Boolean(tray),
        serverUrl,
        ffmpeg: tools?.ffmpeg || null,
        ytdlp: tools?.ytdlp || null,
    };
    try {
        fs.writeFileSync(`${file}.part`, JSON.stringify(state));
        fs.renameSync(`${file}.part`, file);
    } catch {
        // Windows will not replace a file the test is reading at that moment; try again with fresh state.
        setTimeout(writeState, 50);
    }
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

// What the main window shows is remembered so a rebuilt window can show it again.
async function showPage(page, params = {}) {
    currentPage = page;
    lastLoad = () => loadPage(content.webContents, page, params);
    writeState();
    buildMenus();
    await lastLoad();
    refreshTitle();
    themeFeed?.poll({ force: true });
}

function showMainWindow() {
    if (neverShow) return;
    if (!win) createWindow();
    hiddenToTray = false;
    titleFeed?.resume();
    themeFeed?.resume();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    content.webContents.focus();
}

const customBar = () => !settings.get('systemTitleBar');

function mainWindowOptions() {
    const base = {
        width: 1280,
        height: 820,
        minWidth: 360,
        minHeight: 560,
        backgroundColor: bg(),
        title: APP_NAME,
        icon: path.join(__dirname, 'assets', 'icon.png'),
        autoHideMenuBar: true,
        show: false,
    };
    if (!customBar()) return base;
    // A Mac keeps its own window buttons, inset into our bar; elsewhere the bar draws them.
    return process.platform === 'darwin'
        ? { ...base, titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: Math.round((BAR_HEIGHT - 12) / 2) } }
        : { ...base, frame: false };
}

function createWindow(geometry) {
    const window = new BaseWindow({ ...mainWindowOptions(), ...geometry?.bounds });
    const view = new WebContentsView({
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
    });
    const barView = customBar()
        ? new WebContentsView({
            webPreferences: { preload: path.join(__dirname, 'titlebar-preload.js'), contextIsolation: true, sandbox: true },
        })
        : null;
    for (const child of [view, barView]) {
        if (!child) continue;
        child.setBackgroundColor(bg());
        window.contentView.addChildView(child);
    }
    barView?.webContents.loadFile(path.join(__dirname, 'ui', 'titlebar.html'));
    if (geometry?.maximized) window.maximize();

    // A page that goes fullscreen (the visualizer, F11) takes the whole display, so the bar steps aside.
    let htmlFullScreen = false;
    const layout = () => {
        if (window.isDestroyed()) return;
        const { width, height } = window.contentView.getBounds();
        const plan = layoutViews({ width, height, showBar: Boolean(barView) && !htmlFullScreen && !window.isFullScreen() });
        barView?.setVisible(Boolean(plan.bar));
        if (plan.bar) barView.setBounds(plan.bar);
        view.setBounds(plan.page);
    };
    const fullScreenChanged = (entered) => () => {
        htmlFullScreen = entered;
        layout();
    };
    view.webContents.on('enter-html-full-screen', fullScreenChanged(true));
    view.webContents.on('leave-html-full-screen', fullScreenChanged(false));
    window.contentView.on('bounds-changed', layout);
    for (const event of ['enter-full-screen', 'leave-full-screen']) window.on(event, layout);
    layout();

    // Links to other sites (such as a service's sign-in page) open in the real browser.
    view.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    view.webContents.on('will-navigate', (event, url) => {
        if (serverUrl && !url.startsWith(serverUrl) && /^https?:/.test(url)) {
            event.preventDefault();
            shell.openExternal(url);
        }
    });
    for (const event of ['maximize', 'unmaximize', 'focus', 'blur']) window.on(event, sendBarState);
    window.on('close', onWindowClose);
    window.on('closed', () => {
        // A view's page outlives its window until it is closed too.
        for (const child of [view, barView]) {
            if (child && !child.webContents.isDestroyed()) child.webContents.close();
        }
        if (win === window) win = content = bar = null;
    });
    win = window;
    content = view;
    bar = barView;
    window.setTitle(windowTitleText);
    return window;
}

// The setting only decides how a window is built, so a change builds a new one around the same page.
async function rebuildWindow() {
    const old = win;
    const geometry = { bounds: old.getNormalBounds(), maximized: old.isMaximized() };
    const shown = !hiddenToTray && (old.isVisible() || old.isMinimized());
    createWindow(geometry);
    await lastLoad?.();
    if (shown) showMainWindow();
    old.destroy();
}

async function setSystemTitleBar(enabled) {
    settings.set('systemTitleBar', enabled);
    buildMenus();
    if (win) await rebuildWindow();
    writeState();
}

function barState() {
    return { title: windowTitleText, maximized: Boolean(win?.isMaximized()), focused: Boolean(win?.isFocused()), theme: forcedTheme(themeChoice) };
}

function sendBarState() {
    if (bar && !bar.webContents.isDestroyed()) bar.webContents.send('titlebar:state', barState());
}

async function readPageTheme() {
    const page = content?.webContents;
    if (!page || page.isDestroyed() || page.isLoading()) return null;
    return parsePageTheme(await page.executeJavaScript(READ_THEME));
}

function onThemeChange(choice) {
    themeChoice = choice;
    win?.setBackgroundColor(bg());
    content?.setBackgroundColor(bg());
    bar?.setBackgroundColor(bg());
    buildMenus();
    sendBarState();
    writeState();
}

// The page's own control is pressed, so its stored choice, its look and its buttons all follow.
async function setPageTheme(choice) {
    if (currentPage !== 'player' || !content) return;
    await content.webContents.executeJavaScript(chooseThemeScript(choice)).catch(() => {});
    await themeFeed?.poll({ force: true });
}

// Page titles of the web UI are ignored: the title comes from the server's status, so it reads the same everywhere.
function refreshTitle() {
    const next = currentPage === 'player' ? playbackTitle : APP_NAME;
    if (next === windowTitleText) return;
    windowTitleText = next;
    win?.setTitle(next);
    sendBarState();
    writeState();
}

function hideToTray() {
    hiddenToTray = true;
    titleFeed?.pause();
    themeFeed?.pause();
    win.hide();
}

function onWindowClose(event) {
    const action = closeAction({ quitting, mode: settings.get('onClose'), setupDone: settings.get('setupDone') });
    if (action === 'close') return;
    event.preventDefault();
    if (action === 'hide') hideToTray();
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
    if (response === 0) hideToTray();
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
    loadPage(guideWin.webContents, 'connect', { help: '1' }).then(() => { if (!neverShow) guideWin?.show(); });
}

function openServerSettings() {
    if (serverWin) {
        serverWin.show();
        serverWin.focus();
        return;
    }
    serverWin = new BrowserWindow(windowOptions({ width: 560, height: 640, minWidth: 380, minHeight: 520, title: 'Server name and port' }));
    serverWin.removeMenu();
    serverWin.on('closed', () => { serverWin = null; });
    loadPage(serverWin.webContents, 'server').then(() => { if (!neverShow) serverWin?.show(); });
}

function step(text) {
    content?.webContents.send('desktop:step', text);
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
        server: { name: config.station.name, port: config.port, maxNameLength: MAX_NAME_LENGTH },
        engine: { bundled: Boolean(bundledFfmpeg()), useBundled: useBundled(), bundledVersion: await bundledFfmpegVersion() },
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

// The page names the problem and, when the user turned the included FFmpeg off, offers the way back.
function ffmpegPageParams(problem) {
    const found = tools.ffmpeg;
    return {
        platform: process.platform,
        problem,
        system: bundledFfmpeg() && !useBundled() ? '1' : '',
        path: found?.path || '',
        version: ffmpegVersionNumber(found?.version) || '',
    };
}

// Finds the tools, then starts the server and shows whatever comes next: setup, errors or the player.
async function launchNow() {
    tools = await detect(toolDirs(), overrides);
    const problem = ffmpegProblem(tools.ffmpeg);
    if (problem && !withoutFfmpeg) {
        showMainWindow();
        await showPage('ffmpeg', ffmpegPageParams(problem));
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
    buildMenus();
    showMainWindow();
    await showPage('connect');
}

async function showPlayer() {
    currentPage = 'player';
    const url = serverUrl;
    lastLoad = () => content.webContents.loadURL(url);
    writeState();
    buildMenus();
    await lastLoad();
    refreshTitle();
    themeFeed?.poll({ force: true });
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

function setBundledFfmpeg(enabled) {
    settings.set('useBundledFfmpeg', enabled);
    withoutFfmpeg = false;
    buildMenus();
    return restartServer();
}

// The port the running server holds, which is not "in use" when the user keeps it.
const runningPort = () => (server?.child && serverUrl ? serverSettings.read().port : null);

async function changeServer(choice) {
    const checked = await checkServerChoice(choice, runningPort());
    if (!checked.ok) return checked;
    const current = serverSettings.read();
    if (checked.name !== current.station.name || checked.port !== current.port) {
        // Stopped first so the server cannot write its old values over the new ones as it exits.
        await serialized(async () => {
            await server?.stop();
            serverUrl = null;
            serverSettings.setServer(checked);
            await launchNow();
        });
    }
    serverWin?.close();
    return { ok: true };
}

async function beginSetup({ ytdlp, login, bundled, server: serverChoice } = {}) {
    try {
        let chosen = null;
        if (serverChoice) {
            chosen = await checkServerChoice(serverChoice);
            if (!chosen.ok) return chosen;
        }
        step('Saving your choices');
        if (bundledFfmpeg() && typeof bundled === 'boolean') settings.set('useBundledFfmpeg', bundled);
        if (chosen) serverSettings.setServer(chosen);
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
        { id: 'server-settings', label: 'Server name and port…', enabled: Boolean(settings.get('setupDone')), click: openServerSettings },
        { label: 'Install or update yt-dlp…', click: () => runYtdlpInstall() },
        ...(bundledFfmpeg()
            ? [{ id: 'bundled-ffmpeg', label: 'Use included FFmpeg', type: 'checkbox', checked: useBundled(), click: (item) => setBundledFfmpeg(item.checked) }]
            : []),
        { type: 'separator' },
        { label: 'Start at login', type: 'checkbox', checked: autostart.isEnabled(), click: (item) => setOpenAtLogin(item.checked) },
        {
            label: 'Keep playing when the window is closed',
            type: 'checkbox',
            checked: settings.get('onClose') !== 'quit',
            click: (item) => setKeepRunning(item.checked),
        },
        {
            id: 'system-title-bar',
            label: 'Use system title bar',
            type: 'checkbox',
            checked: settings.get('systemTitleBar'),
            enabled: Boolean(settings.get('setupDone')),
            click: (item) => setSystemTitleBar(item.checked),
        },
        {
            label: 'Theme',
            enabled: currentPage === 'player',
            submenu: [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([id, label]) => ({
                id: `theme-${id}`, label, type: 'radio', checked: themeChoice === id, click: () => setPageTheme(id),
            })),
        },
        { type: 'separator' },
        { label: 'Show settings folder', click: () => shell.openPath(path.dirname(serverSettings.file)) },
        { label: 'Show server log', click: () => shell.showItemInFolder(logFile) },
    ];
}

const viewItems = () => [
    { role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' },
];

// The custom bar has no menu bar to hide behind Alt, so its menu button opens the same entries as a list.
function popupMenu({ x, y }) {
    const menu = Menu.buildFromTemplate([
        ...commonItems(),
        { type: 'separator' },
        { label: 'View', submenu: viewItems() },
        { type: 'separator' },
        { role: 'quit' },
    ]);
    menu.popup({ window: win, x: Math.round(x), y: Math.round(y), callback: () => content?.webContents.focus() });
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
        { label: 'View', submenu: viewItems() },
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

// Only our own bar page may press the window buttons, and the web UI has no bridge at all.
const fromBar = (event) => Boolean(bar) && event.sender === bar.webContents;
const fromBarOnly = (channel, action) => ipcMain.on(channel, (event, ...args) => {
    if (fromBar(event)) action(...args);
});

ipcMain.handle('titlebar:ready', (event) => (fromBar(event) ? barState() : null));
fromBarOnly('titlebar:minimize', () => win.minimize());
fromBarOnly('titlebar:toggle-maximize', () => {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    content.webContents.focus();
});
fromBarOnly('titlebar:close', () => win.close());
fromBarOnly('titlebar:menu', (at) => {
    if (Number.isFinite(at?.x) && Number.isFinite(at?.y)) popupMenu(at);
});

handle('desktop:info', () => describeServer());
handle('desktop:begin-setup', (options) => beginSetup(options));
handle('desktop:use-bundled', () => setBundledFfmpeg(true));
handle('desktop:save-server', (choice) => changeServer(choice));
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
    const checked = validatePort(port);
    if (!checked.ok) return checked;
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
        titleFeed?.stop();
        themeFeed?.stop();
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
        titleFeed = new TitleFeed({
            getUrl: () => (currentPage === 'player' ? serverUrl : null),
            onTitle: (title) => {
                playbackTitle = title;
                refreshTitle();
            },
        });
        titleFeed.start();
        themeFeed = new ThemeFeed({ read: readPageTheme, onChange: onThemeChange });
        themeFeed.start();
        await showPage('starting');
        if (!startedQuietly) showMainWindow();
        else {
            hiddenToTray = true;
            titleFeed.pause();
            themeFeed.pause();
        }
        await launch();
    });
}
