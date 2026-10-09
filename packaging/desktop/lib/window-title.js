// SPDX-License-Identifier: GPL-3.0-only
// The window title follows playback, shaped after Feishin's window bar:
// "(Paused) (2 / 34) Song — Artist — WiiJukebox".

const APP_NAME = 'WiiJukebox';

function windowTitle(status) {
    const song = typeof status?.nowPlaying?.title === 'string' ? status.nowPlaying.title.trim() : '';
    if (!status?.source || !song) return APP_NAME;
    const artist = typeof status.nowPlaying.artist === 'string' ? status.nowPlaying.artist.trim() : '';
    const place = status.queue;
    const counted = Number.isInteger(place?.position) && Number.isInteger(place?.total) &&
        place.total > 0 && place.position >= 1 && place.position <= place.total;
    return [
        status.paused ? '(Paused) ' : '',
        counted ? `(${place.position} / ${place.total}) ` : '',
        [song, artist].filter(Boolean).join(' — '),
        ` — ${APP_NAME}`,
    ].join('');
}

/**
 * Asks the server for its status every `intervalMs` and reports the title whenever it changes.
 * `getUrl` returns the server's address, or null when there is nothing to ask (the plain name is shown then).
 */
class TitleFeed {
    constructor({ getUrl, onTitle, intervalMs = 1000, fetchImpl = fetch }) {
        this.getUrl = getUrl;
        this.onTitle = onTitle;
        this.intervalMs = intervalMs;
        this.fetchImpl = fetchImpl;
        this.title = null;
        this.timer = null;
        this.paused = false;
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => this.poll(), this.intervalMs);
        this.timer.unref?.();
        this.poll();
    }

    stop() {
        clearInterval(this.timer);
        this.timer = null;
    }

    /** A window hidden in the tray needs no title, so it is not asked for. */
    pause() {
        this.paused = true;
    }

    resume() {
        this.paused = false;
        this.poll();
    }

    async poll() {
        if (this.paused) return;
        const url = this.getUrl();
        let title = APP_NAME;
        if (url) {
            try {
                const res = await this.fetchImpl(`${url}api/status`, { signal: AbortSignal.timeout(1500) });
                if (res.ok) title = windowTitle(await res.json());
            } catch {
                // A server that is restarting or busy just shows the plain name until it answers.
            }
        }
        if (this.paused || title === this.title) return;
        this.title = title;
        this.onTitle(title);
    }
}

module.exports = { APP_NAME, windowTitle, TitleFeed };
