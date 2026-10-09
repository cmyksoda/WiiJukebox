// SPDX-License-Identifier: GPL-3.0-only
const { Config } = require('../../src/config');
const { Pipeline } = require('../../src/core/pipeline');
const { SourceRegistry } = require('../../src/sources');
const { WebServer } = require('../../src/web/server');
const { tempDir } = require('./fake-binary');

/** A real web server, registry and pipeline over a throwaway config; only the audio output is silent. */
async function harness(sources = {}, { port = 0 } = {}) {
    const dir = tempDir('wiijukebox-home-');
    const config = new Config(dir);
    for (const [id, patch] of Object.entries(sources)) config.updateSource(id, patch);
    const registry = new SourceRegistry(config, {});
    const pipeline = new Pipeline();
    pipeline.pacer._write = () => true;
    pipeline.pacer.start();
    pipeline.on('warning', () => {});
    const web = new WebServer({ config, registry, pipeline });
    const address = await web.listen(port, '127.0.0.1');
    const base = `http://127.0.0.1:${address.port}`;
    const get = async (route) => (await fetch(`${base}${route}`)).json();
    const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', body: JSON.stringify(body) });
    return {
        dir, config, registry, pipeline, web, base, get, post,
        async close() {
            web.close();
            await pipeline.shutdown();
            await registry.disconnectAll();
        },
    };
}

module.exports = { harness };
