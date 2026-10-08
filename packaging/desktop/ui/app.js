// SPDX-License-Identifier: GPL-3.0-only
// Local pages of the desktop app: first-run setup, "Connect your Wii" and error screens.

const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const bridge = window.desktop;

const TRAY_NAMES = { darwin: 'menu bar', win32: 'notification area', linux: 'system tray' };
const FIRST_RUN_NOTES = {
    win32: 'Windows will ask whether WiiJukebox may use the network. Choose Allow access, with Private networks ticked, so your Wii can connect.',
    darwin: 'macOS may ask whether WiiJukebox may accept incoming network connections. Choose Allow so your Wii can connect.',
};
const FFMPEG_COMMANDS = {
    linux: 'Fedora:  sudo dnf install ffmpeg-free   (or ffmpeg from RPM Fusion)\nDebian / Ubuntu:  sudo apt install ffmpeg\nArch:  sudo pacman -S ffmpeg',
    darwin: 'brew install ffmpeg',
    win32: 'winget install Gyan.FFmpeg\n\nor, with Scoop:  scoop install ffmpeg',
};

function show(name) {
    for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
}

function element(tag, text, className) {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
}

// The name and port fields are the same on the welcome page and in the later window; only one is ever on a page.
function mountServerFields(slot, server) {
    slot.replaceChildren($('#server-fields').content.cloneNode(true));
    const fields = { name: $('#server-name'), port: $('#server-port') };
    fields.name.maxLength = server.maxNameLength;
    fields.name.value = server.name;
    fields.port.value = server.port;
    return fields;
}

const readServerFields = () => ({ name: $('#server-name').value, port: Number($('#server-port').value) });

function submitOnEnter(button) {
    for (const input of document.querySelectorAll('#server-name, #server-port')) {
        input.addEventListener('keydown', (event) => { if (event.key === 'Enter') button.click(); });
    }
}

async function fillWelcome() {
    const info = await bridge.info();
    $('#option-engine').hidden = !info.engine.bundled;
    $('#opt-engine').checked = info.engine.useBundled;
    $('#engine-version').textContent = info.engine.bundledVersion ? ` ${info.engine.bundledVersion}` : '';
    $('#default-name').textContent = info.server.name;
    $('#default-port').textContent = info.server.port;
    mountServerFields($('#welcome-server'), info.server);
    submitOnEnter($('#begin'));
    document.querySelector('.tray-name').textContent = TRAY_NAMES[info.platform] || 'tray';
    const note = FIRST_RUN_NOTES[info.platform];
    $('#welcome-note').hidden = !note;
    if (note) $('#welcome-note').textContent = note;
    show('welcome');
}

async function beginSetup() {
    $('#begin').disabled = true;
    $('#begin-error').hidden = true;
    $('#step').textContent = 'One moment.';
    // Checking the choices takes a blink; the progress page is for the part that takes longer.
    const slow = setTimeout(() => show('working'), 250);
    const result = await bridge.beginSetup({
        ytdlp: $('#opt-ytdlp').checked,
        login: $('#opt-login').checked,
        bundled: $('#option-engine').hidden ? undefined : $('#opt-engine').checked,
        server: $('#opt-defaults').checked ? null : readServerFields(),
    });
    clearTimeout(slow);
    // Success and server failures replace this page, so only a failure to save the choices lands here.
    if (result.ok) return;
    $('#begin').disabled = false;
    $('#begin-error').textContent = result.error;
    $('#begin-error').hidden = false;
    show('welcome');
}

async function fillServerWindow() {
    const info = await bridge.info();
    const fields = mountServerFields($('#server-form'), info.server);
    submitOnEnter($('#save-server'));
    show('server');
    fields.name.select();
}

async function saveServer() {
    const button = $('#save-server');
    button.disabled = true;
    $('#server-error').hidden = true;
    const result = await bridge.saveServer(readServerFields());
    // A saved change closes this window, so only a refusal comes back here.
    if (result.ok) return;
    button.disabled = false;
    $('#server-error').textContent = result.error;
    $('#server-error').hidden = false;
}

async function fillConnect(firstRun) {
    const info = await bridge.info();
    $('#address').textContent = `${info.address}:${info.port}`;
    $('#stream').textContent = info.streamUrl;

    const rows = [
        [info.serverRunning, info.serverRunning ? `WiiJukebox is running on port ${info.port}.` : 'The server is not running. Choose Restart server from the menu.'],
        [info.discovery, info.discovery
            ? `The Wii can find this computer by itself (UDP port ${info.discoveryPort}).`
            : `UDP port ${info.discoveryPort} is in use or blocked, so the Wii cannot find this computer by itself. Type the address above on the Wii.`],
    ];
    $('#status').replaceChildren(...rows.map(([good, text]) => element('li', text, good ? '' : 'bad')));
    $('#connect-note').hidden = !info.notes.length;
    $('#connect-note').textContent = info.notes.join(' ');

    $('#firewall-steps').replaceChildren(...info.firewall.steps.map((step) => element('li', step)));
    $('#firewall-commands').replaceChildren(...info.firewall.commands.flatMap((command) => {
        const box = element('div', '', 'command');
        box.append(element('strong', command.label), element('pre', command.text));
        return [box];
    }));
    $('#firewall-action').hidden = !info.firewall.canAllow;
    $('#trouble').open = !info.discovery || !info.serverRunning;

    $('#open-player').hidden = !firstRun;
    $('#close-guide').hidden = firstRun;
    show('connect');
}

// What went wrong with FFmpeg and what to do about it. `system` means the user chose the computer's own FFmpeg.
function ffmpegMessage(problem, system, found) {
    const use = 'WiiJukebox uses FFmpeg to decode music and build the stream the Wii plays.';
    if (problem === 'no-mp3') {
        const why = `The stream the Wii plays is MP3, and the FFmpeg ${system ? 'on this computer ' : ''}(${found}) cannot make MP3. Some packages leave that encoder out.`;
        if (!system) return [why, 'Install a build that includes the MP3 encoder, then press Check again:'];
        return [why, 'The FFmpeg that comes with WiiJukebox has it: switching back fixes this. To keep using your own, install a full build, then press Check again:'];
    }
    if (problem === 'none' && system) {
        return [`${use} You chose the FFmpeg already on this computer, and none was found.`,
            'Install it, then press Check again. Or switch back to the FFmpeg that comes with WiiJukebox:'];
    }
    if (problem === 'none') {
        return [`${use} This copy of the app has none, and none was found on this computer.`,
            'Reinstalling WiiJukebox from its download page brings FFmpeg back. To use your own, install it, then press Check again:'];
    }
    return [use, 'Install FFmpeg, then press Check again:'];
}

function showFfmpegProblem() {
    const problem = params.get('problem');
    const system = params.get('system') === '1';
    const version = params.get('version');
    const found = `${version ? `version ${version}, ` : ''}at ${params.get('path')}`;
    const [why, fix] = ffmpegMessage(problem, system, found);
    $('#ffmpeg-title').textContent = problem === 'no-mp3' ? 'This FFmpeg cannot make MP3' : 'FFmpeg is needed';
    $('#ffmpeg-why').textContent = why;
    $('#ffmpeg-fix').textContent = fix;
    $('#command').textContent = FFMPEG_COMMANDS[params.get('platform')] || 'Install FFmpeg with your package manager.';
    $('#use-bundled').hidden = !system;
    $('#recheck').classList.toggle('primary', !system);
}

function wire(id, handler) {
    $(id).addEventListener('click', handler);
}

wire('#begin', beginSetup);
wire('#open-player', () => bridge.openPlayer());
wire('#close-guide', () => window.close());
wire('#recheck', () => bridge.recheck());
wire('#use-bundled', () => bridge.useBundledFfmpeg());
wire('#save-server', saveServer);
wire('#cancel-server', () => window.close());
wire('#anyway', () => bridge.continueAnyway());
wire('#restart', () => bridge.restart());
wire('#try-again', () => bridge.restart());
wire('#allow-firewall', async () => {
    const button = $('#allow-firewall');
    button.disabled = true;
    $('#firewall-result').textContent = 'Waiting for Windows to ask for permission.';
    const result = await bridge.allowFirewall();
    $('#firewall-result').textContent = result.ok ? 'Done. Windows Firewall now lets your Wii connect on private networks.' : result.error;
    button.disabled = false;
});
wire('#use-port', async () => {
    const result = await bridge.setPort(Number($('#new-port').value));
    $('#port-error').hidden = result.ok;
    if (!result.ok) $('#port-error').textContent = result.error;
});
for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', async () => {
        await bridge.copy($(`#${button.dataset.copy}`).textContent);
        const label = button.textContent;
        button.textContent = 'Copied';
        setTimeout(() => { button.textContent = label; }, 1500);
    });
}
bridge.onStep((text) => { $('#step').textContent = text; });

$('#opt-defaults').addEventListener('change', () => {
    const custom = !$('#opt-defaults').checked;
    $('#welcome-server').hidden = !custom;
    if (custom) $('#server-name').focus();
});

const mode = params.get('mode') || 'starting';
if (mode === 'welcome') fillWelcome();
else if (mode === 'connect') fillConnect(params.get('help') !== '1');
else if (mode === 'server') fillServerWindow();
else {
    if (mode === 'ffmpeg') showFfmpegProblem();
    if (mode === 'crashed') $('#detail').textContent = params.get('detail') || '';
    if (mode === 'port-busy') {
        $('#busy-port').textContent = params.get('port');
        $('#new-port').value = params.get('suggested');
    }
    show(mode);
}
