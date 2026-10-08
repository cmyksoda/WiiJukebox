// SPDX-License-Identifier: GPL-3.0-only
// End-to-end check of a packaged app, run hidden. Ports: <port> web, <port>+1 discovery, <port>+10 debugging,
// <port>+11 for the main-process inspector (the Server name and port window is opened through it).
// Usage: node scripts/smoke.js <app executable or .app> [--port 4680] [--arch x86_64] [--login]
// --login also ticks "start at login", which changes the system's login items; remove them afterwards.
// --ytdlp also ticks the yt-dlp download, which needs the network.
// --default-ports also runs the app with the server's own default ports; do not use it next to a real server.

const { spawn, execFile, execFileSync } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const target = args.find((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'));
if (!target) {
    console.error('usage: node scripts/smoke.js <app executable or .app> [--port 4680] [--arch x86_64] [--login] [--ytdlp] [--default-ports]');
    process.exit(2);
}
const PORT = Number(option('--port', 4680));
const DISCOVERY_PORT = PORT + 1;
const DEBUG_PORT = PORT + 10;
const INSPECT_PORT = PORT + 11;
const ARCH = option('--arch', null);
const LOGIN = args.includes('--login');
const YTDLP = args.includes('--ytdlp');
const DEFAULT_PORTS = args.includes('--default-ports');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (label, ok, detail = '') => {
    console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${label}${detail ? ` -- ${detail}` : ''}`);
    if (!ok) failures++;
    return ok;
};

async function until(describe, fn, timeoutMs = 90000, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${describe}`);
        await sleep(intervalMs);
    }
}

function executableOf(file) {
    if (!file.endsWith('.app')) return path.resolve(file);
    const dir = path.join(file, 'Contents', 'MacOS');
    return path.resolve(dir, fs.readdirSync(dir)[0]);
}
const executable = executableOf(target);

class App {
    /** @param {{args?: string[], settings?: object, env?: object, discoveryPort?: number, config?: object}} options `settings` is the app's saved state (none means a first run); `config` is the server's config.json. */
    constructor(name, { args: extraArgs = [], settings = null, env = {}, discoveryPort = DISCOVERY_PORT, config = { port: PORT, discoveryPort } } = {}) {
        this.dir = fs.mkdtempSync(path.join(process.env.WIIJUKEBOX_SMOKE_DIR || os.tmpdir(), `wiijukebox-smoke-${name}-`));
        this.config = path.join(this.dir, 'config');
        this.configFile = path.join(this.config, 'wiijukebox', 'config.json');
        this.userData = path.join(this.dir, 'userdata');
        this.stateFile = path.join(this.dir, 'state.json');
        this.output = [];
        this.extraArgs = extraArgs;
        this.extraEnv = env;
        fs.mkdirSync(path.join(this.config, 'wiijukebox'), { recursive: true });
        fs.mkdirSync(this.userData, { recursive: true });
        fs.writeFileSync(this.configFile, JSON.stringify(config));
        if (settings) fs.writeFileSync(path.join(this.userData, 'settings.json'), JSON.stringify(settings));
    }

    get env() {
        return {
            ...process.env,
            XDG_CONFIG_HOME: this.config,
            WIIJUKEBOX_USER_DATA: this.userData,
            WIIJUKEBOX_STATE_FILE: this.stateFile,
            WIIJUKEBOX_HIDDEN: '1',
            // An AppImage can then run without FUSE.
            APPIMAGE_EXTRACT_AND_RUN: '1',
            ...this.extraEnv,
        };
    }

    command(extra = [], { quitting = false } = {}) {
        // SMOKE_SANDBOX=1 runs with Chromium's sandbox, as an installed package does.
        const flags = process.platform === 'linux' && !process.env.SMOKE_SANDBOX ? ['--no-sandbox'] : [];
        // The running copy holds the inspector port, and Node would refuse to start a second one on it.
        const own = quitting ? this.extraArgs.filter((arg) => !arg.startsWith('--inspect')) : this.extraArgs;
        const all = [...flags, ...own, ...extra];
        return ARCH ? ['arch', [`-${ARCH}`, executable, ...all]] : [executable, all];
    }

    start() {
        const [file, fileArgs] = this.command();
        this.child = spawn(file, fileArgs, { env: this.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        this.exited = new Promise((resolve) => this.child.once('exit', (code, signal) => resolve({ code, signal })));
        for (const stream of [this.child.stdout, this.child.stderr]) {
            stream.on('data', (chunk) => {
                this.output.push(...String(chunk).split('\n').filter(Boolean));
                this.output = this.output.slice(-60);
            });
        }
    }

    state() {
        try {
            return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        } catch {
            return null;
        }
    }

    // Waits until the state file satisfies `test`, failing early if the app died.
    async waitState(describe, test, timeoutMs) {
        return until(describe, async () => {
            if (this.child.exitCode !== null) throw new Error(`the app exited early (${this.child.exitCode}) while waiting for ${describe}`);
            const state = this.state();
            return state && test(state) ? state : null;
        }, timeoutMs);
    }

    // The same program started again asks the running one to quit, as scripts and installers do.
    async quit() {
        const [file, fileArgs] = this.command(['--quit'], { quitting: true });
        const second = spawn(file, fileArgs, { env: this.env, stdio: 'ignore', windowsHide: true });
        const secondExit = new Promise((resolve) => second.once('exit', resolve));
        const result = await Promise.race([this.exited, sleep(30000).then(() => null)]);
        await Promise.race([secondExit, sleep(5000)]);
        return result;
    }

    // An AppImage's launcher starts the real app as a child, so stop that one too (its pid is in the state file).
    kill() {
        const pids = new Set([this.child?.pid, this.state()?.pid].filter(Boolean));
        for (const pid of pids) {
            try {
                if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
                else process.kill(pid, 'SIGKILL');
            } catch {
                // Already gone.
            }
        }
    }

    dump() {
        console.log(`--- last output of ${path.basename(this.dir)} ---\n${this.output.join('\n')}\n---`);
        for (const log of [path.join(this.userData, 'logs', 'server.log')]) {
            if (fs.existsSync(log)) console.log(`--- server.log ---\n${fs.readFileSync(log, 'utf8').split('\n').slice(-40).join('\n')}\n---`);
        }
    }
}

function get(url, { maxBytes = 0, timeoutMs = 20000 } = {}) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
                chunks.push(chunk);
                size += chunk.length;
                // A live stream never ends, so read only as much as asked for.
                if (maxBytes && size >= maxBytes) {
                    request.destroy();
                    resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
                }
            });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        request.setTimeout(timeoutMs, () => request.destroy(new Error(`timeout fetching ${url}`)));
        request.on('error', (err) => { if (!request.destroyed || err.message.includes('timeout')) reject(err); });
    });
}

const run = (file, fileArgs, timeout = 30000) => new Promise((resolve) => {
    execFile(file, fileArgs, { timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
});

function probeDiscovery(port) {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        const done = (reply) => { clearTimeout(timer); socket.close(); resolve(reply); };
        const timer = setTimeout(() => done(null), 3000);
        socket.on('message', (message) => done(message.toString()));
        socket.on('error', () => done(null));
        socket.send('WIIJUKEBOX_DISCOVER\t1\t0123456789abcdef\n', port, '127.0.0.1');
    });
}

const portOpen = (port) => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
});

// Minimal Chrome DevTools client: just enough to read and click the app's own pages, or (type 'node') to reach its main process.
async function devtoolsClient({ port = DEBUG_PORT, type = 'page', urlPart = 'app.html' } = {}) {
    const target = await until(`the ${type} target ${urlPart}`, async () => {
        const res = await get(`http://127.0.0.1:${port}/json/list`).catch(() => null);
        return res && JSON.parse(res.body).find((page) => page.type === type && page.url.includes(urlPart));
    }, 60000);
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('devtools connection failed')); });
    const pending = new Map();
    let id = 0;
    socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
    };
    return {
        evaluate: (expression) => new Promise((resolve, reject) => {
            const call = ++id;
            pending.set(call, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result.result.value)));
            socket.send(JSON.stringify({ id: call, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
        }),
        close: () => socket.close(),
    };
}

const pageClient = (urlPart = 'app.html') => devtoolsClient({ urlPart });

// Presses an application menu item through the main-process inspector, as a click on the real menu would.
// The inspector is closed again at once: with a debugger still attached the app waits for it before quitting.
async function clickMenuItem(id) {
    const main = await devtoolsClient({ port: INSPECT_PORT, type: 'node', urlPart: '' });
    try {
        return await main.evaluate(`(() => { const item = process.mainModule.require('electron').Menu.getApplicationMenu().getMenuItemById(${JSON.stringify(id)}); item.click(); return item.enabled; })()`);
    } finally {
        main.close();
    }
}

async function checkReturningUser() {
    console.log('\n== returning user: server, FFmpeg and web UI ==');
    const app = new App('returning', { settings: { setupDone: true, onClose: 'background' } });
    app.start();
    try {
        const state = await app.waitState('the server to start', (s) => s.serverUrl);
        check('app started and reported its server', true, `${state.platform}-${state.arch}, version ${state.version}, ${state.serverUrl}`);
        check('server runs on the test port, not the default one', state.serverUrl === `http://127.0.0.1:${PORT}/`);
        check('the tray icon was created', state.tray === true);

        const ffmpeg = state.ffmpeg;
        const inside = ffmpeg && !path.relative(state.resources, ffmpeg.path).startsWith('..');
        check('the bundled FFmpeg is the one in use', Boolean(inside), ffmpeg ? `${ffmpeg.path} -- ${ffmpeg.version}` : 'none found');
        if (ffmpeg) {
            const encoders = await run(ffmpeg.path, ['-hide_banner', '-encoders']);
            check('bundled FFmpeg has the MP3 encoder', /libmp3lame/.test(String(encoders.stdout)));
            const license = await run(ffmpeg.path, ['-hide_banner', '-L']);
            check('bundled FFmpeg is licensed GPL (redistributable)', /GNU General Public License/i.test(String(license.stdout)) && !/nonfree/i.test(String(license.stdout) + String(license.stderr)));
            const encoded = await run(ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame', '-f', 'mp3', '-']);
            check('bundled FFmpeg encodes a tone to MP3', !encoded.err && encoded.stdout.length > 4000, `${encoded.stdout.length} bytes`);
        }

        const status = await get(`${state.serverUrl}api/status`);
        check('GET /api/status', status.status === 200 && typeof JSON.parse(status.body) === 'object', status.body.toString().slice(0, 100));
        const page = await get(state.serverUrl);
        check('GET / serves the web UI', page.status === 200 && /<title>WiiJukebox/.test(page.body.toString()));
        const vendor = await get(`${state.serverUrl}vendor/butterchurn.min.js`);
        check('GET /vendor/butterchurn.min.js (packaged public files)', vendor.status === 200 && vendor.body.length > 100000);
        const stream = await get(`${state.serverUrl}stream`, { maxBytes: 8192 });
        const head = stream.body;
        const looksLikeMp3 = head.length >= 8192 && ((head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0));
        check('GET /stream delivers MP3 from the bundled FFmpeg', stream.status === 200 && looksLikeMp3, `${head.length} bytes, ${stream.headers['content-type']}`);
        const reply = await probeDiscovery(DISCOVERY_PORT);
        check('Wii discovery answers on the test UDP port', Boolean(reply && reply.startsWith('WIIJUKEBOX\t1\t')), reply ? reply.trim().replace(/\t/g, ' ') : 'no reply');

        const exit = await app.quit();
        check('a second launch with --quit makes the app exit', Boolean(exit), exit ? `code ${exit.code}` : 'still running after 30 s');
        await sleep(500);
        check('the server and FFmpeg are gone afterwards (port freed)', !(await portOpen(PORT)));
        check('the discovery socket is closed', (await probeDiscovery(DISCOVERY_PORT)) === null);
    } catch (err) {
        check('returning-user flow', false, err.message);
        app.dump();
    } finally {
        app.kill();
    }
}

// The default config uses one number for the web port (TCP) and discovery (UDP).
async function checkSharedPort() {
    console.log('\n== web and discovery on the same port number ==');
    const app = new App('sameport', { settings: { setupDone: true, onClose: 'background' }, discoveryPort: PORT });
    app.start();
    try {
        const state = await app.waitState('the server to start', (s) => s.serverUrl);
        check('server starts with TCP and UDP on one port', state.serverUrl === `http://127.0.0.1:${PORT}/`);
        check('GET /api/status', (await get(`${state.serverUrl}api/status`)).status === 200);
        const reply = await probeDiscovery(PORT);
        check('discovery answers on the same number', Boolean(reply && reply.startsWith('WIIJUKEBOX\t1\t')), reply ? reply.trim().replace(/\t/g, ' ') : 'no reply');
        check('app quits', Boolean(await app.quit()));
    } catch (err) {
        check('shared-port flow', false, err.message);
        app.dump();
    } finally {
        app.kill();
    }
}

async function checkDefaultPorts() {
    console.log('\n== the server\'s default ports ==');
    const app = new App('defaults', { settings: { setupDone: true, onClose: 'background' }, config: {} });
    app.start();
    try {
        const state = await app.waitState('the server to start', (s) => s.serverUrl);
        const port = Number(new URL(state.serverUrl).port);
        check('the app runs the server on its default port', port === 4005, state.serverUrl);
        check('GET /api/status', (await get(`${state.serverUrl}api/status`)).status === 200);
        const reply = await probeDiscovery(port);
        check('discovery answers on that same number', Boolean(reply && reply.split('\t')[4] === String(port)), reply ? reply.trim().replace(/\t/g, ' ') : 'no reply');
        check('app quits', Boolean(await app.quit()));
    } catch (err) {
        check('default-ports flow', false, err.message);
        app.dump();
    } finally {
        app.kill();
    }
}

const isBundled = (state) => Boolean(state.ffmpeg) && !path.relative(state.resources, state.ffmpeg.path).startsWith('..');

// Reads the welcome page's options before anything is changed: both new ones are ticked, in the agreed order.
async function checkWelcomeDefaults(client) {
    const page = JSON.parse(await client.evaluate(`JSON.stringify({
        order: [...document.querySelectorAll('[data-panel=welcome] .option input')].map((input) => input.id),
        checked: Object.fromEntries([...document.querySelectorAll('[data-panel=welcome] .option input')].map((input) => [input.id, input.checked])),
        engineShown: !document.querySelector('#option-engine').hidden,
        engineText: document.querySelector('#option-engine small').textContent,
        serverText: document.querySelector('#opt-defaults').closest('.option').querySelector('small').textContent,
        fieldsShown: !document.querySelector('#welcome-server').hidden,
        labels: [...document.querySelectorAll('[data-panel=welcome] .option strong')].map((label) => label.textContent),
    })`));
    check('the options come in the order audio engine, server settings, yt-dlp, start at login',
        page.order.join(',') === 'opt-engine,opt-defaults,opt-ytdlp,opt-login', page.order.join(', '));
    check('the audio engine and server settings options are ticked and say "(recommended)"',
        page.checked['opt-engine'] && page.checked['opt-defaults'] && page.labels.slice(0, 2).every((label) => label.endsWith('(recommended)')), page.labels.slice(0, 2).join(' | '));
    check('yt-dlp is still ticked and start at login still unticked', page.checked['opt-ytdlp'] === true && page.checked['opt-login'] === false);
    check('the included audio engine is offered, with only its version number',
        page.engineShown && /^FFmpeg \d+(\.\d+)* comes with WiiJukebox\. Untick to use the FFmpeg already on this computer\.$/.test(page.engineText), page.engineText);
    check('the server settings text shows the real name and port', page.serverText === `Named WiiJukebox, on port ${PORT}. Untick to choose them yourself.`, page.serverText);
    check('the name and port fields stay hidden while the defaults are ticked', !page.fieldsShown);
}

async function checkFirstRun() {
    console.log('\n== first run: setup page drives the server ==');
    const app = new App('firstrun', { args: [`--remote-debugging-port=${DEBUG_PORT}`] });
    app.start();
    let client;
    try {
        const welcome = await app.waitState('the welcome page', (s) => s.page === 'welcome');
        check('first run shows the welcome page and starts no server yet', !welcome.serverUrl && !(await portOpen(PORT)));
        client = await pageClient();
        const shown = await until('the welcome panel', () => client.evaluate("document.querySelector('[data-panel=welcome]')?.hidden === false"), 30000);
        check('welcome panel is visible', shown);
        await checkWelcomeDefaults(client);
        await client.evaluate(`document.querySelector('#opt-ytdlp').checked = ${YTDLP}; document.querySelector('#opt-login').checked = ${LOGIN}; document.querySelector('#begin').click(); true`);

        const state = await app.waitState('the connect page', (s) => s.page === 'connect' && s.serverUrl);
        check('setup started the server and marked itself done', state.setupDone === true && state.serverUrl === `http://127.0.0.1:${PORT}/`);
        if (LOGIN) check('start at login was registered with the system', state.openAtLogin === true);
        if (YTDLP) {
            const ytdlp = state.ytdlp;
            const own = ytdlp && !path.relative(app.userData, ytdlp.path).startsWith('..');
            check('yt-dlp was downloaded into the app folder and runs', Boolean(own && ytdlp.version), ytdlp ? `${ytdlp.path} -- ${ytdlp.version}` : 'not found');
        }
        const saved = JSON.parse(fs.readFileSync(path.join(app.userData, 'settings.json'), 'utf8'));
        check('settings.json was saved', saved.setupDone === true);
        check('the included FFmpeg stayed on and is the one in use', saved.useBundledFfmpeg === true && state.useBundledFfmpeg === true && isBundled(state));
        const config = JSON.parse(fs.readFileSync(app.configFile, 'utf8'));
        const name = config.station?.name ?? 'WiiJukebox';
        check('the default server settings kept the configured name and port', config.port === PORT && name === 'WiiJukebox', `${name}, port ${config.port}`);
        const status = await get(`${state.serverUrl}api/status`);
        check('server answers after setup', status.status === 200);

        const address = await until('the Wii address on the connect page', async () => {
            client.close();
            client = await pageClient();
            return client.evaluate("document.querySelector('#address')?.textContent || ''").catch(() => '');
        }, 30000, 1000);
        check('connect page shows an address for the Wii', new RegExp(`^\\d+\\.\\d+\\.\\d+\\.\\d+:${PORT}$`).test(address), address);
        const problems = await client.evaluate("[...document.querySelectorAll('#status li.bad')].map((li) => li.textContent)");
        check('connect page reports no problems', problems.length === 0, problems.join(' | '));

        await client.evaluate("document.querySelector('#open-player').click(); true");
        await app.waitState('the web UI window', (s) => s.page === 'player', 30000);
        check('"Open WiiJukebox" moves the window to the web UI', true);

        const exit = await app.quit();
        check('app quits', Boolean(exit));
    } catch (err) {
        check('first-run flow', false, err.message);
        app.dump();
    } finally {
        client?.close();
        app.kill();
    }
}

// Unticking "Use default server settings" asks for a name and port; bad answers are refused on the page, good ones are written to config.json.
async function checkCustomServer() {
    console.log('\n== first run: choosing the server name and port ==');
    const app = new App('customserver', { args: [`--remote-debugging-port=${DEBUG_PORT}`], config: { discoveryPort: DISCOVERY_PORT } });
    app.start();
    let client;
    let blocker;
    const fill = (name, port) => client.evaluate(`(() => { document.querySelector('#server-name').value = ${JSON.stringify(name)}; document.querySelector('#server-port').value = ${JSON.stringify(String(port))}; return true; })()`);
    const begin = async () => {
        await client.evaluate("document.querySelector('#begin').click(); true");
        return until('the welcome page to answer', () => client.evaluate("document.querySelector('[data-panel=welcome]').hidden === false && document.querySelector('#begin').disabled === false && document.querySelector('#begin-error').hidden === false ? document.querySelector('#begin-error').textContent : ''"), 30000);
    };
    try {
        await app.waitState('the welcome page', (s) => s.page === 'welcome');
        client = await pageClient();
        await until('the welcome panel', () => client.evaluate("document.querySelector('[data-panel=welcome]')?.hidden === false"), 30000);
        await client.evaluate("document.querySelector('#opt-defaults').click(); true");
        const shown = JSON.parse(await client.evaluate("JSON.stringify({ shown: !document.querySelector('#welcome-server').hidden, name: document.querySelector('#server-name').value, port: document.querySelector('#server-port').value, max: document.querySelector('#server-name').maxLength, wii: document.querySelector('#welcome-server').textContent.includes('still finds the server by itself') })"));
        check('unticking shows the name and port fields with the current values', shown.shown && shown.name === 'WiiJukebox' && shown.port === '4005', `${shown.name}, ${shown.port}`);
        check('the name field is capped at 80 characters and the page says the Wii still finds the server', shown.max === 80 && shown.wii);

        await fill('   ', PORT);
        check('an empty name is refused', /name/i.test(await begin()));
        await fill('x'.repeat(81), PORT);
        check('a name over 80 characters is refused', /80 characters/.test(await begin()));
        await fill('Smoke Kitchen', 80);
        check('a port under 1024 is refused', /1024 to 65535/.test(await begin()));
        await fill('Smoke Kitchen', 'abc');
        check('a port that is not a number is refused', /1024 to 65535/.test(await begin()));
        blocker = net.createServer();
        await new Promise((resolve) => blocker.listen(PORT, '0.0.0.0', resolve));
        await fill('Smoke Kitchen', PORT);
        check('a port another program holds is refused', /in use/.test(await begin()));
        await new Promise((resolve) => blocker.close(resolve));
        blocker = null;
        const refused = app.state();
        check('refused answers start no server and finish no setup', !refused.serverUrl && !refused.setupDone && !(await portOpen(PORT)));

        await fill('  Smoke Kitchen  ', PORT);
        await client.evaluate("document.querySelector('#opt-ytdlp').checked = false; document.querySelector('#begin').click(); true");
        const state = await app.waitState('the connect page', (s) => s.page === 'connect' && s.serverUrl);
        check('a valid choice starts the server on the chosen port', state.serverUrl === `http://127.0.0.1:${PORT}/`, state.serverUrl);
        const config = JSON.parse(fs.readFileSync(app.configFile, 'utf8'));
        check('the trimmed name and the port are in config.json', config.station.name === 'Smoke Kitchen' && config.port === PORT, `${config.station.name}, port ${config.port}`);
        check('the discovery port is untouched', config.discoveryPort === DISCOVERY_PORT);
        const reply = (await probeDiscovery(DISCOVERY_PORT) || '').trim().split('\t');
        check('the Wii is told the chosen name and port by discovery', reply[4] === String(PORT) && reply[5] === 'Smoke%20Kitchen', reply.join(' '));
        check('app quits', Boolean(await app.quit()));
    } catch (err) {
        check('custom server flow', false, err.message);
        app.dump();
    } finally {
        client?.close();
        app.kill();
        blocker?.close();
    }
}

// The menu's "Server name and port…" opens a small window with the same fields; saving restarts the server.
async function checkServerWindow() {
    console.log('\n== menu: Server name and port ==');
    const app = new App('serverwindow', {
        args: [`--remote-debugging-port=${DEBUG_PORT}`, `--inspect=${INSPECT_PORT}`],
        settings: { setupDone: true, onClose: 'background' },
    });
    app.start();
    let client;
    try {
        await app.waitState('the server to start', (s) => s.serverUrl);
        check('the menu item is there and enabled', (await clickMenuItem('server-settings')) === true);
        client = await pageClient('mode=server');
        const fields = await until('the server window', () => client.evaluate("document.querySelector('[data-panel=server]')?.hidden === false ? JSON.stringify({ name: document.querySelector('#server-name').value, port: document.querySelector('#server-port').value }) : ''"), 30000);
        check('the window shows the current name and port', fields === JSON.stringify({ name: 'WiiJukebox', port: String(PORT) }), fields);

        const save = async (name, port) => {
            await client.evaluate(`document.querySelector('#server-name').value = ${JSON.stringify(name)}; document.querySelector('#server-port').value = ${JSON.stringify(String(port))}; document.querySelector('#save-server').click(); true`);
        };
        await save('', PORT);
        const error = await until('the refusal', () => client.evaluate("document.querySelector('#server-error').hidden ? '' : document.querySelector('#server-error').textContent"), 30000);
        check('an empty name is refused and the server keeps running', /name/i.test(error) && (await get(`http://127.0.0.1:${PORT}/api/status`)).status === 200);

        // The discovery port number is free for TCP, so the web port can move there.
        await save('  Smoke Den  ', DISCOVERY_PORT);
        const moved = await app.waitState('the server on the new port', (s) => s.page === 'player' && s.serverUrl === `http://127.0.0.1:${DISCOVERY_PORT}/`, 60000);
        check('saving restarts the server on the new port', Boolean(moved));
        const config = JSON.parse(fs.readFileSync(app.configFile, 'utf8'));
        check('the new name and port are in config.json', config.station.name === 'Smoke Den' && config.port === DISCOVERY_PORT, `${config.station.name}, port ${config.port}`);
        check('discovery stayed on its port and now announces the new name and port', await (async () => {
            const reply = (await probeDiscovery(DISCOVERY_PORT) || '').trim().split('\t');
            return config.discoveryPort === DISCOVERY_PORT && reply[4] === String(DISCOVERY_PORT) && reply[5] === 'Smoke%20Den';
        })());
        check('the old port is closed and the new one answers', !(await portOpen(PORT)) && (await get(`${moved.serverUrl}api/status`)).status === 200);
        await until('the window to close', async () => {
            const res = await get(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
            return !JSON.parse(res.body).some((page) => page.url.includes('mode=server'));
        }, 30000);
        check('the window closes once the change is saved', true);
        check('app quits', Boolean(await app.quit()));
    } catch (err) {
        check('server window flow', false, err.message);
        app.dump();
    } finally {
        client?.close();
        app.kill();
    }
}

async function checkPortInUse() {
    console.log('\n== port already in use: the app offers another one ==');
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(PORT, '0.0.0.0', resolve));
    const app = new App('portbusy', { args: [`--remote-debugging-port=${DEBUG_PORT}`], settings: { setupDone: true, onClose: 'background' } });
    app.start();
    let client;
    try {
        await app.waitState('the port-busy page', (s) => s.page === 'port-busy');
        check('a busy port shows the port-busy page instead of a crash', true);
        client = await pageClient();
        const suggested = await until('a suggested port', () => client.evaluate("document.querySelector('#new-port')?.value || ''"), 30000);
        check('another free port is suggested', Number(suggested) > 1023 && Number(suggested) !== PORT, suggested);
        await client.evaluate("document.querySelector('#use-port').click(); true");
        const state = await app.waitState('the server on the new port', (s) => s.page === 'player' && s.serverUrl);
        check('the server restarts on the chosen port', state.serverUrl === `http://127.0.0.1:${suggested}/`, state.serverUrl);
        check('the new port is saved in config.json', JSON.parse(fs.readFileSync(path.join(app.config, 'wiijukebox', 'config.json'), 'utf8')).port === Number(suggested));
        check('server answers on the new port', (await get(`${state.serverUrl}api/status`)).status === 200);
        check('app quits', Boolean(await app.quit()));
    } catch (err) {
        check('port-in-use flow', false, err.message);
        app.dump();
    } finally {
        client?.close();
        app.kill();
        blocker.close();
    }
}

async function checkMissingFfmpeg() {
    console.log('\n== FFmpeg missing: the app explains and can start without it ==');
    const missing = path.join(os.tmpdir(), 'wiijukebox-missing', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const app = new App('noffmpeg', {
        args: [`--remote-debugging-port=${DEBUG_PORT}`],
        settings: { setupDone: true, onClose: 'background' },
        env: { WIIJUKEBOX_FFMPEG: missing },
    });
    app.start();
    let client;
    try {
        const state = await app.waitState('the FFmpeg page', (s) => s.page === 'ffmpeg');
        check('a missing FFmpeg shows its page and starts no server', !state.serverUrl && !state.ffmpeg && !(await portOpen(PORT)));
        client = await pageClient();
        const command = await until('the install command', () => client.evaluate("document.querySelector('#command')?.textContent || ''"), 30000);
        check('the page names a way to install FFmpeg', command.length > 5, command.split('\n')[0]);
        const page = JSON.parse(await client.evaluate("JSON.stringify({ title: document.querySelector('#ffmpeg-title').textContent, why: document.querySelector('#ffmpeg-why').textContent, back: !document.querySelector('#use-bundled').hidden })"));
        check('with the included FFmpeg in use, the page says the app has none and offers no switch back', page.title === 'FFmpeg is needed' && /This copy of the app has none/.test(page.why) && !page.back, page.why);
        await client.evaluate("document.querySelector('#anyway').click(); true");
        const started = await app.waitState('the server after "Start without it"', (s) => s.serverUrl);
        check('"Start without it" starts the server', (await get(`${started.serverUrl}api/status`)).status === 200);
        check('app quits', Boolean(await app.quit()));
    } catch (err) {
        check('missing-FFmpeg flow', false, err.message);
        app.dump();
    } finally {
        client?.close();
        app.kill();
    }
}

// A stand-in FFmpeg that runs but lists no MP3 encoder (a shell script, so not for Windows).
function fakeFfmpegWithoutMp3(dir) {
    const file = path.join(dir, 'ffmpeg');
    fs.writeFileSync(file, '#!/bin/sh\ncase "$*" in\n  *-encoders*) echo " A....D libopus  libopus Opus (codec opus)";;\n  *) echo "ffmpeg version 7.9.9-smoke";;\nesac\n', { mode: 0o755 });
    return file;
}

// The FFmpeg page's text once the page has filled it in.
const ffmpegPage = (client) => until('the FFmpeg page text', async () => {
    try {
        const page = JSON.parse(await client.evaluate(`JSON.stringify({
            title: document.querySelector('#ffmpeg-title').textContent,
            why: document.querySelector('#ffmpeg-why').textContent,
            fix: document.querySelector('#ffmpeg-fix').textContent,
            back: !document.querySelector('#use-bundled').hidden,
        })`));
        return page.why ? page : null;
    } catch {
        return null;
    }
}, 30000);

// The included FFmpeg unticked: a missing or MP3-less FFmpeg gets a page that names the problem and the way back.
async function checkSystemFfmpegProblems() {
    console.log('\n== included FFmpeg unticked: no FFmpeg on the computer, and one without MP3 ==');
    const off = { setupDone: true, onClose: 'background', useBundledFfmpeg: false };
    const none = new App('systemnone', {
        args: [`--remote-debugging-port=${DEBUG_PORT}`],
        settings: off,
        env: { WIIJUKEBOX_FFMPEG: path.join(os.tmpdir(), 'wiijukebox-missing', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') },
    });
    none.start();
    let client;
    try {
        const state = await none.waitState('the FFmpeg page', (s) => s.page === 'ffmpeg');
        check('no FFmpeg on the computer shows the FFmpeg page and starts no server', !state.serverUrl && !state.ffmpeg && state.useBundledFfmpeg === false && !(await portOpen(PORT)));
        client = await pageClient();
        const page = await ffmpegPage(client);
        check('the page says none was found on this computer and offers the included FFmpeg',
            page.title === 'FFmpeg is needed' && /already on this computer, and none was found/.test(page.why) && page.back, page.why);
        check('app quits', Boolean(await none.quit()));
    } catch (err) {
        check('system FFmpeg missing flow', false, err.message);
        none.dump();
    } finally {
        client?.close();
        none.kill();
    }
    if (process.platform === 'win32') return;

    const lame = new App('systemnolame', { args: [`--remote-debugging-port=${DEBUG_PORT}`], settings: off });
    lame.extraEnv.WIIJUKEBOX_FFMPEG = fakeFfmpegWithoutMp3(lame.dir);
    lame.start();
    client = null;
    try {
        const state = await lame.waitState('the FFmpeg page', (s) => s.page === 'ffmpeg');
        check('an FFmpeg that cannot encode MP3 shows the FFmpeg page and starts no server', !state.serverUrl && state.ffmpeg?.mp3 === false && !(await portOpen(PORT)));
        client = await pageClient();
        const page = await ffmpegPage(client);
        check('the page says it cannot make MP3, names the FFmpeg and offers the included one',
            page.title === 'This FFmpeg cannot make MP3' && page.why.includes('7.9.9') && page.why.includes(lame.extraEnv.WIIJUKEBOX_FFMPEG) && page.back && /switching back fixes this/.test(page.fix), page.why);
        await client.evaluate("document.querySelector('#anyway').click(); true");
        const started = await lame.waitState('the server after "Start without it"', (s) => s.serverUrl);
        check('"Start without it" still starts the server', (await get(`${started.serverUrl}api/status`)).status === 200);
        check('app quits', Boolean(await lame.quit()));
    } catch (err) {
        check('system FFmpeg without MP3 flow', false, err.message);
        lame.dump();
    } finally {
        client?.close();
        lame.kill();
    }
}

// With the included FFmpeg off and no override, whatever this computer has is used (or the page appears); the way back to the included one then works.
async function checkSystemFfmpeg() {
    console.log('\n== included FFmpeg unticked: this computer\'s own FFmpeg, then back ==');
    const app = new App('systemffmpeg', {
        args: [`--remote-debugging-port=${DEBUG_PORT}`, `--inspect=${INSPECT_PORT}`],
        settings: { setupDone: true, onClose: 'background', useBundledFfmpeg: false },
    });
    app.start();
    let client;
    try {
        const state = await app.waitState('the server or the FFmpeg page', (s) => s.serverUrl || s.page === 'ffmpeg');
        check('the setting is read: the included FFmpeg is off', state.useBundledFfmpeg === false);
        if (state.serverUrl) {
            check('the computer\'s own FFmpeg runs the server, with MP3', !isBundled(state) && state.ffmpeg.mp3 === true, `${state.ffmpeg.path} -- ${state.ffmpeg.version}`);
            await clickMenuItem('bundled-ffmpeg');
        } else {
            console.log(`  (this computer's FFmpeg cannot be used: ${state.ffmpeg ? 'no MP3 encoder' : 'none found'})`);
            client = await pageClient();
            const page = await ffmpegPage(client);
            check('the FFmpeg page names the problem and offers the included FFmpeg', page.back && (state.ffmpeg ? /cannot make MP3/.test(page.title) : /none was found/.test(page.why)), page.title);
            await client.evaluate("document.querySelector('#use-bundled').click(); true");
        }
        const back = await app.waitState('the server on the included FFmpeg', (s) => s.serverUrl && s.useBundledFfmpeg === true && isBundled(s), 60000);
        check('switching back restarts the server on the included FFmpeg', Boolean(back), back.ffmpeg.path);
        check('the choice is saved', JSON.parse(fs.readFileSync(path.join(app.userData, 'settings.json'), 'utf8')).useBundledFfmpeg === true);
        const stream = await get(`${back.serverUrl}stream`, { maxBytes: 8192 });
        check('GET /stream delivers MP3 again', stream.status === 200 && stream.body.length >= 8192);
        check('app quits', Boolean(await app.quit()));
    } catch (err) {
        check('system FFmpeg flow', false, err.message);
        app.dump();
    } finally {
        client?.close();
        app.kill();
    }
}

async function main() {
    console.log(`smoke test of ${executable}${ARCH ? ` as ${ARCH}` : ''} on ${process.platform}-${process.arch}`);
    for (const port of [PORT, DEBUG_PORT, INSPECT_PORT]) {
        if (await portOpen(port)) throw new Error(`port ${port} is already in use; pick another with --port`);
    }
    await checkReturningUser();
    await checkSharedPort();
    if (DEFAULT_PORTS) await checkDefaultPorts();
    await checkFirstRun();
    await checkCustomServer();
    await checkServerWindow();
    await checkPortInUse();
    await checkMissingFfmpeg();
    await checkSystemFfmpegProblems();
    await checkSystemFfmpeg();
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
