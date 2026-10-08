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

async function fillWelcome() {
    const info = await bridge.info();
    $('#ffmpeg-version').textContent = info.tools.ffmpeg ? `(${info.tools.ffmpeg})` : '';
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
    show('working');
    const result = await bridge.beginSetup({ ytdlp: $('#opt-ytdlp').checked, login: $('#opt-login').checked });
    // Success and server failures replace this page, so only a failure to save the choices lands here.
    if (result.ok) return;
    $('#begin').disabled = false;
    $('#begin-error').textContent = result.error;
    $('#begin-error').hidden = false;
    show('welcome');
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

function wire(id, handler) {
    $(id).addEventListener('click', handler);
}

wire('#begin', beginSetup);
wire('#open-player', () => bridge.openPlayer());
wire('#close-guide', () => window.close());
wire('#recheck', () => bridge.recheck());
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

const mode = params.get('mode') || 'starting';
if (mode === 'welcome') fillWelcome();
else if (mode === 'connect') fillConnect(params.get('help') !== '1');
else {
    if (mode === 'ffmpeg') $('#command').textContent = FFMPEG_COMMANDS[params.get('platform')] || 'Install FFmpeg with your package manager.';
    if (mode === 'crashed') $('#detail').textContent = params.get('detail') || '';
    if (mode === 'port-busy') {
        $('#busy-port').textContent = params.get('port');
        $('#new-port').value = params.get('suggested');
    }
    show(mode);
}
