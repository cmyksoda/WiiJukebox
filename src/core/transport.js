// SPDX-License-Identifier: GPL-3.0-only
function control(pipeline, config, action) {
    return pipeline.command(async () => {
        const source = pipeline.activeSource;
        if (!source) return { code: 409, error: 'nothing is playing' };
        if (!pipeline.status.capabilities[action]) {
            return { code: 400, error: `${source.label} does not support ${action}` };
        }
        if (action === 'stop') {
            await pipeline.detach();
            config.data.lastPlayed = null;
            config.save();
        } else if (action === 'pause' || action === 'play') {
            pipeline.setPaused(action === 'pause');
        } else if (action === 'next' || action === 'previous') {
            const handle = await source[action]();
            if (!handle) return { ok: true, endOfQueue: true };
            await pipeline.playHandle(handle);
        } else return { code: 400, error: 'unsupported control' };
        return { ok: true, status: pipeline.status };
    });
}
module.exports = { control };
