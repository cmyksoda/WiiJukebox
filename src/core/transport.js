// SPDX-License-Identifier: GPL-3.0-only
const { nextMode } = require('./play-modes');

function control(pipeline, config, action, { position, value } = {}) {
    return pipeline.command(async () => {
        const source = pipeline.activeSource;
        if (action === 'shuffle' || action === 'repeat') {
            if (!pipeline.status.capabilities[action]) {
                return { code: 400, error: `${source.label} does not support ${action}` };
            }
            let mode;
            try { mode = nextMode(action, value, pipeline.modes); } catch (err) { return { code: 400, error: err.message }; }
            await pipeline.setMode(action, mode);
            config.data.playModes = pipeline.modes;
            config.save();
            return { ok: true, status: pipeline.status };
        }
        if (!source) return { code: 409, error: 'nothing is playing' };
        if (!pipeline.status.capabilities[action]) {
            return { code: 400, error: `${source.label} does not support ${action}` };
        }
        if (source.constructor.remoteControl && ['play', 'pause', 'next', 'previous'].includes(action)) {
            // The service owns playback, so the local pacer is not touched; its own state flows back as events.
            const result = await source[action]();
            if (result?.endOfQueue) return { ok: true, endOfQueue: true };
        } else if (action === 'stop') {
            await pipeline.detach();
            pipeline.markJump({ audio: false });
            config.data.lastPlayed = null;
            config.save();
        } else if (action === 'pause' || action === 'play') {
            pipeline.setPaused(action === 'pause');
        } else if (action === 'seek') {
            return { ok: true, position: await pipeline.seek(Number(position)) };
        } else if (action === 'next' || action === 'previous') {
            const handle = await source[action]();
            if (!handle) return { ok: true, endOfQueue: true };
            await pipeline.playHandle(handle);
            pipeline.markJump();
        } else return { code: 400, error: 'unsupported control' };
        return { ok: true, status: pipeline.status };
    });
}
module.exports = { control };
