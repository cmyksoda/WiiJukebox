// SPDX-License-Identifier: GPL-3.0-only
const dgram = require('node:dgram');
const { randomUUID } = require('node:crypto');
const DISCOVERY_PORT = 4001;

function serverIdentity(config) {
    if (!/^[a-f0-9-]{36}$/.test(config.data.serverId || '')) {
        config.data.serverId = randomUUID();
        config.save();
    }
    return config.data.serverId;
}

class Discovery {
    constructor({ config, port, onWarning = () => {} }) {
        this.config = config;
        this.port = port;
        this.id = serverIdentity(config);
        this.onWarning = onWarning;
        this.socket = null;
    }

    async start(port = DISCOVERY_PORT, host = '0.0.0.0') {
        const socket = dgram.createSocket('udp4');
        this.socket = socket;
        let budget = 20;
        this.refill = setInterval(() => { budget = 20; }, 1000);
        this.refill.unref();
        socket.on('message', (message, remote) => {
            if (message.length > 128 || !budget) return;
            const match = /^WIIJUKEBOX_DISCOVER\t1\t([a-f0-9]{16})\n$/.exec(message.toString());
            if (!match) return;
            budget--;
            const fields = ['WIIJUKEBOX', '1', match[1], this.id, this.port,
                encodeURIComponent(String(this.config.data.station.name).slice(0, 80)),
                encodeURIComponent(this.config.data.mount)];
            socket.send(fields.join('\t') + '\n', remote.port, remote.address, (err) => {
                if (err) this.onWarning(`discovery reply: ${err.message}`);
            });
        });
        await new Promise((resolve, reject) => {
            const fail = (err) => { this.close(); reject(err); };
            socket.once('error', fail);
            socket.bind(port, host, () => {
                socket.off('error', fail);
                socket.on('error', (err) => this.onWarning(`discovery: ${err.message}`));
                resolve();
            });
        });
        return socket.address();
    }

    close() {
        clearInterval(this.refill);
        if (this.socket) { this.socket.close(); this.socket = null; }
    }
}
module.exports = { Discovery, DISCOVERY_PORT, serverIdentity };
