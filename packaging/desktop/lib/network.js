// SPDX-License-Identifier: GPL-3.0-only
// Network facts the first-run and "Connect your Wii" pages need.

const crypto = require('node:crypto');
const dgram = require('node:dgram');
const net = require('node:net');
const os = require('node:os');

function isLocalAddress(address) {
    return Object.values(os.networkInterfaces()).some((addrs) => (addrs || []).some((addr) => addr.address === address));
}

/** The address to type on the Wii: the server's saved one while this computer still has it, else a fresh guess. */
function wiiAddress(savedHostIp, detectHostIp) {
    return savedHostIp && isLocalAddress(savedHostIp) ? savedHostIp : detectHostIp();
}

/** Asks the discovery port the way the Wii does; true when the server answers. */
function probeDiscovery(port, { timeoutMs = 1500, host = '127.0.0.1' } = {}) {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        let finished = false;
        const finish = (answered) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            socket.close();
            resolve(answered);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        socket.on('message', (message) => finish(message.toString().startsWith('WIIJUKEBOX\t1\t')));
        socket.on('error', () => finish(false));
        socket.send(`WIIJUKEBOX_DISCOVER\t1\t${crypto.randomBytes(8).toString('hex')}\n`, port, host, (err) => {
            if (err) finish(false);
        });
    });
}

function portIsFree(port, host = '0.0.0.0') {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        probe.listen(port, host, () => probe.close(() => resolve(true)));
    });
}

/** First free TCP port at or after `start`. */
async function findFreePort(start, host = '0.0.0.0') {
    for (let port = start; port < start + 100; port++) {
        if (await portIsFree(port, host)) return port;
    }
    throw new Error(`no free port found from ${start}`);
}

module.exports = { isLocalAddress, wiiAddress, probeDiscovery, portIsFree, findFreePort };
