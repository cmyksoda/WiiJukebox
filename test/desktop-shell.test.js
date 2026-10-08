// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const lib = path.join(__dirname, '..', 'packaging', 'desktop', 'lib');
const { Settings, closeAction } = require(path.join(lib, 'settings'));
const { createAutostart } = require(path.join(lib, 'autostart'));
const { isLocalAddress, wiiAddress, probeDiscovery, findFreePort } = require(path.join(lib, 'network'));
const { guidance, windowsCommand, allowWindowsFirewall } = require(path.join(lib, 'firewall'));
const { serverConfig } = require(path.join(lib, 'server-config'));
const { openLog } = require(path.join(lib, 'logfile'));
const { Discovery } = require('../src/client/discovery');
const { tempDir } = require('./helpers/fake-binary');

test('settings start fresh, persist changes and ignore damaged or mistyped files', () => {
    const file = path.join(tempDir(), 'nested', 'settings.json');
    const fresh = new Settings(file);
    assert.equal(fresh.get('setupDone'), false);
    assert.equal(fresh.get('onClose'), 'ask');
    fresh.set('setupDone', true);
    fresh.set('onClose', 'background');
    assert.throws(() => fresh.set('bogus', 1), /unknown setting/);

    const again = new Settings(file);
    assert.equal(again.get('setupDone'), true);
    assert.equal(again.get('onClose'), 'background');

    fs.writeFileSync(file, JSON.stringify({ setupDone: 'yes', onClose: 'quit' }));
    const mistyped = new Settings(file);
    assert.equal(mistyped.get('setupDone'), false, 'a value of the wrong type is ignored');
    assert.equal(mistyped.get('onClose'), 'quit');

    fs.writeFileSync(file, '{ not json');
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        assert.equal(new Settings(file).get('setupDone'), false);
    } finally {
        console.warn = originalWarn;
    }
});

test('closing the window keeps the music playing unless the user chose to quit', () => {
    const done = { quitting: false, setupDone: true };
    assert.equal(closeAction({ ...done, mode: 'ask' }), 'ask');
    assert.equal(closeAction({ ...done, mode: 'background' }), 'hide');
    assert.equal(closeAction({ ...done, mode: 'quit' }), 'close');
    assert.equal(closeAction({ ...done, mode: 'background', quitting: true }), 'close', 'quitting always closes');
    assert.equal(closeAction({ ...done, mode: 'background', setupDone: false }), 'close', 'the setup window just closes');
});

test('start at login writes a quoted autostart entry on Linux and uses login items elsewhere', () => {
    const configHome = tempDir();
    const executable = '/home/me/My Apps/Wii"Jukebox.AppImage';
    const linux = createAutostart({ app: {}, platform: 'linux', executable, configHome });
    assert.equal(linux.isEnabled(), false);
    linux.set(true);
    assert.equal(linux.isEnabled(), true);
    const entry = fs.readFileSync(path.join(configHome, 'autostart', 'wiijukebox.desktop'), 'utf8');
    assert.match(entry, /^Exec="\/home\/me\/My Apps\/Wii\\"Jukebox\.AppImage" --hidden$/m);
    linux.set(false);
    assert.equal(linux.isEnabled(), false);
    linux.set(false);

    const calls = [];
    const app = {
        setLoginItemSettings: (options) => calls.push(options),
        getLoginItemSettings: (query) => ({ openAtLogin: query.args.includes('--hidden') && calls.at(-1)?.openAtLogin === true }),
    };
    const win = createAutostart({ app, platform: 'win32', executable: 'C:\\Apps\\WiiJukebox.exe' });
    win.set(true);
    assert.deepEqual(calls[0], { path: 'C:\\Apps\\WiiJukebox.exe', args: ['--hidden'], openAtLogin: true });
    assert.equal(win.isEnabled(), true);
});

test('discovery probe talks to the real discovery socket; free-port search skips busy ports', async () => {
    const discovery = new Discovery({ config: { data: { station: { name: 'Test' }, mount: '/stream' }, save() {} }, port: 4000 });
    const { port } = await discovery.start(0, '127.0.0.1');
    try {
        assert.equal(await probeDiscovery(port), true);
    } finally {
        discovery.close();
    }
    assert.equal(await probeDiscovery(port, { timeoutMs: 300 }), false, 'a closed port does not answer');

    const holder = net.createServer();
    await new Promise((resolve) => holder.listen(0, '0.0.0.0', resolve));
    const busy = holder.address().port;
    try {
        assert.notEqual(await findFreePort(busy), busy);
    } finally {
        holder.close();
    }

    assert.equal(wiiAddress('203.0.113.9', () => '192.168.0.2'), '192.168.0.2', 'a saved address this computer no longer has is replaced');
    assert.equal(wiiAddress('127.0.0.1', () => '192.168.0.2'), '127.0.0.1');
    assert.equal(isLocalAddress('127.0.0.1'), true);
});

test('firewall guidance names the ports and only Windows offers the automatic fix', async () => {
    const ports = { port: 4000, discoveryPort: 4001 };
    const linux = guidance({ platform: 'linux', ...ports });
    assert.equal(linux.canAllow, false);
    assert.ok(linux.commands.every((command) => command.text.includes('4000') && command.text.includes('4001')));
    assert.equal(guidance({ platform: 'win32', ...ports }).canAllow, true);
    assert.equal(guidance({ platform: 'darwin', ...ports }).commands.length, 0);

    const encoded = /'-EncodedCommand','([^']+)'/.exec(windowsCommand("C:\\Users\\O'Brien\\WiiJukebox.exe"))[1];
    const inner = Buffer.from(encoded, 'base64').toString('utf16le');
    assert.match(inner, /-Program 'C:\\Users\\O''Brien\\WiiJukebox\.exe'/);
    assert.match(inner, /-Profile Private,Domain/);

    const seen = [];
    await allowWindowsFirewall('C:\\a.exe', (file, args, options, done) => { seen.push(file); done(null, '', ''); });
    assert.deepEqual(seen, ['powershell.exe']);
    await assert.rejects(allowWindowsFirewall('C:\\a.exe', (file, args, options, done) => done(new Error('x'), '', 'denied')), /denied/);
});

test('the server config helper reads defaults, keeps other keys when changing the port and survives a missing file', () => {
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tempDir();
    try {
        const config = serverConfig(path.join(__dirname, '..'));
        assert.equal(config.read().port, 4000);
        config.setPort(4123);
        assert.equal(config.read().port, 4123);
        const saved = JSON.parse(fs.readFileSync(config.file, 'utf8'));
        saved.station = { name: 'Kitchen' };
        fs.writeFileSync(config.file, JSON.stringify(saved));
        config.setPort(4200);
        assert.equal(config.read().station.name, 'Kitchen');
        assert.equal(config.read().port, 4200);
    } finally {
        if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previous;
    }
});

test('the log file restarts when it is too big and timestamps each line', async () => {
    const file = path.join(tempDir(), 'logs', 'server.log');
    const first = openLog(file, 50);
    first.write('hello');
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(fs.readFileSync(file, 'utf8'), /^\d{4}-\d\d-\d\dT[\d:.]+Z hello\n$/);
    fs.appendFileSync(file, 'x'.repeat(100));
    const second = openLog(file, 50);
    second.write('after');
    second.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 1);
});
