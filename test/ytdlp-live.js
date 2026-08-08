// Live test for the yt-dlp source.
//
// Deliberately *not* part of `npm run smoke`. That test's whole value is that
// it is hermetic -- real ffmpeg, generated tones, no network -- so it can be
// trusted to fail only when the pipeline is genuinely broken. This one needs
// working yt-dlp, a working network and YouTube being up, so a failure here
// does not necessarily mean the code is wrong. Run it with `npm run test:ytdlp`
// when touching src/sources/ytdlp.js.
//
// The last check is the one that matters: a resolved URL really does decode
// through the pipeline and come out the other side as MP3.

const { Pipeline } = require('../src/core/pipeline');
const { YtdlpSource } = require('../src/sources/ytdlp');

// "Me at the zoo" -- 19 seconds, the oldest video on the site, and about as
// unlikely to disappear as anything on YouTube gets.
const SHORT_VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const PLAYLIST = 'https://www.youtube.com/playlist?list=PLOzDu-MXXLliO9fBNZOQTBDddoA3FzZUo';

let failures = 0;
function check(label, ok, detail = '') {
    const mark = ok ? '  ok  ' : ' FAIL ';
    console.log(`[${mark}] ${label}${detail ? ` -- ${detail}` : ''}`);
    if (!ok) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    console.log('\n=== yt-dlp source, live ===\n');

    const source = new YtdlpSource({});
    const warnings = [];
    source.on('warning', (m) => warnings.push(m));

    // --- it can find yt-dlp at all ------------------------------------------

    try {
        await source.connect();
    } catch (err) {
        console.error(`\ncannot run this test: ${err.message}\n`);
        process.exit(1);
    }
    check('connect() finds yt-dlp', source.state === 'ready', `version ${source._version}`);

    // --- search --------------------------------------------------------------

    const results = await source.search('lofi hip hop');
    check('search returns results', results.items.length > 0, `${results.items.length} items`);
    check(
        'every result is a playable link',
        results.items.length > 0 && results.items.every((i) => /^https?:\/\//.test(i.id)),
    );
    check(
        'every result has a title',
        results.items.length > 0 && results.items.every((i) => i.title && i.title.trim()),
    );
    // Regression: flat entries carry the *listing's* playlist_count, so trusting
    // that field labelled every single search result a playlist.
    check(
        'results are tracks, not playlists',
        results.items.length > 0 && results.items.every((i) => i.type === 'track'),
    );

    // A pasted link must come straight back rather than being searched for, and
    // must not extract -- search runs on every pause in typing.
    const started = Date.now();
    const pasted = await source.search(SHORT_VIDEO);
    const pastedMs = Date.now() - started;
    check(
        'a pasted link is passed through, not searched',
        pasted.items.length === 1 && pasted.items[0].id === SHORT_VIDEO,
    );
    check('...and does so without extracting', pastedMs < 500, `${pastedMs}ms`);

    // --- a single track ------------------------------------------------------

    const metadata = [];
    source.on('metadata', (m) => metadata.push(m));

    const handle = await source.open({ id: SHORT_VIDEO, type: 'track' });
    check('open() returns a uri handle', handle && handle.type === 'uri');
    check('...pointing at real media', Boolean(handle.uri && /^https?:\/\//.test(handle.uri)));
    check(
        '...carrying the headers the URL was signed for',
        Boolean(handle.headers && handle.headers['User-Agent']),
    );

    const meta = metadata[metadata.length - 1] || {};
    check('metadata has a title', Boolean(meta.title), JSON.stringify(meta.title));
    check('metadata has an artist', Boolean(meta.artist), JSON.stringify(meta.artist));
    check('metadata has the duration', meta.duration === 19, `${meta.duration}s`);
    check('metadata has artwork', Boolean(meta.artwork));

    // --- the actual proof: it decodes -----------------------------------------

    const pipeline = new Pipeline({ station: { name: 'YtdlpTest', mount: '/stream' } });
    const pipeWarnings = [];
    pipeline.on('warning', (m) => pipeWarnings.push(m));

    let encodedBytes = 0;
    pipeline.encoder.on('data', (chunk) => {
        encodedBytes += chunk.length;
    });

    pipeline.start();
    await pipeline.attach(source, { id: SHORT_VIDEO, type: 'track' });

    // The pacer runs in real time, so this cannot be hurried.
    await sleep(6000);

    // 128 kbps is 16 kB/s, so six seconds is ~96 kB. Assert well under that:
    // the point is that audio flowed, not that the clock is exact.
    check(
        'the resolved stream decodes and encodes',
        encodedBytes > 16000,
        `${(encodedBytes / 1024).toFixed(0)} kB of MP3`,
    );
    check(
        'no decode warnings',
        !pipeWarnings.some((w) => /decode failed|no audio/i.test(w)),
        pipeWarnings.join('; ') || 'none',
    );

    await pipeline.detach();

    // --- a playlist becomes a queue -------------------------------------------

    const first = await source.open({ id: `list/${PLAYLIST}`, type: 'playlist' });
    check('a playlist link plays', Boolean(first && first.uri));
    check('...and fills the queue', source.queue.items.length > 1, `${source.queue.items.length} tracks`);
    check('...starting at the top', source.queue.index === 0);
    check('...exposing next/previous', source.capabilities.next === true);

    const second = await source.next();
    check('next() advances', Boolean(second && second.uri) && source.queue.index === 1);

    const back = await source.previous();
    check('previous() goes back', Boolean(back && back.uri) && source.queue.index === 0);

    check('previous() at the top stops', (await source.previous()) === null);

    // --- a channel, which nests --------------------------------------------

    // A channel expands into tabs, each of which is itself a list, so this only
    // plays if a queue entry that turns out to be a list gets flattened rather
    // than treated as a broken track.
    const channel = await source.open({ id: 'https://www.youtube.com/@LofiGirl', type: 'track' });
    check('a channel link plays', Boolean(channel && channel.uri));
    check(
        '...flattened down to videos',
        source.queue.items.length > 1,
        `${source.queue.items.length} tracks`,
    );

    // --- browsing a link ------------------------------------------------------

    const listing = await source.browse({ path: `list/${PLAYLIST}`, limit: 5 });
    check('browse() expands a link', listing.items.length === 5, `of ${listing.total}`);
    check('...as tracks', listing.items.every((i) => i.type === 'track'));

    // --- failure modes --------------------------------------------------------

    let rejected = null;
    try {
        await source.open({ id: 'https://www.youtube.com/watch?v=ZZZZnotreal', type: 'track' });
    } catch (err) {
        rejected = err.message;
    }
    check('a dead link fails with a readable message', Boolean(rejected), rejected || 'did not fail');
    check(
        '...without yt-dlp boilerplate',
        !rejected || !/please report this issue/i.test(rejected),
    );

    let refused = null;
    try {
        await source.open({ id: 'file:///etc/passwd', type: 'track' });
    } catch (err) {
        refused = err.message;
    }
    check('non-web links are refused', Boolean(refused && /not a web link/i.test(refused)), refused);

    await source.close();
    await pipeline.shutdown();

    console.log(`\n${failures ? `${failures} failed` : 'all checks passed'}\n`);
    process.exit(failures ? 1 : 0);
}

main().catch((err) => {
    console.error('\ntest crashed:', err);
    process.exit(1);
});
