// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

test('Wii HTTP reads fragmented headers and large bodies without waiting for socket closure', async () => {
    const body = 'music-'.repeat(2000);
    const sockets = new Set();
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.once('data', () => {
            socket.write(`HTTP/1.0 200 OK\r\nContent-Length: ${body.length}\r\n\r`);
            setTimeout(() => socket.write(`\n${body}`), 20);
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const { stdout } = await run('./client/build/http_probe', [String(server.address().port)], { timeout: 2000 });
        assert.equal(stdout, body);
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    }
});

test('Wii HTTP rejects a response that closes before its declared body finishes', async () => {
    const server = net.createServer(socket => {
        socket.once('data', () => socket.end('HTTP/1.0 200 OK\r\nContent-Length: 50\r\n\r\nshort'));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await assert.rejects(run('./client/build/http_probe', [String(server.address().port)], { timeout: 2000 }),
            error => error.code === 1);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
