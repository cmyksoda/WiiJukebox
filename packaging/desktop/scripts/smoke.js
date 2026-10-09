// SPDX-License-Identifier: GPL-3.0-only
// End-to-end check of a packaged app, run hidden. Ports: <port> web, <port>+1 discovery, <port>+10 debugging,
// <port>+11 for the main-process inspector (the Server name and port window is opened through it).
// Usage: node scripts/smoke.js <app executable or .app> [--port 4680] [--arch x86_64] [--login]
// --login also ticks "start at login", which changes the system's login items; remove them afterwards.
// --ytdlp also ticks the yt-dlp download, which needs the network.
// --default-ports also runs the app with the server's own default ports; do not use it next to a real server.
// --only titlebar runs just the title bar checks, and --only live just the ones in a window that renders.

const { spawn, execFile, execFileSync } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { startFakeSubsonic } = require('./fake-subsonic');

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
const ONLY_TITLEBAR = option('--only', null) === 'titlebar';
const ONLY_LIVE = option('--only', null) === 'live';

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
    /** @param {{args?: string[], settings?: object, env?: object, discoveryPort?: number, config?: object}} options `settings` is the app's saved state (none means a first run); `config` is the server's config.json; a null in `env` removes that variable. */
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
        const env = {
            ...process.env,
            XDG_CONFIG_HOME: this.config,
            WIIJUKEBOX_USER_DATA: this.userData,
            WIIJUKEBOX_STATE_FILE: this.stateFile,
            WIIJUKEBOX_HIDDEN: '1',
            // An AppImage can then run without FUSE.
            APPIMAGE_EXTRACT_AND_RUN: '1',
            ...this.extraEnv,
        };
        // A null in `env` removes the variable.
        for (const [name, value] of Object.entries(env)) if (value === null) delete env[name];
        return env;
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
    const send = (method, params) => new Promise((resolve, reject) => {
        const call = ++id;
        const timer = setTimeout(() => reject(new Error(`${method} got no answer`)), 60000);
        pending.set(call, (message) => {
            clearTimeout(timer);
            if (message.error) reject(new Error(message.error.message));
            else resolve(message.result);
        });
        socket.send(JSON.stringify({ id: call, method, params }));
    });
    return {
        send,
        // `userGesture` lets the page do what only a click or key press may, such as going fullscreen.
        evaluate: async (expression, { userGesture = false } = {}) => {
            const answer = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture });
            if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description || answer.exceptionDetails.text);
            return answer.result.value;
        },
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

// Runs code in the app's main process through the inspector. The connection is closed at once: with a
// debugger still attached the app waits for it before quitting.
async function inMain(expression) {
    const main = await devtoolsClient({ port: INSPECT_PORT, type: 'node', urlPart: '' });
    try {
        return await main.evaluate(`(async () => { const electron = process.mainModule.require('electron'); ${expression} })()`);
    } finally {
        main.close();
    }
}

// The main window's views, from the page and the bar's point of view, and whether the window is fullscreen.
const windowViews = async () => JSON.parse(await inMain(`
    const windows = electron.BaseWindow.getAllWindows();
    const window = windows[0];
    return JSON.stringify({
        windows: windows.length,
        title: window.getTitle(),
        fullscreen: window.isFullScreen(),
        root: window.contentView.getBounds(),
        views: window.contentView.children.map((view) => ({ url: view.webContents.getURL(), visible: view.getVisible(), bounds: view.getBounds() })),
    });`));
const viewOf = (layout, kind) => layout.views.find((view) => (kind === 'bar' ? view.url.endsWith('titlebar.html') : view.url.startsWith('http')));

const press = (client, key, vk) => Promise.all(['rawKeyDown', 'keyUp'].map((type) => client.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: vk })));

const barMenuShown = (bar) => bar.evaluate("!document.querySelector('#menu-scrim').hidden");

// Opens the ≡ menu and clicks down a path of entries (a submenu's parent, then its entry), as a user would.
async function chooseFromBarMenu(bar, labels) {
    await bar.evaluate("document.querySelector('#menu').click(); true");
    await until('the menu', () => barMenuShown(bar), 5000);
    for (const label of labels) {
        await bar.evaluate(`(() => { const row = [...document.querySelectorAll('.item')].find((n) => n.querySelector('.label').textContent === ${JSON.stringify(label)}); row.focus(); row.click(); })(); true`);
        await sleep(150);
    }
}

// The bar's own ≡ menu: it grows the bar's view over the window, is drawn in the bar, answers keys and clicks, and runs
// entries by id only, from the bar and nowhere else.
async function checkBarMenu(app, bar, page) {
    const BAR = 34;
    const visible = () => bar.evaluate("!document.querySelector('#menu-scrim').hidden");
    const closed = (what) => until(what, async () => !(await visible()) && (await windowViews()).views.find((v) => v.url.endsWith('titlebar.html')).bounds.height === BAR, 5000).then(() => true, () => false);
    const opened = () => until('the menu', visible, 5000).then(() => true, () => false);
    const key = (name) => bar.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true })); true`);
    const focused = () => bar.evaluate("document.activeElement.querySelector?.('.label')?.textContent ?? document.activeElement.id");
    const mouse = (type, x, y) => bar.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    const settingsFile = path.join(app.userData, 'settings.json');
    // The app rewrites the file in place, so a read can land halfway through; that just means "not yet".
    const savedMode = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')).onClose; } catch { return null; } };

    await bar.evaluate("document.querySelector('#menu').click(); true");
    check('the menu button opens the menu', await opened());
    let layout = await windowViews();
    const barView = viewOf(layout, 'bar');
    check('the bar\'s view grows over the whole window for it, with the page left where it was',
        barView.visible && JSON.stringify(barView.bounds) === JSON.stringify({ x: 0, y: 0, width: layout.root.width, height: layout.root.height })
        && viewOf(layout, 'page').bounds.y === BAR && layout.views.at(-1) === barView, JSON.stringify(barView.bounds));
    const menu = JSON.parse(await bar.evaluate(`JSON.stringify({
        labels: [...document.querySelectorAll('#menu-root > .item .label')].map((n) => n.textContent),
        separators: document.querySelectorAll('#menu-root > .separator').length,
        heights: [...document.querySelectorAll('#menu-root .item')].map((n) => n.getBoundingClientRect().height),
        sizes: [...document.querySelectorAll('#menu-root .item')].map((n) => getComputedStyle(n).fontSize),
        box: document.querySelector('#menu-root').getBoundingClientRect(),
        checks: Object.fromEntries([...document.querySelectorAll('#menu-root > .item[aria-checked]')].map((n) => [n.querySelector('.label').textContent, n.getAttribute('aria-checked')])),
        quit: [...document.querySelectorAll('#menu-root > .item')].find((n) => n.querySelector('.label').textContent === 'Quit')?.querySelector('.hint').textContent,
        drag: getComputedStyle(document.querySelector('#bar')).webkitAppRegion,
        expanded: document.querySelector('#menu').getAttribute('aria-expanded'),
        firstFocused: document.activeElement.querySelector?.('.label')?.textContent,
    })`));
    check('it lists the same entries as the tray menu, then View and Quit', ['Connect your Wii…', 'Copy Wii address', 'Copy stream address', 'Open in browser', 'Restart server', 'Server name and port…',
        'Install or update yt-dlp…', 'Start at login', 'Keep playing when the window is closed', 'Use system title bar', 'Theme', 'Sidebar settings…', 'Show settings folder', 'Show server log', 'View', 'Quit']
        .every((label) => menu.labels.includes(label)) && menu.labels.at(-1) === 'Quit' && menu.labels.at(-2) === 'View', menu.labels.join(' | '));
    check('with separators between the groups', menu.separators >= 4);
    check('its rows are 28px high with 13px text, and the menu sits on whole pixels',
        menu.heights.every((h) => h === 28) && menu.sizes.every((size) => size === '13px') && Object.values(menu.box).every(Number.isInteger), JSON.stringify([menu.heights[0], menu.sizes[0], menu.box]));
    check('the check marks show what is on', menu.checks['Keep playing when the window is closed'] === 'true' && menu.checks['Use system title bar'] === 'false', JSON.stringify(menu.checks));
    check('Quit shows its keyboard shortcut on Linux and Windows', process.platform === 'darwin' || menu.quit === (process.platform === 'win32' ? '' : 'Ctrl+Q'), menu.quit);
    check('the bar stops dragging the window while the menu is up, so a click beside it reaches the menu', menu.drag === 'no-drag' && menu.expanded === 'true');
    check('opened by the keyboard-style click, the first entry has focus', menu.firstFocused === 'Connect your Wii…', menu.firstFocused);

    await key('ArrowDown');
    check('Down moves to the next entry', await focused() === 'Copy Wii address');
    await key('ArrowUp');
    await key('ArrowUp');
    check('Up from the first wraps to the last', await focused() === 'Quit');
    await key('Home');
    check('Home goes to the first', await focused() === 'Connect your Wii…');
    await key('End');
    await key('ArrowUp');
    check('End goes to the last and Up from it to View', await focused() === 'View');
    await key('ArrowRight');
    const viewSub = JSON.parse(await bar.evaluate(`JSON.stringify({ shown: !document.querySelector('#menu-sub').hidden, labels: [...document.querySelectorAll('#menu-sub .label')].map((n) => n.textContent),
        hints: [...document.querySelectorAll('#menu-sub .hint')].map((n) => n.textContent), focus: document.activeElement.querySelector('.label').textContent,
        inside: (() => { const r = document.querySelector('#menu-sub').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })() })`));
    check('Right opens the View submenu with its five entries and shortcuts, inside the window',
        viewSub.shown && viewSub.labels.join() === 'Reload,Actual Size,Zoom In,Zoom Out,Toggle Full Screen' && viewSub.hints.every(Boolean) && viewSub.inside, JSON.stringify(viewSub));
    check('and focus moves into it', viewSub.focus === 'Reload');
    await key('ArrowLeft');
    check('Left closes the submenu and returns to View', await focused() === 'View' && await bar.evaluate("document.querySelector('#menu-sub').hidden"));
    for (let i = 0; i < 4; i++) await key('ArrowUp');
    check('Up skips the separators', await focused() === 'Theme');
    await key('Enter');
    const themeSub = JSON.parse(await bar.evaluate(`JSON.stringify({ labels: [...document.querySelectorAll('#menu-sub .label')].map((n) => n.textContent),
        checks: [...document.querySelectorAll('#menu-sub .item')].map((n) => n.getAttribute('aria-checked')) })`));
    check('Enter on Theme opens System, Light and Dark with a check on System', themeSub.labels.join() === 'System,Light,Dark' && themeSub.checks.join() === 'true,false,false', JSON.stringify(themeSub));
    await key('Escape');
    check('Escape closes the submenu first', await visible() && await bar.evaluate("document.querySelector('#menu-sub').hidden"));
    await key('Escape');
    check('and then the menu, giving the bar its size back', await closed('the menu to close'));

    // A press beside the menu closes it, and nothing it covered was pressed.
    await bar.evaluate("document.querySelector('#menu').click(); true");
    await opened();
    await mouse('mousePressed', 300, 400);
    await mouse('mouseReleased', 300, 400);
    check('a click outside the menu closes it', await closed('the menu to close'));
    await bar.evaluate("document.querySelector('#menu').click(); true");
    await opened();
    await bar.evaluate("document.querySelector('#menu').click(); true");
    check('the menu button closes it again', await closed('the menu to close'));

    // Only the bar may use the menu, and it can only name entries main listed.
    await bar.evaluate("document.querySelector('#menu').click(); true");
    await opened();
    const outcome = JSON.parse(await inMain(`
        const window = electron.BaseWindow.getAllWindows()[0];
        const [pageView, barView] = window.contentView.children;
        const ipc = electron.ipcMain;
        const bounds = () => barView.getBounds().height;
        const before = bounds();
        ipc.emit('titlebar:menu-close', { sender: pageView.webContents });
        ipc.emit('titlebar:menu-activate', { sender: pageView.webContents }, 'theme-dark');
        const afterPage = bounds();
        ipc.emit('titlebar:menu-activate', { sender: barView.webContents }, 'nothing-like-that');
        ipc.emit('titlebar:menu-activate', { sender: barView.webContents }, { toString: () => '0' });
        return JSON.stringify({ before, afterPage, afterJunk: bounds() });`));
    check('the page cannot close the menu or run an entry, and an unknown id does nothing', outcome.before > BAR && outcome.afterPage === outcome.before, JSON.stringify(outcome));
    check('though a junk id from the bar still closes it, as a click would', await closed('the menu to close'));
    check('and nothing was changed by it', savedMode() === 'background' && await page.evaluate("document.documentElement.dataset.theme === undefined"));

    // Choosing entries: a checkbox, and a theme in the submenu.
    const choose = (labels) => chooseFromBarMenu(bar, labels);
    await choose(['Keep playing when the window is closed']);
    check('choosing a checkbox runs it and closes the menu', await closed('the menu to close') && await until('the setting', () => savedMode() === 'quit', 5000).then(() => true, () => false));
    await choose(['Keep playing when the window is closed']);
    check('and again puts it back', await until('the setting', () => savedMode() === 'background', 5000).then(() => true, () => false));
    await choose(['Theme', 'Dark']);
    check('Theme, Dark darkens the web UI, and it is stored there like a click on its own control',
        await until('the dark page', () => page.evaluate("document.documentElement.dataset.theme === 'dark' && localStorage.getItem('wiijukebox.theme') === 'dark'"), 8000).then(() => true, () => false));
    check('the bar follows it', await until('the dark bar', () => bar.evaluate("document.documentElement.dataset.theme === 'dark'"), 8000).then(() => true, () => false));
    check('and the menu now ticks Dark', JSON.parse(await inMain("const m = electron.Menu.getApplicationMenu(); return JSON.stringify(['system', 'light', 'dark'].map((id) => m.getMenuItemById('theme-' + id).checked));")).join() === 'false,false,true');
    check('the app\'s state file says so', app.state().theme === 'dark');
    // The page's own control moves everything the other way, with nothing told to the app.
    await page.evaluate("document.querySelector('[data-theme-choice=\"light\"]').click(); true");
    check('a choice made in the web UI reaches the bar by the slow poll, even where nothing renders to report its tag',
        await until('the light bar', () => bar.evaluate("document.documentElement.dataset.theme === 'light'"), 8000).then(() => true, () => false));
    check('and ticks Light in the menu', await until('the tick', async () => JSON.parse(await inMain("return JSON.stringify(electron.Menu.getApplicationMenu().getMenuItemById('theme-light').checked)")), 8000).then(() => true, () => false));
    await choose(['Theme', 'System']);
    // Sidebar settings… presses the page's own control, which opens its sheet.
    await choose(['Sidebar settings…']);
    const sheetOpen = () => page.evaluate("!!document.querySelector('dialog.sheet[open]')");
    check('Sidebar settings… closes the menu and opens the web UI\'s own sheet', await closed('the menu to close') && await until('the sheet', sheetOpen, 8000).then(() => true, () => false));
    await page.evaluate("document.querySelector('dialog.sheet').close(); true");
    await clickMenuItem('sidebar-settings');
    check('and so does the same entry in the application menu', await until('the sheet', sheetOpen, 8000).then(() => true, () => false));
    await page.evaluate("document.querySelector('dialog.sheet').close(); true");
    check('System hands the colors back to the system: the page clears its choice and the bar looks as the system does', await until('system', async () => {
        const systemDark = await page.evaluate("matchMedia('(prefers-color-scheme: dark)').matches");
        const barTheme = await bar.evaluate('document.documentElement.dataset.theme');
        return await page.evaluate("document.documentElement.dataset.theme === undefined && localStorage.getItem('wiijukebox.theme') === null")
            && (barTheme === undefined || barTheme === (systemDark ? 'dark' : 'light'));
    }, 8000).then(() => true, () => false));
}

// The page's theme-color tag changes with its look, and the app passes that to the bar at once instead of on a poll:
// both are timed on the shared clock, from the page switching to the bar switching.
async function checkThemeSync(app, bar, page) {
    const watch = (client, theme) => client.evaluate(`window.__switched = new Promise((resolve) => {
        const root = document.documentElement;
        const seen = () => { if (root.dataset.theme === ${JSON.stringify(theme)}) { observer.disconnect(); resolve(Date.now()); } };
        const observer = new MutationObserver(seen);
        observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
        seen();
    }); true`);
    const switched = (client) => Promise.race([client.evaluate('window.__switched'), sleep(5000).then(() => null)]);
    // `trigger` starts a change to `theme`; the answer is how long after the page switched the bar did (negative: before it).
    const lag = async (theme, trigger) => {
        await Promise.all([watch(page, theme), watch(bar, theme)]);
        await trigger();
        const [atPage, atBar] = await Promise.all([switched(page), switched(bar)]);
        return atPage === null || atBar === null ? Infinity : atBar - atPage;
    };
    const pressPage = (theme) => () => page.evaluate(`document.querySelector('[data-theme-choice="${theme}"]').click(); true`);

    await pressPage('light')();
    await until('the light bar', () => bar.evaluate("document.documentElement.dataset.theme === 'light'"), 8000);
    const fromPage = [];
    for (const theme of ['dark', 'light', 'dark', 'light', 'dark', 'light']) fromPage.push(await lag(theme, pressPage(theme)));
    const median = [...fromPage].sort((a, b) => a - b)[Math.floor(fromPage.length / 2)];
    check('a theme chosen in the web UI reaches the bar within 100 ms of the page, both ways', median <= 100 && Math.max(...fromPage) <= 250, fromPage.join(', ') + ' ms');
    const fromMenu = [];
    for (const theme of ['Dark', 'Light', 'Dark', 'Light']) fromMenu.push(await lag(theme.toLowerCase(), () => chooseFromBarMenu(bar, ['Theme', theme])));
    check('and so does one chosen in the ≡ menu, which switches the bar without waiting for the page', Math.max(...fromMenu.map(Math.abs)) <= 150, fromMenu.join(', ') + ' ms');
    check('the bar and the page agree, and the state file and the menu tick say the same', await bar.evaluate('document.documentElement.dataset.theme') === await page.evaluate('document.documentElement.dataset.theme')
        && await until('the state', () => app.state().theme === 'light', 3000).then(() => true, () => false)
        && JSON.parse(await inMain("return JSON.stringify(electron.Menu.getApplicationMenu().getMenuItemById('theme-light').checked)")) === true);
}

async function checkTitleBar() {
    console.log('\n== title bar: its view, the playback title, the window buttons and fullscreen ==');
    const app = new App('titlebar', {
        args: [`--remote-debugging-port=${DEBUG_PORT}`, `--inspect=${INSPECT_PORT}`],
        settings: { setupDone: true, onClose: 'background' },
    });
    app.start();
    let bar;
    let page;
    let fixture;
    try {
        const state = await app.waitState('the web UI', (s) => s.page === 'player' && s.serverUrl);
        check('the custom title bar is the default, and the title starts as the plain name', state.systemTitleBar === false && state.windowTitle === 'WiiJukebox');
        let layout = await until('the web UI to load into the window', async () => {
            const current = await windowViews();
            return viewOf(current, 'page') && viewOf(current, 'bar') && current;
        }, 30000);
        const barView = viewOf(layout, 'bar');
        const pageView = viewOf(layout, 'page');
        check('the window holds the web UI under a bar view', layout.windows === 1 && Boolean(barView) && Boolean(pageView), layout.views.map((view) => view.url.slice(-20)).join(', '));
        check('the bar sits on top, 34 px high and as wide as the window, with the page filling the rest',
            barView.visible && JSON.stringify(barView.bounds) === JSON.stringify({ x: 0, y: 0, width: layout.root.width, height: 34 })
            && JSON.stringify(pageView.bounds) === JSON.stringify({ x: 0, y: 34, width: layout.root.width, height: layout.root.height - 34 }), JSON.stringify([barView.bounds, pageView.bounds]));

        bar = await pageClient('titlebar.html');
        page = await devtoolsClient({ urlPart: state.serverUrl });
        // The window is never shown, so without this the page would not count as focused and get no key presses.
        await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        const parts = JSON.parse(await bar.evaluate(`JSON.stringify({
            buttons: [...document.querySelectorAll('.controls button')].map((button) => button.id),
            now: document.querySelector('#title .now').textContent, brand: document.querySelector('#title .brand').textContent,
            separatorShown: getComputedStyle(document.querySelector('#title .sep')).display !== 'none',
            hasSetupBridge: typeof window.desktop !== 'undefined', hasBar: typeof window.titlebar !== 'undefined',
            region: getComputedStyle(document.querySelector('#bar')).webkitAppRegion,
            controlsRegion: getComputedStyle(document.querySelector('.controls')).webkitAppRegion,
        })`));
        check('the bar has a menu, minimize, maximize and close button, and drags the window around them',
            parts.buttons.join() === 'menu,minimize,maximize,close' && parts.region === 'drag' && parts.controlsRegion === 'no-drag', parts.buttons.join());
        const mark = JSON.parse(await bar.evaluate("JSON.stringify(document.querySelector('.mark').getBoundingClientRect())"));
        check('the jukebox mark is 15x22 on whole pixels, 3px under the top of the bar', mark.width === 15 && mark.height === 22 && mark.x === 12 && mark.y === 3, JSON.stringify(mark));
        check('the bar shows just the app name until something plays', parts.now === '' && parts.brand === 'WiiJukebox' && !parts.separatorShown, JSON.stringify([parts.now, parts.brand]));
        check('the bar page gets its own bridge and none of the setup channels', parts.hasBar && !parts.hasSetupBridge);
        check('the web UI gets no bridge to the window at all', await page.evaluate("typeof window.titlebar === 'undefined' && typeof window.desktop === 'undefined'") === true);

        // Something to play: a stand-in Subsonic server with a five-track album.
        fixture = await startFakeSubsonic(state.ffmpeg.path);
        const api = (action, body) => fetch(`${state.serverUrl}api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((res) => res.json());
        await api('sources/subsonic/config', { url: fixture.url, username: 'smoke', password: 'smoke' });
        await api('sources/subsonic/play', { id: 'album/living-room', type: 'album' });
        const titled = (text) => app.waitState(`the title ${text}`, (s) => s.windowTitle === text, 20000);
        await titled('(1 / 5) Rain on the Roof — Wii Quartet — WiiJukebox');
        check('playing an album shows "(n / total) Song — Artist — WiiJukebox" as the window title', (await windowViews()).title === '(1 / 5) Rain on the Roof — Wii Quartet — WiiJukebox');
        check('the bar shows the same, with the song cut short before the app name',
            await until('the bar title', async () => (await bar.evaluate("document.querySelector('#title .now').textContent")) === '(1 / 5) Rain on the Roof — Wii Quartet', 10000).then(() => true, () => false));
        await api('control/pause');
        await titled('(Paused) (1 / 5) Rain on the Roof — Wii Quartet — WiiJukebox');
        check('pausing adds "(Paused)"', true);
        await api('control/play');
        await api('control/next');
        await titled('(2 / 5) Channel Surfing — Wii Quartet — WiiJukebox');
        check('the next track moves the count on', true);
        await api('control/stop');
        await titled('WiiJukebox');
        check('stopping brings the plain name back', (await windowViews()).title === 'WiiJukebox');
        await api('sources/subsonic/play', { id: 'album/living-room', type: 'album' });
        await titled('(1 / 5) Rain on the Roof — Wii Quartet — WiiJukebox');

        // The window is never shown here, so its maximize, minimize and hide are recorded instead of asked of
        // the desktop, with maximize answered as a window manager would.
        await inMain(`
            const window = electron.BaseWindow.getAllWindows()[0];
            globalThis.calls = [];
            let maximized = false;
            window.isMaximized = () => maximized;
            window.maximize = () => { calls.push('maximize'); maximized = true; window.emit('maximize'); };
            window.unmaximize = () => { calls.push('unmaximize'); maximized = false; window.emit('unmaximize'); };
            window.minimize = () => calls.push('minimize');
            window.hide = () => calls.push('hide');
            return true;`);
        const clicked = async (id) => {
            await bar.evaluate(`document.querySelector('#${id}').click(); true`);
            await sleep(300);
            return JSON.parse(await inMain('return JSON.stringify(globalThis.calls);'));
        };
        check('Minimize minimizes the window', (await clicked('minimize')).at(-1) === 'minimize');
        check('Maximize maximizes it, and the bar shows Restore',
            (await clicked('maximize')).at(-1) === 'maximize'
            && await until('the Restore button', () => bar.evaluate("document.querySelector('#maximize').getAttribute('aria-label') === 'Restore' && document.querySelector('#maximize .g').className === 'g g-restore'"), 5000).then(() => true, () => false));
        check('Restore puts it back, and the bar shows Maximize again',
            (await clicked('maximize')).at(-1) === 'unmaximize'
            && await until('the Maximize button', () => bar.evaluate("document.querySelector('#maximize').getAttribute('aria-label') === 'Maximize'"), 5000).then(() => true, () => false));
        await checkBarMenu(app, bar, page);
        check('Close asks what closing does: here it keeps playing in the background', (await clicked('close')).at(-1) === 'hide');
        check('the music kept going while the window was closed', (await get(`${state.serverUrl}api/status`)).status === 200);

        // Fullscreen: the bar steps aside for the web UI. The window changes size a moment after the page asks, so wait for all of it.
        const covers = (current) => JSON.stringify(viewOf(current, 'page').bounds) === JSON.stringify({ x: 0, y: 0, width: current.root.width, height: current.root.height });
        const settled = (full) => until(`the window to ${full ? 'fill the display' : 'be back to normal'}`, async () => {
            const current = await windowViews();
            const done = full
                ? current.fullscreen && !viewOf(current, 'bar').visible && covers(current)
                : !current.fullscreen && viewOf(current, 'bar').visible && viewOf(current, 'page').bounds.y === 34;
            return done && current;
        }, 20000);
        const soon = (expression) => until(expression, () => page.evaluate(expression), 10000).then(() => true, () => false);

        await page.evaluate('document.documentElement.requestFullscreen().then(() => true)', { userGesture: true });
        layout = await settled(true);
        check('a fullscreen page hides the bar and fills the whole display', true, `${layout.root.width}x${layout.root.height}`);
        await page.evaluate('document.exitFullscreen().then(() => true)');
        await settled(false);
        check('leaving fullscreen brings the bar back under it', true);

        // F11 with the visualizer up fullscreens its stage (the page is given the "viz" look without audio or WebGL).
        await page.evaluate("document.body.classList.add('viz'); true");
        await press(page, 'F11', 122);
        await settled(true);
        check('F11 with the visualizer open fullscreens the visualizer\'s own stage, with no bar over it', await soon("document.fullscreenElement?.id === 'viz-stage'"));
        check('the fullscreen button is there and now offers to leave', await soon("document.querySelector('#viz-fullscreen').getAttribute('aria-label') === 'Exit fullscreen'"));
        check('the button\'s corner glyph points inward', await soon("document.querySelector('#viz-fullscreen .g').className === 'g g-shrink'"));
        await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true");
        await sleep(300);
        check('an Escape the page sees in fullscreen does not close the visualizer', await page.evaluate("document.body.classList.contains('viz') && document.fullscreenElement?.id === 'viz-stage'") === true);
        await press(page, 'Escape', 27);
        await sleep(800);
        check('a real Escape leaves the visualizer open too', await page.evaluate("document.body.classList.contains('viz')") === true);
        // Whether the key press already left fullscreen depends on who sees it first, so go back in for the next check.
        if (!(await page.evaluate('document.fullscreenElement?.id'))) {
            await settled(false);
            await page.evaluate("document.querySelector('#viz-fullscreen').click(); true", { userGesture: true });
            await settled(true);
        }
        await page.evaluate("document.querySelector('#viz-toggle').click(); true");
        await settled(false);
        check('closing the visualizer leaves fullscreen and closes it', await page.evaluate("!document.fullscreenElement && !document.body.classList.contains('viz')") === true);

        await page.evaluate("document.body.classList.add('viz'); true");
        await page.evaluate("document.querySelector('#viz-fullscreen').click(); true", { userGesture: true });
        await settled(true);
        check('the fullscreen button does the same as F11', await soon("document.fullscreenElement?.id === 'viz-stage'"));
        await press(page, 'F11', 122);
        await settled(false);
        check('F11 again leaves fullscreen', await soon('!document.fullscreenElement'));
        await press(page, 'Escape', 27);
        check('Escape with nothing fullscreen closes the visualizer as before', await soon("!document.body.classList.contains('viz')"));
        check('app quits', Boolean(await app.quit()));
    } catch (err) {
        check('title bar flow', false, err.message);
        app.dump();
    } finally {
        bar?.close();
        page?.close();
        await fixture?.close();
        app.kill();
    }
}

// The ≡ menu's hover, with real pointer events: the lit entry follows the pointer and goes when it leaves, an open submenu
// closes a moment after the pointer rests on another entry but stays while it crosses the list on its way to the submenu.
async function checkMenuHover(bar) {
    const moveTo = (x, y) => bar.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' });
    const click = async (x, y) => {
        for (const type of ['mousePressed', 'mouseReleased']) await bar.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
    };
    const centerOf = (selector, label) => bar.evaluate(`(() => {
        const node = ${label === undefined ? `document.querySelector(${JSON.stringify(selector)})` : `[...document.querySelectorAll(${JSON.stringify(selector)})].find((n) => n.querySelector('.label').textContent === ${JSON.stringify(label)})`};
        const r = node.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    const rowCenter = (label, level = 'root') => centerOf(`#menu-${level} > .item`, label);
    const lit = async () => JSON.parse(await bar.evaluate("JSON.stringify([...document.querySelectorAll('.item.active')].map((n) => n.querySelector('.label').textContent))"));
    const subShown = () => bar.evaluate("!document.querySelector('#menu-sub').hidden");
    const subLabels = () => bar.evaluate("[...document.querySelectorAll('#menu-sub .label')].map((n) => n.textContent).join()");
    const glide = async (from, to, steps, ms) => {
        for (let i = 1; i <= steps; i++) {
            await moveTo(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
            await sleep(ms);
        }
    };
    const key = (name) => bar.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true })); true`);
    const away = { x: 300, y: 600 };

    await moveTo(away.x, away.y);
    await click(...Object.values(await centerOf('#menu')));
    await until('the menu', () => barMenuShown(bar), 5000);
    check('a menu opened with the mouse has no entry lit until the pointer or a key moves', (await lit()).length === 0);

    await glide(away, await rowCenter('Theme'), 6, 20);
    await sleep(60);
    check('the entry under the pointer is lit, and a submenu entry opens its submenu', (await lit()).join() === 'Theme' && await subShown() && await subLabels() === 'System,Light,Dark');

    // Straight down to another entry: the light follows at once, the submenu goes a moment later.
    const theme = await rowCenter('Theme');
    const other = await rowCenter('Show server log');
    await glide(theme, other, 6, 20);
    check('moving to another entry moves the light there, one entry at a time', (await lit()).join() === 'Show server log');
    check('while the submenu is still open for a moment', await subShown());
    await sleep(450);
    check('and it closes by itself once the pointer has rested elsewhere', !(await subShown()));

    // Back onto Theme, then diagonally across the entry below it to the submenu, slowly enough that a plain delay would shut it.
    await glide(other, theme, 6, 20);
    await sleep(60);
    const dark = await rowCenter('Dark', 'sub');
    await glide(await rowCenter('Theme'), dark, 12, 55);
    check('a slow diagonal across other entries to the submenu does not close it', await subShown());
    await sleep(350);
    check('and it stays open with its parent lit while the pointer is in it, lighting the entry under it', await subShown() && (await lit()).join() === 'Theme,Dark', (await lit()).join());
    await glide(dark, away, 6, 20);
    await sleep(60);
    check('leaving the menus clears what the pointer lit, but not the parent of the open submenu', (await lit()).join() === 'Theme' && await subShown());

    // The keys: they continue from the last entry, and what they chose stays when the pointer is elsewhere.
    await key('Escape');
    check('Escape closes the submenu first and lights its parent for the keys', !(await subShown()) && (await lit()).join() === 'Theme');
    await key('ArrowDown');
    await moveTo(away.x + 40, away.y + 20);
    await moveTo(away.x + 80, away.y - 30);
    check('an entry chosen by the keys stays lit while the pointer wanders outside the menu', (await lit()).join() === 'Sidebar settings…', (await lit()).join());
    await glide(away, await rowCenter('Quit'), 6, 20);
    check('and the pointer takes the light when it comes back over an entry', (await lit()).join() === 'Quit');
    await glide(await rowCenter('Quit'), away, 6, 20);
    check('leaving again clears it', (await lit()).length === 0);
    await key('Escape');
    await until('the menu to close', async () => !(await barMenuShown(bar)), 5000);
}

// A window that is never shown renders no frames, so its page never reports a changed theme-color tag and its timers run
// slowly. This one is shown on Chromium's headless platform with no display variables, so it renders and nothing reaches a screen.
async function checkLiveBar() {
    if (process.platform !== 'linux') return console.log('\n== skipped: the live title bar checks need Chromium\'s headless platform, which is Linux only ==');
    console.log('\n== title bar: the theme follows the page at once, and the menu answers the pointer ==');
    const app = new App('live', {
        args: [`--remote-debugging-port=${DEBUG_PORT}`, `--inspect=${INSPECT_PORT}`, '--ozone-platform=headless', '--disable-gpu'],
        settings: { setupDone: true, onClose: 'background' },
        env: { DISPLAY: null, WAYLAND_DISPLAY: null, WIIJUKEBOX_HIDDEN: null },
    });
    app.start();
    let bar;
    let page;
    try {
        const state = await app.waitState('the web UI', (s) => s.page === 'player' && s.serverUrl);
        await until('the web UI to load into the window', async () => viewOf(await windowViews(), 'page'), 30000);
        // The headless platform starts windows at their minimum size.
        await inMain("electron.BaseWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1280, height: 820 }); return true;");
        await until('the window to grow', async () => (await windowViews()).root.width === 1280, 10000);
        bar = await pageClient('titlebar.html');
        page = await devtoolsClient({ urlPart: state.serverUrl });
        // The page's own buttons do nothing until its script has run, which shows as the sidebar's channels.
        await until('the web UI to start', () => page.evaluate("document.querySelectorAll('#sources .source-btn').length > 0"), 30000);
        await checkThemeSync(app, bar, page);
        await checkMenuHover(bar);
        check('app quits', Boolean(await app.quit()));
    } catch (err) {
        check('live title bar flow', false, err.message);
        app.dump();
    } finally {
        bar?.close();
        page?.close();
        app.kill();
    }
}

// "Use system title bar": the menu item rebuilds the window around the same page, with no restart, and the choice is remembered.
async function checkSystemTitleBar() {
    console.log('\n== system title bar: the menu item and the saved choice ==');
    const app = new App('systembar', {
        args: [`--remote-debugging-port=${DEBUG_PORT}`, `--inspect=${INSPECT_PORT}`],
        settings: { setupDone: true, onClose: 'background' },
    });
    app.start();
    let fixture;
    try {
        const state = await app.waitState('the web UI', (s) => s.page === 'player' && s.serverUrl);
        await until('the web UI to load into the window', async () => viewOf(await windowViews(), 'page'), 30000);
        fixture = await startFakeSubsonic(state.ffmpeg.path);
        const api = (action, body) => fetch(`${state.serverUrl}api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((res) => res.json());
        await api('sources/subsonic/config', { url: fixture.url, username: 'smoke', password: 'smoke' });
        await api('sources/subsonic/play', { id: 'album/living-room', type: 'album' });
        await app.waitState('the title', (s) => s.windowTitle.startsWith('(1 / 5)'), 20000);

        const item = (id) => `electron.Menu.getApplicationMenu().getMenuItemById(${JSON.stringify(id)})`;
        check('the menu has the checkbox, unticked', JSON.parse(await inMain(`const i = ${item('system-title-bar')}; return JSON.stringify([i.type, i.checked, i.enabled]);`)).join() === 'checkbox,false,true');
        await inMain(`${item('system-title-bar')}.click(); return true;`);
        const system = await app.waitState('the system title bar', (s) => s.systemTitleBar === true && s.page === 'player', 30000);
        let layout = await windowViews();
        check('the window was rebuilt with the page alone, still showing the web UI', layout.windows === 1 && layout.views.length === 1 && layout.views[0].url === state.serverUrl, layout.views.map((view) => view.url).join(', '));
        check('the page fills the window, with no bar view', JSON.stringify(layout.views[0].bounds) === JSON.stringify({ x: 0, y: 0, width: layout.root.width, height: layout.root.height }));
        check('the choice is saved', JSON.parse(fs.readFileSync(path.join(app.userData, 'settings.json'), 'utf8')).systemTitleBar === true);
        check('the window title still follows playback with the system frame', layout.title.startsWith('(1 / 5) Rain on the Roof') && system.windowTitle === layout.title, layout.title);
        await api('control/next');
        await app.waitState('the next title', (s) => s.windowTitle.startsWith('(2 / 5)'), 20000);
        check('and keeps following it', (await windowViews()).title.startsWith('(2 / 5) Channel Surfing'));
        check('the menu item stays ticked', JSON.parse(await inMain(`return JSON.stringify(${item('system-title-bar')}.checked);`)) === true);

        await inMain(`${item('system-title-bar')}.click(); return true;`);
        await app.waitState('the custom bar again', (s) => s.systemTitleBar === false && s.page === 'player', 30000);
        layout = await until('the bar view', async () => { const current = await windowViews(); return viewOf(current, 'bar') && current; }, 30000);
        check('unticking builds the bar window again', layout.windows === 1 && layout.views.length === 2 && viewOf(layout, 'page').bounds.y === 34);
        check('app quits', Boolean(await app.quit()));
    } catch (err) {
        check('system title bar flow', false, err.message);
        app.dump();
    } finally {
        await fixture?.close();
        app.kill();
    }

    const saved = new App('systemsaved', {
        args: [`--remote-debugging-port=${DEBUG_PORT}`, `--inspect=${INSPECT_PORT}`],
        settings: { setupDone: true, onClose: 'background', systemTitleBar: true },
    });
    saved.start();
    try {
        await saved.waitState('the web UI', (s) => s.page === 'player' && s.serverUrl);
        const layout = await windowViews();
        check('a saved choice of the system title bar starts the app without the bar', saved.state().systemTitleBar === true && layout.views.length === 1);
        check('app quits', Boolean(await saved.quit()));
    } catch (err) {
        check('saved system title bar flow', false, err.message);
        saved.dump();
    } finally {
        saved.kill();
    }
}

// The close card: the first time the window is closed the app asks, from the bar's ×, Alt+F4 and the taskbar alike
// (all of which reach the same window "close"), in a small card with three equal buttons.
async function checkCloseDialog() {
    console.log('\n== close card: asking what closing does ==');
    const settingsFile = (app) => path.join(app.userData, 'settings.json');
    // The app rewrites the file in place, so a read can land halfway through; that just means "not yet".
    const saved = (app) => { try { return JSON.parse(fs.readFileSync(settingsFile(app), 'utf8')).onClose; } catch { return null; } };
    const mainWindow = "electron.BaseWindow.getAllWindows().find((w) => !w.getParentWindow())";
    const record = () => inMain(`
        const window = ${mainWindow};
        globalThis.calls = [];
        window.hide = () => calls.push('hide');
        window.minimize = () => calls.push('minimize');
        return true;`);
    const calls = async () => JSON.parse(await inMain('return JSON.stringify(globalThis.calls);'));
    const cards = async () => JSON.parse(await inMain(`return JSON.stringify(electron.BaseWindow.getAllWindows().filter((w) => w.getParentWindow()).map((w) => ({
        modal: w.isModal(), parent: w.getParentWindow() === ${mainWindow}, size: w.getContentSize() })));`));
    const cardGone = () => until('the card to close', async () => (await cards()).length === 0, 8000).then(() => true, () => false);
    const cardUp = async () => {
        await until('the card', async () => (await cards()).length === 1, 15000);
        const opened = await devtoolsClient({ urlPart: 'close.html' });
        // The page focuses its safe default as its last step, so that is when it is ready.
        await until('the card to load', () => opened.evaluate("document.activeElement?.id === 'background'").catch(() => false), 10000);
        return opened;
    };
    const press = (card, key) => card.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true })); true`);

    const app = new App('closecard', {
        args: [`--remote-debugging-port=${DEBUG_PORT}`, `--inspect=${INSPECT_PORT}`],
        settings: { setupDone: true, onClose: 'ask' },
    });
    app.start();
    let bar;
    let page;
    let card;
    try {
        const state = await app.waitState('the web UI', (s) => s.page === 'player' && s.serverUrl);
        await until('the web UI to load into the window', async () => viewOf(await windowViews(), 'page'), 30000);
        bar = await pageClient('titlebar.html');
        page = await devtoolsClient({ urlPart: state.serverUrl });
        await record();

        await bar.evaluate("document.querySelector('#close').click(); true");
        card = await cardUp();
        const look = JSON.parse(await card.evaluate(`JSON.stringify({
            title: document.querySelector('h1').textContent,
            detail: document.querySelector('#detail').textContent,
            remember: document.querySelector('#remember').checked,
            buttons: [...document.querySelectorAll('button')].map((b) => { const r = b.getBoundingClientRect(); return { text: b.textContent, x: r.x, y: r.y, width: r.width, height: r.height }; }),
            card: document.querySelector('main').getBoundingClientRect().toJSON(),
            focus: document.activeElement.id,
            font: getComputedStyle(document.querySelector('#detail')).fontSize,
        })`));
        check('the bar\'s × asks, in a card of its own that is modal over the window', (await cards()).every((c) => c.modal && c.parent), JSON.stringify(await cards()));
        check('with a bold title and one short sentence naming where it waits',
            look.title === 'Keep WiiJukebox running?' && /^Your Wii can keep listening from the (system tray|notification area|menu bar)\.$/.test(look.detail), look.detail);
        check('and three equal buttons in one row: Cancel, Quit, Keep playing',
            look.buttons.map((b) => b.text).join() === 'Cancel,Quit,Keep playing' && look.buttons.every((b) => b.width === look.buttons[0].width && b.y === look.buttons[0].y && b.height === 34), JSON.stringify(look.buttons));
        check('the card is compact (376px wide, even height) and its buttons sit on whole pixels',
            look.card.width === 376 && look.card.height % 2 === 0 && look.card.height < 220 && look.buttons.every((b) => [b.x, b.y, b.width, b.height].every(Number.isInteger)), JSON.stringify(look.card));
        check('the choice is remembered unless unticked, and the safe default has focus', look.remember === true && look.focus === 'background');
        check('the card is the size of its content', (await cards())[0].size.join() === `376,${look.card.height}`, JSON.stringify((await cards())[0].size));

        // Only the card may answer, and only with a real choice.
        await inMain(`electron.ipcMain.emit('close-dialog:answer', { sender: electron.BaseWindow.getAllWindows().find((w) => !w.getParentWindow()).contentView.children[0].webContents }, { choice: 'quit', remember: true }); return true;`);
        await sleep(300);
        check('the web UI cannot answer for it', (await cards()).length === 1 && saved(app) === 'ask');
        await inMain(`electron.ipcMain.emit('close-dialog:answer', { sender: electron.BaseWindow.getAllWindows().find((w) => w.getParentWindow()).webContents }, { choice: 'explode', remember: true }); return true;`);
        await sleep(300);
        check('and an answer that is not one of the three is ignored', (await cards()).length === 1);

        await press(card, 'ArrowLeft');
        check('arrow keys move between the buttons', await card.evaluate('document.activeElement.id') === 'quit');
        await press(card, 'ArrowRight');
        await press(card, 'Escape');
        check('Escape cancels: the card goes, nothing is remembered, and the window stays', await cardGone() && saved(app) === 'ask' && (await calls()).length === 0);
        card.close();

        // Alt+F4 and the taskbar both ask the window to close; asking while the card is up does not stack a second one.
        await inMain(`${mainWindow}.close(); return true;`);
        card = await cardUp();
        await inMain(`${mainWindow}.close(); return true;`);
        await sleep(300);
        check('closing the window from the system asks too, and never twice at once', (await cards()).length === 1);
        await card.evaluate("document.querySelector('#quit').focus(); true");
        await card.evaluate("document.querySelector('#remember').focus(); true");
        await press(card, 'Enter');
        check('Enter anywhere but on another button picks Keep playing, remembers it and hides the window',
            await cardGone() && await until('the saved choice', () => saved(app) === 'background', 5000).then(() => true, () => false) && (await calls()).at(-1) === 'hide', JSON.stringify(await calls()));
        card.close();
        await inMain(`${mainWindow}.close(); return true;`);
        await sleep(600);
        check('after that, closing just hides it, with no card', (await cards()).length === 0 && (await calls()).filter((c) => c === 'hide').length === 2);

        check('app quits', Boolean(await app.quit()));
    } catch (err) {
        check('close card flow', false, err.message);
        app.dump();
    } finally {
        card?.close();
        bar?.close();
        page?.close();
        app.kill();
    }

    // Unticked, a choice applies once; the card's own window closing is a Cancel; Quit remembers and quits.
    const second = new App('closecard2', {
        args: [`--remote-debugging-port=${DEBUG_PORT}`, `--inspect=${INSPECT_PORT}`],
        settings: { setupDone: true, onClose: 'ask' },
    });
    second.start();
    let again;
    try {
        await second.waitState('the web UI', (s) => s.page === 'player' && s.serverUrl);
        await until('the window', async () => viewOf(await windowViews(), 'page'), 30000);
        await record();
        await inMain(`${mainWindow}.close(); return true;`);
        again = await cardUp();
        await again.evaluate("document.querySelector('#remember').click(); document.querySelector('#background').click(); true");
        check('unticked, Keep playing hides the window this once', await cardGone() && (await calls()).at(-1) === 'hide');
        check('and is not remembered, so it asks again', saved(second) === 'ask');
        again.close();

        // A window closed from the taskbar is still minimized; it is brought back so the card is not asked of nothing.
        await inMain(`const window = ${mainWindow};
            window.isMinimized = () => true;
            window.restore = () => { calls.push('restore'); window.isMinimized = () => false; };
            window.close();
            return true;`);
        again = await cardUp();
        check('a minimized window is restored before the card shows', (await calls()).includes('restore'), JSON.stringify(await calls()));
        await inMain(`electron.BaseWindow.getAllWindows().find((w) => w.getParentWindow()).close(); return true;`);
        check('closing the card itself is a Cancel', await cardGone() && (await calls()).filter((c) => c === 'hide').length === 1);
        again.close();

        await inMain(`${mainWindow}.close(); return true;`);
        again = await cardUp();
        await again.evaluate("document.querySelector('#cancel').click(); true");
        check('the Cancel button leaves everything as it was', await cardGone() && saved(second) === 'ask' && (await calls()).filter((c) => c === 'hide').length === 1);
        again.close();

        await inMain(`${mainWindow}.close(); return true;`);
        again = await cardUp();
        await again.evaluate("document.querySelector('#quit').click(); true");
        const exit = await Promise.race([second.exited, sleep(30000).then(() => null)]);
        check('Quit remembers the choice and quits the app', exit !== null && saved(second) === 'quit', JSON.stringify(exit));
    } catch (err) {
        check('close card (second) flow', false, err.message);
        second.dump();
    } finally {
        again?.close();
        second.kill();
    }
}

async function main() {
    console.log(`smoke test of ${executable}${ARCH ? ` as ${ARCH}` : ''} on ${process.platform}-${process.arch}`);
    for (const port of [PORT, DEBUG_PORT, INSPECT_PORT]) {
        if (await portOpen(port)) throw new Error(`port ${port} is already in use; pick another with --port`);
    }
    if (!ONLY_TITLEBAR && !ONLY_LIVE) {
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
    }
    if (!ONLY_LIVE) await checkTitleBar();
    await checkLiveBar();
    if (!ONLY_LIVE) {
        await checkSystemTitleBar();
        await checkCloseDialog();
    }
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
