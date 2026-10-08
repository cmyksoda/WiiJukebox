// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { detect, searchPath, findTool, canEncodeMp3, ffmpegVersionNumber, ffmpegProblem } = require('../packaging/desktop/lib/tools');
const { ServerProcess } = require('../packaging/desktop/lib/server');
const { installYtdlp, assetName } = require('../packaging/desktop/lib/ytdlp-install');
const { tempDir, fakeBinary, waitFor } = require('./helpers/fake-binary');

// Stand-in programs are shebang scripts, which Windows cannot run.
const scriptable = { skip: process.platform === 'win32' && 'needs executable scripts' };

test('tool detection finds bundled programs, prefers explicit overrides and treats a missing override as not installed', scriptable, async () => {
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

test('with the included FFmpeg off, the search skips it, keeps overrides first and still finds the app\'s own yt-dlp folder', scriptable, async () => {
    const bundled = tempDir();
    const userBin = tempDir();
    const system = tempDir();
    fakeBinary(bundled, 'ffmpeg', "console.log('ffmpeg version 7.0.2-static');");
    const systemFfmpeg = fakeBinary(system, 'ffmpeg', "console.log('ffmpeg version 6.0 system');");
    const ytdlp = fakeBinary(userBin, 'yt-dlp', "console.log('2026.02.02');");

    const on = searchPath({ bundledDir: bundled, userBinDir: userBin });
    assert.deepEqual(on.slice(0, 2), [bundled, userBin], 'the default leads with the included folder');
    assert.deepEqual(searchPath({ bundledDir: bundled, userBinDir: userBin, useBundled: true }).slice(0, 2), [bundled, userBin]);

    const off = searchPath({ bundledDir: bundled, userBinDir: userBin, useBundled: false });
    assert.ok(!off.includes(bundled), 'the included folder is not searched');
    assert.equal(off[0], userBin);
    for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) assert.ok(off.includes(dir), `${dir} from PATH remains`);
    const forced = searchPath({ bundledDir: bundled, userBinDir: userBin, overrides: { ffmpeg: systemFfmpeg }, useBundled: false });
    assert.equal(forced[0], system, 'an override still wins');

    // The same folders, as the app would search them, end up on different FFmpeg builds.
    assert.match((await detect([bundled, userBin, system])).ffmpeg.version, /7\.0\.2/);
    const found = await detect([userBin, system]);
    assert.equal(found.ffmpeg.path, systemFfmpeg);
    assert.equal(found.ytdlp.path, ytdlp);
    assert.equal((await detect([userBin])).ffmpeg, null, 'no system FFmpeg at all');
});

test('an FFmpeg counts as usable only when it can encode MP3', scriptable, async () => {
    const dir = tempDir();
    const encoders = (list) => `if (process.argv.includes('-encoders')) { console.log(${JSON.stringify(list)}); process.exit(0); } console.log('ffmpeg version 7.1');`;
    const full = fakeBinary(dir, 'full', encoders(' A....D libmp3lame           libmp3lame MP3 (MPEG audio layer 3) (codec mp3)'));
    const lacking = fakeBinary(dir, 'lacking', encoders(' A....D libopus              libopus Opus (codec opus)\n A....D mp3_mf              MP3 via Media Foundation'));
    const broken = fakeBinary(dir, 'broken', 'process.exit(1);');

    assert.equal(await canEncodeMp3(full), true);
    assert.equal(await canEncodeMp3(lacking), false);
    assert.equal(await canEncodeMp3(broken), false);
    assert.equal(await canEncodeMp3(path.join(dir, 'missing')), false);

    const withLame = (await detect([dir], { ffmpeg: full })).ffmpeg;
    const without = (await detect([dir], { ffmpeg: lacking })).ffmpeg;
    assert.equal(withLame.mp3, true);
    assert.equal(without.mp3, false);
    assert.equal(ffmpegProblem(withLame), null);
    assert.equal(ffmpegProblem(without), 'no-mp3');
    assert.equal(ffmpegProblem(null), 'none');
});

test('only the version number of an FFmpeg banner is shown', () => {
    assert.equal(ffmpegVersionNumber('ffmpeg version 7.0.2-static https://johnvansickle.com/ffmpeg/  Copyright (c) 2000-2024'), '7.0.2');
    assert.equal(ffmpegVersionNumber('ffmpeg version 8.1.3-Jellyfin Copyright (c) 2000-2026'), '8.1.3');
    assert.equal(ffmpegVersionNumber('ffmpeg version 6.1.1-essentials_build-www.gyan.dev Copyright'), '6.1.1');
    assert.equal(ffmpegVersionNumber('ffmpeg version n7.1 Copyright'), '7.1');
    assert.equal(ffmpegVersionNumber('ffmpeg version N-117000-gabcdef Copyright'), null, 'a development build has no number');
    assert.equal(ffmpegVersionNumber(''), null);
    assert.equal(ffmpegVersionNumber(undefined), null);
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

    // A server that fails while starting rejects start(); only a running one that dies is a crash.
    const failing = path.join(dir, 'fail.js');
    fs.writeFileSync(failing, "console.error('boom'); setTimeout(() => process.exit(2), 100); setInterval(() => {}, 1000);");
    const failed = new ServerProcess({ entry: failing, cwd: dir, env: {}, nodePath: process.execPath });
    const failedReasons = [];
    failed.on('crashed', (reason) => failedReasons.push(reason));
    await assert.rejects(failed.start(), /server exited.*boom/s);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(failedReasons, []);

    const crashing = path.join(dir, 'crash.js');
    fs.writeFileSync(crashing, "console.log('  WebUI    http://192.168.0.9:4393'); setTimeout(() => process.exit(2), 300); setInterval(() => {}, 1000);");
    const dying = new ServerProcess({ entry: crashing, cwd: dir, env: {}, nodePath: process.execPath });
    const reasons = [];
    dying.on('crashed', (reason) => reasons.push(reason));
    await dying.start();
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
    if (process.platform !== 'win32') assert.ok(fs.statSync(ok).mode & 0o100, 'executable');
    await assert.rejects(installYtdlp(dir, async () => ({ ok: true, arrayBuffer: async () => Buffer.alloc(10) })), /too small/);
    await assert.rejects(installYtdlp(dir, async () => ({ ok: false, status: 404 })), /HTTP 404/);
});
