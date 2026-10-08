// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { detect, searchPath, findTool } = require('../packaging/desktop/lib/tools');
const { ServerProcess } = require('../packaging/desktop/lib/server');
const { installYtdlp, assetName } = require('../packaging/desktop/lib/ytdlp-install');
const { tempDir, fakeBinary, waitFor } = require('./helpers/fake-binary');

test('tool detection finds bundled programs, prefers explicit overrides and treats a missing override as not installed', async () => {
    const bundled = tempDir();
    const ffmpeg = fakeBinary(bundled, 'ffmpeg', "console.log('ffmpeg version 6.1 fake');");
    const ytdlp = fakeBinary(bundled, 'yt-dlp', "console.log('2026.01.01');");

    const dirs = searchPath({ bundledDir: bundled, userBinDir: path.join(bundled, 'user') });
    assert.ok(dirs.includes(bundled));
    assert.equal(findTool('ffmpeg', [bundled]), ffmpeg);

    const found = await detect([bundled]);
    assert.equal(found.ffmpeg.path, ffmpeg);
    assert.equal(found.ffmpeg.version, 'ffmpeg version 6.1 fake');
    assert.equal(found.ytdlp.version, '2026.01.01');

    const missing = await detect(dirs, { ffmpeg: path.join(bundled, 'nope', 'ffmpeg'), ytdlp });
    assert.equal(missing.ffmpeg, null);
    assert.equal(missing.ytdlp.path, ytdlp);
    assert.equal(searchPath({ bundledDir: bundled, overrides: { ytdlp } })[0], path.dirname(ytdlp));

    // The app's own copies win over whatever the system has on PATH.
    assert.equal(searchPath({ bundledDir: bundled, userBinDir: path.join(bundled, 'user') })[0], bundled);
    const system = tempDir();
    fakeBinary(system, 'ffmpeg', "console.log('ffmpeg version system');");
    assert.equal((await detect([bundled, system])).ffmpeg.path, ffmpeg);

    // A file that exists but is not a working program is also "not installed".
    const broken = fakeBinary(bundled, 'broken-ffmpeg', 'process.exit(3);');
    assert.equal((await detect([bundled], { ffmpeg: broken })).ffmpeg, null);
});

// A stand-in for src/main.js: prints the same banner and stays up.
const FAKE_SERVER = (port) => `
console.log('  WiiJukebox is running');
console.log('  WebUI    http://192.168.0.9:${port}');
process.on('SIGTERM', () => { console.log('bye'); process.exit(0); });
setInterval(() => {}, 1000);
`;

test('server process reports its URL, stops cleanly and reports a crash it did not cause', async () => {
    const dir = tempDir();
    const entry = path.join(dir, 'server.js');
    fs.writeFileSync(entry, FAKE_SERVER(4391));
    const server = new ServerProcess({ entry, cwd: dir, env: {}, nodePath: process.execPath });
    const url = await server.start();
    assert.equal(url, 'http://127.0.0.1:4391/');
    assert.ok(server.log.some((line) => /WebUI/.test(line)));
    const crashes = [];
    server.on('crashed', (reason) => crashes.push(reason));
    await server.stop();
    assert.equal(server.child, null);
    assert.deepEqual(crashes, [], 'a requested stop is not a crash');

    const crashing = path.join(dir, 'crash.js');
    fs.writeFileSync(crashing, "console.error('boom'); setTimeout(() => process.exit(2), 300); setInterval(() => {}, 1000);");
    const dying = new ServerProcess({ entry: crashing, cwd: dir, env: {}, nodePath: process.execPath });
    const reasons = [];
    dying.on('crashed', (reason) => reasons.push(reason));
    await assert.rejects(dying.start(), /server exited.*boom/s);
    await waitFor(() => reasons.length);
    assert.match(reasons[0], /code 2/);
});

test('the server wrapper shuts the server down when its parent closes stdin', async () => {
    const dir = tempDir();
    const entry = path.join(dir, 'server.js');
    fs.writeFileSync(entry, FAKE_SERVER(4392));
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'packaging', 'desktop', 'lib', 'server-entry.js'), entry], { stdio: ['pipe', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    await waitFor(() => /WebUI/.test(output));
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    child.stdin.end();
    assert.equal(await exited, 0);
    assert.match(output, /bye/);
});

test('yt-dlp installer writes an executable only for a plausible download', async () => {
    assert.ok(typeof assetName() === 'string' || assetName() === null);
    const dir = tempDir();
    const big = Buffer.alloc(1_200_000, 1);
    const ok = await installYtdlp(path.join(dir, 'bin'), async () => ({ ok: true, arrayBuffer: async () => big }));
    assert.equal(fs.statSync(ok).size, big.length);
    assert.ok(fs.statSync(ok).mode & 0o100, 'executable');
    await assert.rejects(installYtdlp(dir, async () => ({ ok: true, arrayBuffer: async () => Buffer.alloc(10) })), /too small/);
    await assert.rejects(installYtdlp(dir, async () => ({ ok: false, status: 404 })), /HTTP 404/);
});
