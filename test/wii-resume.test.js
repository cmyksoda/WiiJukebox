// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { Pipeline } = require('../src/core/pipeline');
const run = promisify(execFile);

// A direct listener records the server's own byte stream for comparison.
function record(port) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write('GET /stream HTTP/1.0\r\n\r\n'));
        const state = { socket, start: -1, bytes: [] };
        let head = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            if (state.start >= 0) return state.bytes.push(chunk);
            head = Buffer.concat([head, chunk]);
            const end = head.indexOf('\r\n\r\n');
            if (end < 0) return;
            state.start = Number(/X-WiiJukebox-Byte-Start: (\d+)/i.exec(head.subarray(0, end).toString())[1]);
            state.bytes.push(head.subarray(end + 4));
            resolve(state);
        });
        socket.on('error', reject);
    });
}

for (const mode of ['dropped', 'silently stalled']) test(`a ${mode} Wii stream reconnects through a delay and continues byte-exactly`, { timeout: 40000 }, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wiijukebox-resume-'));
    const pipeline = new Pipeline();
    const server = http.createServer((req, res) => pipeline.broadcaster.handleRequest(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const requests = [];
    const proxy = net.createServer((client) => {
        const index = requests.length;
        let line = '';
        client.once('data', (first) => {
            line = first.toString().split('\r\n')[0];
            requests.push(line);
            // The second attempt waits a second, like a Wi-Fi gap during reconnect.
            setTimeout(() => {
                const upstream = net.connect(server.address().port, '127.0.0.1', () => upstream.write(first));
                let down = 0;
                upstream.on('data', (chunk) => {
                    if (index === 0 && down > 150000) {
                        // A stalled path keeps the socket open but delivers nothing more.
                        if (mode === 'dropped') { upstream.destroy(); client.destroy(); }
                        return;
                    }
                    down += chunk.length;
                    client.write(chunk);
                });
                upstream.on('error', () => client.destroy());
                client.on('error', () => upstream.destroy());
                client.on('close', () => upstream.destroy());
            }, index === 1 ? 1000 : 0);
        });
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    pipeline.start();
    try {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const direct = await record(server.address().port);
        const output = path.join(tmp, 'resumed.bin');
        const { stdout } = await run('./client/build/resume_probe', [String(proxy.address().port), output, '260000'],
            { timeout: 25000 });
        assert.match(stdout, /reconnects=[1-9]/);
        assert.equal(requests[0], 'GET /stream?v=2 HTTP/1.0');
        assert.match(requests[1], /^GET \/stream\?v=2&epoch=\d+&from=\d+ HTTP\/1\.0$/);
        const file = await fs.readFile(output);
        const newline = file.indexOf(10);
        const first = Number(file.subarray(0, newline).toString());
        const received = file.subarray(newline + 1);
        const reference = Buffer.concat(direct.bytes);
        const offset = first - direct.start;
        assert.ok(offset >= 0 && offset + received.length <= reference.length, 'direct capture covers the probe');
        assert.ok(received.equals(reference.subarray(offset, offset + received.length)),
            'audio after the reconnect continues exactly where the dropped connection stopped');
        direct.socket.destroy();
    } finally {
        proxy.close(); server.close();
        await pipeline.shutdown();
        await fs.rm(tmp, { recursive: true, force: true });
    }
});
