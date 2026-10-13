// SPDX-License-Identifier: GPL-3.0-only
const fs = require('node:fs');
const path = require('node:path');
const { fakeSpotify, fakeLibrespotSource } = require('./fake-spotify');
const { harness } = require('./app-harness');
const { tempDir, fakeBinary } = require('./fake-binary');

/** The app over a fake Spotify, signed in unless `signedIn` is false, with a fake librespot that follows the fake player. */
async function rig({ spotify = {}, fake: fakeOptions = {}, signedIn = true } = {}) {
    const dir = tempDir('wj-spot-');
    const stateFile = path.join(dir, 'player.json');
    const fake = await fakeSpotify({ stateFile, ...fakeOptions });
    fakeBinary(dir, 'librespot', fakeLibrespotSource(dir, stateFile));
    const app = await harness({ spotify: {
        binary: path.join(dir, 'librespot'), deviceName: 'WiiJukebox', clientId: fake.clientId,
        refreshToken: signedIn ? fake.signedIn() : null, account: signedIn ? 'Jaxi' : '', ...spotify,
    } }, { deps: fake.deps });
    const warnings = [];
    app.pipeline.on('warning', (message) => warnings.push(message));
    const runs = () => (fs.existsSync(path.join(dir, 'runs.json'))
        ? fs.readFileSync(path.join(dir, 'runs.json'), 'utf8').trim().split('\n').length : 0);
    return {
        app, fake, dir, warnings, runs,
        source: () => app.registry.get('spotify'),
        play: (item) => app.pipeline.command(async () => app.pipeline.attach(await app.registry.connect('spotify'), item)),
        async close() {
            await app.close();
            await fake.close();
        },
    };
}

module.exports = { rig };
