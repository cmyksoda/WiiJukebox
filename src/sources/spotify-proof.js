// SPDX-License-Identifier: GPL-3.0-only
// The first real-account checks for Spotify, step by step: sign-in, library, receiver, a played song.
// Each step reports pass, fail or skipped with a message that is safe to show.

const TRACK = new RegExp(
    '^(?:spotify:track:|https?://open\\.spotify\\.com/(?:intl-[a-z]+/)?track/)?([A-Za-z0-9]{1,40})(?:[?#].*)?$',
);

function parseTrack(text) {
    return TRACK.exec(String(text || '').trim())?.[1] || null;
}

/**
 * @param {import('./spotify').SpotifySource} source
 * @param {{play?: boolean, track?: string, waitMs?: number}} [options]
 *   `play` also starts the receiver and plays a song
 */
async function runProof(source, { play = false, track = null, waitMs = 30000 } = {}) {
    const steps = [];
    const { api, library } = source;
    let me = null;
    const step = async (name, run) => {
        try {
            const detail = await run();
            steps.push({ name, ok: true, detail: detail || '' });
            return true;
        } catch (err) {
            steps.push({ name, ok: false, detail: api.clean(err.message) });
            return false;
        }
    };
    const skip = (name, detail) => steps.push({ name, ok: null, detail });
    const first = (page) => page.items.find((item) => !item.unavailable);
    const named = (item) => (item ? `${item.title}${item.artist ? ` — ${item.artist}` : ''}` : 'nothing');

    if (!await step('Authenticate', async () => {
        if (source.auth !== 'connected') throw new Error(source.info().web.message);
        me = await api.me();
        return `Signed in as ${me.display_name || me.id}`;
    })) {
        for (const name of ['Read Liked Songs', 'Read one owned playlist', 'Find the receiver']) {
            skip(name, 'Needs a signed-in account');
        }
        if (play) skip('Play a chosen track', 'Needs a signed-in account');
        return steps;
    }

    let liked = null;
    await step('Read Liked Songs', async () => {
        liked = await library.browse({ path: 'liked', offset: 0, limit: 5 });
        if (!liked.total) return 'Liked Songs is empty (like a song to test playing it)';
        return `${liked.total} songs; the first is ${named(first(liked))}`;
    });

    const lists = await api.get('/me/playlists', { limit: 50 }).then((page) => page.items || [], () => []);
    const owned = lists.find((playlist) => playlist.owner?.id === me.id);
    await step('Read one owned playlist', async () => {
        if (!owned) throw new Error('You own no playlist yet; make one in Spotify to test reading it');
        const page = await library.browse({ path: `playlist/${owned.id}`, offset: 0, limit: 5 });
        if (page.unavailable) throw new Error(`"${owned.name}" is not readable by this app`);
        return `"${owned.name}" has ${page.total} items; the first is ${named(first(page))}`;
    });
    const followed = lists.find((playlist) => playlist.owner?.id !== me.id && !playlist.collaborative);
    if (followed) {
        await step('Read a followed playlist (information only)', async () => {
            const page = await library.browse({ path: `playlist/${followed.id}`, offset: 0, limit: 5 });
            return page.unavailable
                ? `"${followed.name}": Spotify hides its tracks from development-mode apps (expected); ` +
                    'it can still be played whole'
                : `"${followed.name}": readable (this app has wider access than development mode)`;
        });
    }

    if (!play) {
        await step('Find the receiver', async () => {
            if (!source.receiverRunning) {
                throw new Error('The receiver is not running. Start it from the WiiJukebox entry in the ' +
                    'Spotify channel, or use Play a test song');
            }
            return describe(await source.findReceiver(waitMs));
        });
        return steps;
    }

    await step('Start the receiver', async () => {
        if (source.receiverRunning) return 'Already running';
        await source.playItem({ id: 'receiver', type: 'station', title: source.deviceName });
        return 'Started';
    });
    const found = await step('Find the receiver', async () => describe(await source.findReceiver(waitMs)));
    if (!found) {
        skip('Play a chosen track', 'Needs the receiver to be visible to Spotify');
        return steps;
    }
    await step('Play a chosen track', async () => {
        const id = track ? parseTrack(track) : null;
        if (track && !id) throw new Error('That is not a Spotify track link, URI or id');
        const pick = id ? { id: `track/${id}`, type: 'track' } : liked && first(liked);
        if (!pick) throw new Error('Name a track to play, or like a song first');
        await source.playItem(pick);
        const state = await api.playerState();
        const bytes = source.pcmBytes;
        if (!state?.is_playing) throw new Error('Spotify does not report it playing');
        return `Playing "${state.item?.name}"; Spotify says it is on ${state.device?.name}, ` +
            `and ${bytes} bytes of audio reached WiiJukebox`;
    });
    await step('Pause and resume', async () => {
        await source.pause();
        await source.play();
        return 'Spotify paused, then played again';
    });
    return steps;
}

const describe = (device) => `Found "${device.name}" (${device.type || 'device'}) on this account`;

module.exports = { runProof, parseTrack };
