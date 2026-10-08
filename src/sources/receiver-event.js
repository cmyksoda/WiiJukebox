// SPDX-License-Identifier: GPL-3.0-only
// Run by librespot's --onevent for each player event: forwards the environment
// it was given to the server's local socket, then exits.

const net = require('node:net');

const KEYS = ['PLAYER_EVENT', 'TRACK_ID', 'NAME', 'ARTISTS', 'ALBUM', 'COVERS', 'DURATION_MS',
    'POSITION_MS', 'ITEM_TYPE', 'SHOW_NAME', 'USER_NAME', 'CLIENT_NAME', 'VOLUME'];
const payload = {};
for (const key of KEYS) if (process.env[key] !== undefined) payload[key] = process.env[key];

const socket = net.connect(process.argv[2]);
const giveUp = setTimeout(() => process.exit(0), 2000);
socket.on('error', () => process.exit(0));
socket.on('connect', () => socket.end(`${JSON.stringify(payload)}\n`, () => {
    clearTimeout(giveUp);
    process.exit(0);
}));
