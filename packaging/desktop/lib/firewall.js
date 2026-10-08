// SPDX-License-Identifier: GPL-3.0-only
// What to tell the user about each system's firewall, and the one fix that can be automated.

const { execFile } = require('node:child_process');

const RULE_NAME = 'WiiJukebox';
const SAME_NETWORK = 'The Wii and this computer must be on the same Wi-Fi or network. Guest networks often stop devices from seeing each other.';

/** @returns {{canAllow: boolean, steps: string[], commands: {label: string, text: string}[]}} */
function guidance({ platform, port, discoveryPort }) {
    if (platform === 'win32') {
        return {
            canAllow: true,
            steps: [
                'When Windows asks whether WiiJukebox may use the network, tick Private networks and choose Allow access.',
                'If you closed that question or said no, press the button below. Windows asks for permission once.',
                'If Windows calls your Wi-Fi a Public network, change it to Private: Settings, Network & Internet, Wi-Fi, your network, Network profile type.',
                SAME_NETWORK,
            ],
            commands: [],
        };
    }
    if (platform === 'darwin') {
        return {
            canAllow: false,
            steps: [
                'macOS may ask whether WiiJukebox may accept incoming network connections. Choose Allow.',
                'If you chose Don\'t Allow: System Settings, Network, Firewall, Options, then set WiiJukebox to Allow incoming connections.',
                'If macOS asks about devices on your local network, choose Allow (System Settings, Privacy & Security, Local Network).',
                SAME_NETWORK,
            ],
            commands: [],
        };
    }
    return {
        canAllow: false,
        steps: [
            `Most Linux systems let the Wii connect without changes. If yours runs a firewall, allow TCP port ${port} and UDP port ${discoveryPort}.`,
            SAME_NETWORK,
        ],
        commands: [
            { label: 'Ubuntu, Debian (ufw)', text: `sudo ufw allow ${port}/tcp && sudo ufw allow ${discoveryPort}/udp` },
            { label: 'Fedora, openSUSE (firewalld)', text: `sudo firewall-cmd --permanent --add-port=${port}/tcp --add-port=${discoveryPort}/udp && sudo firewall-cmd --reload` },
        ],
    };
}

/** The PowerShell that asks for administrator rights once and adds an inbound rule for the program. */
function windowsCommand(executable) {
    const quoted = executable.replace(/'/g, "''");
    const inner = [
        '$ErrorActionPreference = \'Stop\'',
        `Remove-NetFirewallRule -DisplayName '${RULE_NAME}' -ErrorAction SilentlyContinue`,
        `New-NetFirewallRule -DisplayName '${RULE_NAME}' -Direction Inbound -Action Allow -Program '${quoted}' -Profile Private,Domain | Out-Null`,
    ].join('; ');
    const encoded = Buffer.from(inner, 'utf16le').toString('base64');
    return '$p = Start-Process -FilePath powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden ' +
        `-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'; exit $p.ExitCode`;
}

/** Windows only. Rejects if the user declines the administrator prompt. */
function allowWindowsFirewall(executable, run = execFile) {
    return new Promise((resolve, reject) => {
        run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsCommand(executable)], { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
            if (err) reject(new Error(String(stderr || '').trim() || 'Windows did not add the firewall rule (the permission prompt may have been declined).'));
            else resolve();
        });
    });
}

module.exports = { guidance, windowsCommand, allowWindowsFirewall, RULE_NAME };
