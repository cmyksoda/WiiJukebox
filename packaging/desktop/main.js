// SPDX-License-Identifier: GPL-3.0-only
// Desktop shell: runs the WiiJukebox server, shows its web UI in a window and keeps the
// music playing from the tray or menu bar after the window is closed.

const { app, BaseWindow, BrowserWindow, WebContentsView, Menu, MenuItem, Tray, nativeImage, nativeTheme, shell, dialog, clipboard, ipcMain } = require('electron');
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
const { READ_THEME, OPEN_SIDEBAR_SETTINGS, parsePageTheme, chooseThemeScript, forcedTheme, isDarkColor, ThemeFeed } = require('./lib/page-theme');
const { BAR_HEIGHT, layoutViews } = require('./lib/window-layout');
const { buildMenuModel } = require('./lib/menu-model');

const APP_ID = 'org.wiijukebox.desktop';
const TRAY_NAMES = { darwin: 'menu bar', win32: 'notification area', linux: 'system tray' };

// Lets tests and curious users keep the app's data apart from the real install.
if (process.env.WIIJUKEBOX_USER_DATA) app.setPath('userData', process.env.WIIJUKEBOX_USER_DATA);
// The server keeps its settings under XDG_CONFIG_HOME; Windows has no such default.
if (process.platform === 'win32' && !process.env.XDG_CONFIG_HOME) process.env.XDG_CONFIG_HOME = app.getPath('appData');
// An AppImage cannot ship the setuid sandbox helper, and turning the sandbox off from here is too late:
// Chromium's helpers have already started sandboxed and lose /dev/shm. So restart once with it on argv.
const relaunching = process.platform === 'linux' && Boolean(process.env.APPIMAGE) && !process.argv.includes('--no-sandbox');
if (relaunching) {
    // app.relaunch does nothing this early, so start the AppImage again ourselves.
    require('node:child_process').spawn(process.env.APPIMAGE, [...process.argv.slice(1), '--no-sandbox'],
        { detached: true, stdio: 'inherit' }).unref();
    app.exit(0);
} else if (process.platform === 'linux' && process.argv.includes('--no-sandbox')) {
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
// The "Keep WiiJukebox running?" card while it is up, and what to do with its answer.
let closeDialog = null;
let answerClose = null;
// While the bar's menu shows, the bar's view covers the whole window; these keep it and what each entry does.
let menuOpen = false;
let menuActions = null;
let relayout = () => {};
let titleFeed = null;
let themeFeed = null;
// The web UI's own choice (System, Light or Dark), read back from the page.
let themeChoice = 'system';
// Whether the page's theme-color tag says dark, which is what the page looks like right now. Null while it has none.
let pageDark = null;
let playbackTitle = APP_NAME;
let windowTitleText = APP_NAME;
let queue = Promise.resolve();
const notes = [];

const pageIsDark = () => pageDark ?? (themeChoice === 'system' ? nativeTheme.shouldUseDarkColors : themeChoice === 'dark');
const bg = () => (pageIsDark() ? '#0d141c' : '#f3f6f9');
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
    // Views hidden with their window can come back unpainted until something invalidates them.
    relayout?.();
    content.webContents.invalidate();
    bar?.webContents.invalidate();
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
    menuOpen = false;
    menuActions = null;
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
        const plan = layoutViews({ width, height, showBar: Boolean(barView) && !htmlFullScreen && !window.isFullScreen(), menuOpen });
        barView?.setVisible(Boolean(plan.bar));
        if (plan.bar) barView.setBounds(plan.bar);
        view.setBounds(plan.page);
    };
    const fullScreenChanged = (entered) => () => {
        htmlFullScreen = entered;
        closeBarMenu();
        layout();
    };
    view.webContents.on('did-change-theme-color', (event, color) => {
        if (content === view) onPageColor(color);
    });
    view.webContents.on('enter-html-full-screen', fullScreenChanged(true));
    view.webContents.on('leave-html-full-screen', fullScreenChanged(false));
    window.contentView.on('bounds-changed', layout);
    // A window created hidden can report a 0x0 content area on Linux, and showing it fires no bounds change.
    for (const event of ['enter-full-screen', 'leave-full-screen', 'show', 'restore', 'resize', 'maximize', 'unmaximize']) window.on(event, layout);
    layout();
    relayout = layout;

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
    for (const event of ['minimize', 'hide', 'enter-full-screen']) window.on(event, closeBarMenu);
    window.on('close', onWindowClose);
    window.on('closed', () => {
        // A view's page outlives its window until it is closed too.
        for (const child of [view, barView]) {
            if (child && !child.webContents.isDestroyed()) child.webContents.close();
        }
        if (win === window) {
            win = content = bar = null;
            menuOpen = false;
            menuActions = null;
        }
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

// The bar is told the page's look when it has one; with none (a setup page) it follows the system as the page does.
const barTheme = () => (pageDark === null ? forcedTheme(themeChoice) : pageDark ? 'dark' : 'light');

function barState() {
    return { title: windowTitleText, maximized: Boolean(win?.isMaximized()), focused: Boolean(win?.isFocused()), theme: barTheme() };
}

function sendBarState() {
    if (bar && !bar.webContents.isDestroyed()) bar.webContents.send('titlebar:state', barState());
}

async function readPageTheme() {
    const page = content?.webContents;
    if (!page || page.isDestroyed() || page.isLoading()) return null;
    return parsePageTheme(await page.executeJavaScript(READ_THEME));
}

// The bar first, since it is what the eye catches changing, then the backdrops behind the views.
function showPageTheme() {
    sendBarState();
    const color = bg();
    win?.setBackgroundColor(color);
    content?.setBackgroundColor(color);
    if (!menuOpen) bar?.setBackgroundColor(color);
    writeState();
}

// The poll's answer is the page's own choice, so it settles any guess; the tag takes over again on its next change.
function onThemeChange(choice) {
    themeChoice = choice;
    pageDark = null;
    showPageTheme();
    buildMenus();
}

// The page changes its theme-color tag in the same step as its look, so the bar need not wait for the next poll.
function onPageColor(color) {
    pageDark = isDarkColor(color);
    showPageTheme();
    themeFeed?.poll({ force: true });
}

// The page's own control is pressed, so its stored choice, its look and its buttons all follow. The bar is switched
// at once rather than after the page's answer, which then corrects any guess.
async function setPageTheme(choice) {
    if (currentPage !== 'player' || !content) return;
    themeChoice = choice;
    pageDark = choice === 'system' ? nativeTheme.shouldUseDarkColors : choice === 'dark';
    showPageTheme();
    buildMenus();
    await content.webContents.executeJavaScript(chooseThemeScript(choice)).catch(() => {});
    themeFeed?.forget();
    await themeFeed?.poll({ force: true });
}

// The sheet is the page's own, opened by pressing its control, so a window in the tray comes back to show it.
async function openSidebarSettings() {
    if (currentPage !== 'player' || !content) return;
    showMainWindow();
    await content.webContents.executeJavaScript(OPEN_SIDEBAR_SETTINGS).catch(() => {});
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

const CLOSE_DIALOG_WIDTH = 376;
const CLOSE_CHOICES = ['cancel', 'quit', 'background'];

// A small card of our own instead of a native message box, whose three buttons Electron stacks into a wide window.
// It is its own window, so it shows the same however the main window was asked to close (the bar's ×, Alt+F4, the taskbar).
function showCloseDialog() {
    return new Promise((resolve) => {
        // A window closed from the taskbar is still minimized, and a card over nothing would not be seen.
        if (win.isMinimized()) win.restore();
        const dialog = new BrowserWindow({
            parent: win,
            modal: true,
            show: false,
            frame: false,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            skipTaskbar: true,
            useContentSize: true,
            width: CLOSE_DIALOG_WIDTH,
            height: 200,
            backgroundColor: bg(),
            title: 'Keep WiiJukebox running?',
            webPreferences: { preload: path.join(__dirname, 'close-preload.js'), contextIsolation: true, sandbox: true },
        });
        dialog.removeMenu();
        closeDialog = dialog;
        let answer = { choice: 'cancel', remember: false };
        answerClose = (given) => {
            answer = given;
            dialog.close();
        };
        dialog.on('closed', () => {
            closeDialog = null;
            answerClose = null;
            resolve(answer);
        });
        const search = new URLSearchParams({ tray: trayName });
        if (forcedTheme(themeChoice)) search.set('theme', forcedTheme(themeChoice));
        dialog.webContents.loadFile(path.join(__dirname, 'ui', 'close.html'), { search: search.toString() });
    });
}

// The card tells main how tall it is; the window is then sized to it, centered over the main window, and shown.
function presentCloseDialog(height) {
    const dialog = closeDialog;
    if (!dialog || dialog.isVisible() || !Number.isFinite(height)) return;
    const content = Math.min(400, Math.max(120, Math.ceil(height / 2) * 2));
    dialog.setContentSize(CLOSE_DIALOG_WIDTH, content);
    const parent = win?.getBounds();
    const [width, tall] = dialog.getSize();
    if (parent) dialog.setPosition(Math.round(parent.x + (parent.width - width) / 2), Math.round(parent.y + (parent.height - tall) / 2));
    if (!neverShow) dialog.show();
}

async function askWhatClosingDoes() {
    if (closeDialog) {
        closeDialog.focus();
        return;
    }
    const { choice, remember } = await showCloseDialog();
    if (quitting || choice === 'cancel') return;
    if (remember) {
        settings.set('onClose', choice);
        buildMenus();
    }
    if (choice === 'background') hideToTray();
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
        { id: 'sidebar-settings', label: 'Sidebar settings…', enabled: currentPage === 'player', click: openSidebarSettings },
        { type: 'separator' },
        { label: 'Show settings folder', click: () => shell.openPath(path.dirname(serverSettings.file)) },
        { label: 'Show server log', click: () => shell.showItemInFolder(logFile) },
    ];
}

const viewItems = () => [
    { role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' },
];

// What the bar's own menu shows: the entries above, as a list, with the View submenu and Quit at the end.
const barMenuTemplate = () => [
    ...commonItems(),
    { type: 'separator' },
    { label: 'View', submenu: viewItems() },
    { type: 'separator' },
    { role: 'quit' },
];

// Roles have no function of their own in a menu we draw, so these are what they do, as Electron's do.
const zoomBy = (step) => () => content?.webContents.setZoomLevel(content.webContents.getZoomLevel() + step);
const roleActions = {
    reload: () => content?.webContents.reload(),
    resetZoom: () => content?.webContents.setZoomLevel(0),
    zoomIn: zoomBy(0.5),
    zoomOut: zoomBy(-0.5),
    togglefullscreen: () => win?.setFullScreen(!win.isFullScreen()),
    quit: () => app.quit(),
};

// A window without a system frame has no menu bar to show with Alt, so the bar draws its menu itself. Electron
// cannot size a native popup, which came out far larger than the bar's text.
function openBarMenu() {
    if (!bar || menuOpen) return;
    const { items, actions } = buildMenuModel(barMenuTemplate(), {
        resolveRole: (role) => {
            const { label, accelerator } = new MenuItem({ role });
            return { label, accelerator };
        },
        roleActions,
    });
    menuActions = actions;
    menuOpen = true;
    // Opaque keeps the bar's text subpixel-sharp, so it is clear only while it covers the page for its menu.
    bar.setBackgroundColor('#00000000');
    bar.webContents.send('titlebar:menu', { items });
    // Growing in the same frame as the switch to clear can paint the whole view black on X11.
    setTimeout(() => {
        if (!menuOpen || !bar) return;
        relayout();
        bar.webContents.focus();
    }, 34);
}

function closeBarMenu() {
    if (!menuOpen) return;
    menuOpen = false;
    menuActions = null;
    relayout();
    setTimeout(() => { if (!menuOpen) bar?.setBackgroundColor(bg()); }, 34);
    if (bar && !bar.webContents.isDestroyed()) bar.webContents.send('titlebar:menu-closed');
    content?.webContents.focus();
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
fromBarOnly('titlebar:menu-open', () => openBarMenu());
fromBarOnly('titlebar:menu-close', () => closeBarMenu());
// The bar names an entry by the id main gave it, and only an entry main listed as usable has anything to run.
fromBarOnly('titlebar:menu-activate', (id) => {
    const action = typeof id === 'string' ? menuActions?.get(id) : null;
    closeBarMenu();
    action?.();
});

// Only the close card may answer it, and only with one of its three choices.
const fromCloseDialog = (event) => Boolean(closeDialog) && event.sender === closeDialog.webContents;
ipcMain.on('close-dialog:ready', (event, height) => {
    if (fromCloseDialog(event)) presentCloseDialog(height);
});
ipcMain.on('close-dialog:answer', (event, answer) => {
    if (fromCloseDialog(event) && CLOSE_CHOICES.includes(answer?.choice)) answerClose({ choice: answer.choice, remember: answer.remember === true });
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

// While relaunching, the lock and everything else belong to the new instance.
if (!relaunching && !app.requestSingleInstanceLock()) {
    app.quit();
} else if (!relaunching) {
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
        nativeTheme.on('updated', () => {
            if (themeChoice === 'system' && pageDark !== null) pageDark = nativeTheme.shouldUseDarkColors;
            showPageTheme();
        });
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
