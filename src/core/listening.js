// SPDX-License-Identifier: GPL-3.0-only
// Reports listening to the source that is playing, so services that keep play
// history (and forward it to Last.fm or ListenBrainz) see WiiJukebox like any player.

const { BYTES_PER_SECOND } = require('./format');

// Last.fm's rule: a track over 30 s counts once half of it, or 4 minutes, was heard.
const MIN_TRACK_SECONDS = 30;
const MAX_LISTEN_SECONDS = 240;

class Listening {
    constructor({ warn = () => {} } = {}) {
        this._warn = warn;
        this._play = null;
    }

    /** `source` opened `track`; anything still playing has stopped. */
    start(source, track) {
        this.stop();
        if (source && track) this._play = { source, track, heard: 0, position: 0, startedAt: null, played: false };
    }

    /** `bytes` of the current track's audio reached the stream, ending at `position` seconds. */
    heard(bytes, position) {
        const play = this._play;
        if (!play) return;
        if (play.startedAt === null) {
            play.startedAt = Date.now();
            this._report(play, 'reportPlaying', { startedAt: play.startedAt });
        }
        play.heard += bytes / BYTES_PER_SECOND;
        play.position = position;
        const duration = Number(play.track.duration) || 0;
        const needed = duration > 0 ? Math.min(duration / 2, MAX_LISTEN_SECONDS) : MAX_LISTEN_SECONDS;
        if (!play.played && (!duration || duration > MIN_TRACK_SECONDS) && play.heard >= needed) {
            play.played = true;
            this._report(play, 'reportPlayed', { startedAt: play.startedAt });
        }
    }

    /** The current track stopped, was skipped or was replaced. */
    stop() {
        const play = this._play;
        this._play = null;
        if (play && play.startedAt !== null) {
            this._report(play, 'reportStopped', { position: play.position, played: play.played });
        }
    }

    _report(play, method, details) {
        if (typeof play.source[method] !== 'function') return;
        // Play history is a courtesy to the service; it must never disturb playback.
        Promise.resolve()
            .then(() => play.source[method](play.track, details))
            .catch((err) => this._warn(`${play.source.id}: could not report listening (${err.message})`));
    }
}

module.exports = { Listening, MIN_TRACK_SECONDS, MAX_LISTEN_SECONDS };
