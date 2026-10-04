#!/usr/bin/env node
// WiiJukebox entry point.
//
// Brings up the persistent stream first, then the WebUI. Order matters: the
// mount should be live and serving silence before anything else can fail, so a
// misconfigured source never leaves the Wii with a dead station.

const path = require('path');
const { Discovery, serverIdentity } = require('./client/discovery');
const { Pipeline } = require('./core/pipeline');
const { SourceRegistry } = require('./sources/index');
const { WebServer } = require('./web/server');
const { Config, detectHostIp } = require('./config');

async function main() {
    const config = new Config();
    config.load();

    if (!config.data.hostIp) {
        config.data.hostIp = detectHostIp();
        config.save();
    }

    const pipeline = new Pipeline({
        station: {
            mount: config.data.mount,
            ...config.data.station,
        },
    });

    pipeline.on('warning', (msg) => console.warn(`! ${msg}`));
    pipeline.on('listener-connected', (info) =>
        console.log(`+ listener ${info.address} (${info.userAgent})`),
    );
    pipeline.on('listener-disconnected', () => console.log('- listener left'));

    // When a track ends, advance the queue if the source has one. Without this
    // an album would stop after its first track.
    pipeline.on('track-ended', (event) => {
        pipeline.advanceEnded(event).catch((err) => console.warn(`! advancing queue: ${err.message}`));
    });

    pipeline.start();

    const registry = new SourceRegistry(config, { serverId: serverIdentity(config) });
    const web = new WebServer({
        pipeline,
        registry,
        config,
        publicDir: path.join(__dirname, '..', 'public'),
    });

    const address = await web.listen(config.data.port);
    const discovery = new Discovery({ config, port: address.port,
        onWarning: (msg) => console.warn(`! ${msg}`) });
    await discovery.start().catch((err) => console.warn(`! discovery unavailable: ${err.message}`));
    console.log(`  Server ID ${discovery.id}`);

    const url = `http://${config.data.hostIp}:${config.data.port}`;
    console.log('');
    console.log('  WiiJukebox is running');
    console.log(`  WebUI    ${url}`);
    console.log(`  Stream   ${url}${config.data.mount}`);
    console.log(`  Playlist ${url}/playlist.pls  -> WiiRadio compatibility`);
    console.log('');

    // Restore whatever was playing before the last shutdown, so a restart is
    // invisible from the Wii's side.
    if (config.data.lastPlayed && config.data.lastPlayed.source !== 'desktop') {
        const { source: id, item } = config.data.lastPlayed;
        try {
            const source = await registry.connect(id);
            await pipeline.attach(source, item);
            console.log(`resumed ${id}`);
        } catch (err) {
            console.warn(`! could not resume ${id}: ${err.message}`);
        }
    }

    const shutdown = async (signal) => {
        console.log(`\n${signal}, shutting down...`);
        discovery.close();
        web.close();
        await pipeline.command(() => pipeline.shutdown());
        await registry.disconnectAll();
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
    console.error('failed to start:', err);
    process.exit(1);
});
