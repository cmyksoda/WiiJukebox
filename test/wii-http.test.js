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

for (const [name, program, faults] of [
    ['host', './client/build/http_probe', false],
    ['Wii branch with IOS-style errors', './client/build/ios_http_probe', true],
]) {
    async function fixture(reply, check) {
        const sockets = new Set();
        const server = net.createServer(socket => {
            sockets.add(socket);
            socket.on('error', () => {});
            let request = '';
            socket.on('data', chunk => {
                request += chunk;
                if (request.includes('\r\n\r\n')) {
                    socket.removeAllListeners('data');
                    reply(socket, request);
                }
            });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            await check(() => run(program, [String(server.address().port)], {
                timeout: 12000, env: { ...process.env, ...(faults ? { WJ_IOS_FAULTS: '1' } : {}) },
            }));
        } finally {
            for (const socket of sockets) socket.destroy();
            await new Promise(resolve => server.close(resolve));
        }
    }

    test(`${name}: partial sends and fragmented reads preserve the entire request and body`, async () => {
        const body = 'source\tsubsonic\tNavidrome / Subsonic\tready\n'.repeat(350);
        await fixture((socket, request) => {
            assert.equal(request, 'GET /test HTTP/1.0\r\n' +
                `Host: 127.0.0.1:${socket.localPort}\r\nUser-Agent: WiiJukebox/0.1\r\n` +
                'Connection: close\r\nContent-Length: 0\r\n\r\n');
            socket.write(`HTTP/1.0 200 OK\r\nContent-Length: ${body.length}\r\n\r`);
            setTimeout(() => socket.write(`\n${body}`), 20);
        }, async invoke => {
            const { stdout, stderr } = await invoke();
            assert.equal(stdout, body);
            assert.match(stderr, new RegExp(`stage=done error=0 status=200 received=${body.length} expected=${body.length}`));
        });
    });

    test(`${name}: truncated body retains exact failure evidence`, async () => {
        await fixture(socket => socket.end('HTTP/1.0 200 OK\r\nContent-Length: 50\r\n\r\nshort'),
            async invoke => assert.rejects(invoke(), error => {
                assert.equal(error.code, 1);
                assert.match(error.stderr, /stage=body error=-10003 status=200 received=5 expected=50/);
                return true;
            }));
    });

    test(`${name}: stalled header times out with its stage intact`, async () => {
        await fixture(socket => socket.write('HTTP/1.0 200 OK\r\n'),
            async invoke => assert.rejects(invoke(), error => {
                assert.equal(error.code, 1);
                assert.match(error.stderr, /stage=headers error=-10000 status=0/);
                return true;
            }));
    });

    test(`${name}: unsupported transfer encoding is rejected`, async () => {
        await fixture(socket => socket.end('HTTP/1.0 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n'),
            async invoke => assert.rejects(invoke(), error => {
                assert.equal(error.code, 1);
                assert.match(error.stderr, /stage=headers error=-10001 status=200/);
                return true;
            }));
    });
}
