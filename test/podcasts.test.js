// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { PodcastsSource, parseFeed, parseDuration } = require('../src/sources/podcasts');
const { Config } = require('../src/config');
const { Pipeline } = require('../src/core/pipeline');
const { SourceRegistry } = require('../src/sources');
const { WebServer } = require('../src/web/server');
const { waitFor } = require('./helpers/fake-binary');
const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <image><url>https://example.test/logo.png</url><title>Logo title</title></image>
  <title>Fixture &amp; Friends</title>
  <itunes:author>The Hosts</itunes:author>
  <description><![CDATA[<p>A show about <b>things</b> &amp; stuff.</p>]]></description>
  <itunes:image href="https://example.test/show.jpg"/>
  <item>
    <title><![CDATA[Ben & Jerry's: episode one]]></title>
    <guid isPermaLink="false">g-1</guid>
    <pubDate>Mon, 01 Jan 2024 08:00:00 GMT</pubDate>
    <itunes:duration>45:30</itunes:duration>
    <itunes:image href="https://example.test/ep1.jpg"/>
    <enclosure url="https://cdn.example.test/one.mp3?a=1&amp;b=2" length="1000" type="audio/mpeg"/>
  </item>
  <item>
    <title>Caf&#xE9; &amp; &#8217;quotes&#8217;</title>
    <pubDate>Mon, 05 Feb 2024 08:00:00 +0000</pubDate>
    <itunes:duration>1:02:03</itunes:duration>
    <enclosure url="https://cdn.example.test/two.m4a" type="audio/mp4"/>
  </item>
  <item>
    <title>Newest, no mime type</title>
    <pubDate>Fri, 01 Mar 2024 08:00:00 GMT</pubDate>
    <itunes:duration>3600</itunes:duration>
    <enclosure url="https://cdn.example.test/three.m4a?token=x" length="5"/>
  </item>
  <item>
    <title>Video only</title>
    <pubDate>Sat, 02 Mar 2024 08:00:00 GMT</pubDate>
    <enclosure url="https://cdn.example.test/video.mp4" type="video/mp4"/>
  </item>
  <item><title>No enclosure</title><pubDate>Sun, 03 Mar 2024 08:00:00 GMT</pubDate></item>
  <item><title>Cut off mid-feed</title><enclosure url="https://cdn.example.test/cut.mp3" type="audio/mpeg"/>`;

const APPLE_ART = 'https://is1-ssl.mzstatic.com/image/thumb/Podcasts/v4/aa/bb/mza_1.jpg';

async function withServer(handler, work) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try { await work(`http://127.0.0.1:${server.address().port}`); }
    finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

/** Answers Apple's endpoints from fixtures and lets feed URLs reach the local fixture server. */
function fakeApple(feedUrl, log = []) {
    return async (url, init) => {
        const target = new URL(url);
        if (target.hostname === '127.0.0.1') return fetch(url, init);
        log.push({ url: String(url), headers: init?.headers });
        const reply = (body) => ({ ok: true, status: 200, json: async () => body });
        if (target.pathname === '/search') {
            return reply({ results: [
                { collectionName: 'Fixture & Friends', artistName: 'The Hosts', feedUrl, artworkUrl100: `${APPLE_ART}/100x100bb.jpg`,
                    artworkUrl600: `${APPLE_ART}/600x600bb.jpg` },
                { collectionName: 'No feed', artistName: 'Nobody' },
                { collectionName: 'Bad feed', feedUrl: 'ftp://example.test/feed' },
            ] });
        }
        if (target.pathname.endsWith('/podcasts.json')) {
            return reply({ feed: { results: [{ id: '11' }, { id: '22' }, { id: '33' }, { id: 'abc' }] } });
        }
        if (target.pathname === '/lookup') {
            return reply({ results: [
                { collectionId: 33, collectionName: 'Third', feedUrl: `${feedUrl}?c` },
                { collectionId: 11, collectionName: 'First', feedUrl: `${feedUrl}?a`, artworkUrl100: `${APPLE_ART}/100x100bb.png` },
            ] });
        }
        return { ok: false, status: 404, json: async () => ({}) };
    };
}

const feedServer = (requests) => (req, res) => {
    requests.push({ url: req.url, agent: req.headers['user-agent'] });
    if (req.url === '/moved') { res.writeHead(302, { Location: '/feed.xml' }); return res.end(); }
    if (req.url.startsWith('/feed.xml')) {
        res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
        return res.end(`${FEED}</channel></rss>`);
    }
    if (req.url === '/big.xml') {
        res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
        res.on('error', () => {});
        const item = '<item><title>Filler episode</title><enclosure url="https://cdn.example.test/f.mp3" type="audio/mpeg"/>'
            + `<description>${'x'.repeat(200)}</description></item>\n`;
        res.write('<rss><channel><title>Huge</title>\n');
        const block = item.repeat(2000);
        let sent = 0;
        const push = () => {
            while (sent < 10 * 1024 * 1024) {
                sent += block.length;
                if (!res.write(block)) return res.once('drain', push);
            }
            res.end('</channel></rss>');
        };
        return push();
    }
    if (req.url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html><body>Hi</body></html>'); }
    res.writeHead(404);
    return res.end();
};

test('durations accept seconds, M:SS and H:MM:SS and refuse anything else', () => {
    assert.equal(parseDuration('90'), 90);
    assert.equal(parseDuration('1:30'), 90);
    assert.equal(parseDuration(' 01:02:03 '), 3723);
    assert.equal(parseDuration('1:02:03.5'), 3724);
    for (const bad of ['', 'abc', '0', '1:2:3:4', undefined]) assert.equal(parseDuration(bad), null);
});

test('feeds parse CDATA, entities and attributes, keep audio only, and sort newest first', () => {
    const feed = parseFeed(`${FEED}</channel></rss>`);
    assert.equal(feed.title, 'Fixture & Friends');
    assert.equal(feed.author, 'The Hosts');
    assert.equal(feed.description, 'A show about things & stuff.');
    assert.equal(feed.artwork, 'https://example.test/show.jpg');
    assert.deepEqual(feed.episodes.map((e) => e.title), [
        'Newest, no mime type', 'Café & ’quotes’', "Ben & Jerry's: episode one"]);
    const [newest, middle, oldest] = feed.episodes;
    assert.equal(newest.url, 'https://cdn.example.test/three.m4a?token=x');
    assert.equal(newest.duration, 3600);
    assert.equal(middle.duration, 3723);
    assert.equal(middle.id, 'https://cdn.example.test/two.m4a');
    assert.equal(oldest.url, 'https://cdn.example.test/one.mp3?a=1&b=2');
    assert.equal(oldest.id, 'g-1');
    assert.equal(oldest.artwork, 'https://example.test/ep1.jpg');
    assert.equal(oldest.published, Date.UTC(2024, 0, 1, 8));
});

test('a feed without a channel is refused and one without items is simply empty', () => {
    assert.throws(() => parseFeed('<html><body>Not a feed</body></html>'), /not an RSS podcast feed/);
    const empty = parseFeed('<rss><channel><title>Quiet</title><image><url>https://example.test/l.png</url></image></channel></rss>');
    assert.deepEqual([empty.title, empty.episodes.length, empty.artwork], ['Quiet', 0, 'https://example.test/l.png']);
});

test('feeds are fetched politely, follow redirects, are cached, and oversized or non-feed replies degrade', async () => {
    const requests = [];
    await withServer(feedServer(requests), async (base) => {
        const source = new PodcastsSource({}, { fetch: fakeApple(`${base}/feed.xml`) });
        const page = await source.browse({ path: `show/${base}/moved`, limit: 2 });
        assert.equal(page.total, 3);
        assert.equal(page.items.length, 2);
        assert.ok(requests.every((r) => /^WiiJukebox\//.test(r.agent)), 'identifies itself');
        const before = requests.length;
        await source.browse({ path: `show/${base}/moved`, offset: 2, limit: 2 });
        assert.equal(requests.length, before, 'second page comes from the cache');

        const big = await source.browse({ path: `show/${base}/big.xml`, limit: 5 });
        assert.equal(big.show.title, 'Huge');
        assert.ok(big.total > 1000 && big.total < 40000, `read ${big.total} episodes before the size cap`);

        await assert.rejects(source.browse({ path: `show/${base}/page` }), /not an RSS podcast feed/);
        await assert.rejects(source.browse({ path: `show/${base}/nope` }), /could not load the feed \(HTTP 404\)/);
        await assert.rejects(source.browse({ path: 'show/file:///etc/passwd' }), /HTTP\(S\)/);
        await assert.rejects(source.browse({ path: 'show/http://user:pw@example.test/f' }), /credentials/);
    });
});

test('search and the chart resolve feeds through Apple, drop unusable rows and track subscriptions', async () => {
    const log = [];
    const feedUrl = 'https://feeds.example.test/fixture';
    const source = new PodcastsSource({}, { fetch: fakeApple(feedUrl, log) });
    const saved = [];
    source.on('config', (patch) => saved.push(patch));

    const found = await source.search('fixture');
    const query = new URL(log[0].url).searchParams;
    assert.deepEqual([query.get('media'), query.get('entity'), query.get('term'), query.get('country')],
        ['podcast', 'podcast', 'fixture', 'us']);
    assert.equal(found.total, 1);
    assert.deepEqual({ ...found.items[0] }, {
        id: `show/${feedUrl}`, type: 'folder', title: 'Fixture & Friends', subtitle: 'The Hosts',
        artwork: `${APPLE_ART}/400x400bb.jpg`, feedUrl, subscribed: false,
    });
    assert.deepEqual((await source.search('   ')).items, []);

    const top = await source.browse({ path: 'top' });
    assert.deepEqual(top.items.map((i) => i.title), ['First', 'Third'], 'chart order, missing feeds dropped');
    assert.equal(top.items[0].artwork, `${APPLE_ART}/400x400bb.png`);
    await source.browse({ path: 'top' });
    assert.equal(log.filter((c) => c.url.includes('podcasts.json')).length, 1, 'chart is cached');

    const added = await source.action('subscribe', { feedUrl, title: 'Fixture & Friends', author: 'The Hosts', artwork: `${APPLE_ART}/400x400bb.jpg` });
    assert.equal(added.subscriptions.length, 1);
    assert.equal(added.subscriptions[0].subscribed, true);
    await source.action('subscribe', { feedUrl, title: 'Renamed', author: '', artwork: 'javascript:alert(1)' });
    assert.equal(source.config.subscriptions.length, 1, 'subscribing twice keeps one entry');
    assert.equal(source.config.subscriptions[0].artwork, '', 'only web images are kept');
    assert.equal((await source.search('fixture')).items[0].subscribed, true);
    await source.action('subscribe', { feedUrl: `${feedUrl}?a`, title: 'First' });
    const flagged = await source.browse({ path: 'top' });
    assert.deepEqual(flagged.items.map((i) => i.subscribed), [true, false], 'the cached chart still shows current subscriptions');
    assert.equal(log.filter((c) => c.url.includes('podcasts.json')).length, 1);
    assert.deepEqual((await source.browse()).items.map((i) => [i.title, i.subtitle]),
        [['Subscriptions', '2 shows'], ['Top shows', 'Apple Podcasts chart']]);

    await source.action('unsubscribe', { feedUrl: `${feedUrl}?a` });
    assert.equal((await source.action('unsubscribe', { feedUrl })).subscriptions.length, 0);
    assert.deepEqual(saved.at(-1), { subscriptions: [] });
    await assert.rejects(source.action('subscribe', { feedUrl: 'ftp://example.test/x' }), /HTTP\(S\)/);
    await assert.rejects(source.action('explode', {}), /unknown podcast action/);
});

test('subscribing by bare feed address reads the title from the feed; pasted addresses search that feed', async () => {
    await withServer(feedServer([]), async (base) => {
        const source = new PodcastsSource({}, { fetch: fakeApple('unused') });
        const { items } = await source.search(`${base}/feed.xml`);
        assert.deepEqual([items.length, items[0].title, items[0].subtitle, items[0].artwork], [1, 'Fixture & Friends', 'The Hosts', 'https://example.test/show.jpg']);
        await source.action('subscribe', { feedUrl: `${base}/feed.xml` });
        await source.action('subscribe', { feedUrl: `${base}/moved`, title: 'aardvark show' });
        const list = await source.browse({ path: 'subscriptions' });
        assert.deepEqual(list.items.map((i) => i.title), ['aardvark show', 'Fixture & Friends'], 'listed alphabetically');
    });
});

test('episodes list newest first with dates and durations, and a page past the end is empty', async () => {
    await withServer(feedServer([]), async (base) => {
        const source = new PodcastsSource({ subscriptions: [{ feedUrl: `${base}/feed.xml`, title: 'Saved', author: 'Me', artwork: 'https://example.test/saved.jpg' }] },
            { fetch: fakeApple('unused') });
        const page = await source.browse({ path: `show/${base}/feed.xml`, offset: 0, limit: 12 });
        assert.deepEqual(page.items.map((i) => [i.type, i.subtitle]), [
            ['track', 'Mar 1, 2024 · 1:00:00'], ['track', 'Feb 5, 2024 · 1:02:03'], ['track', 'Jan 1, 2024 · 45:30']]);
        assert.equal(page.items[0].artist, 'Fixture & Friends');
        assert.equal(page.items[0].artwork, 'https://example.test/saved.jpg', 'falls back to the saved show artwork');
        assert.equal(page.items[2].artwork, 'https://example.test/ep1.jpg', 'episode artwork wins');
        assert.equal(page.items[2].published, '2024-01-01T08:00:00.000Z');
        assert.equal(page.show.subscribed, true);
        assert.equal((await source.browse({ path: `show/${base}/feed.xml`, offset: 3 })).items.length, 0);
        await assert.rejects(source.browse({ offset: -1 }), /invalid library page/);
        await assert.rejects(source.browse({ path: 'nowhere' }), /unknown browse path/);
    });
});

test('an episode opens as a seekable URI with its duration and artwork, and nothing follows it', async () => {
    const source = new PodcastsSource({}, {});
    const metadata = [];
    source.on('metadata', (meta) => metadata.push(meta));
    const handle = await source.open({ type: 'track', title: 'Episode', artist: 'Show', duration: 1800,
        artwork: 'https://example.test/a.jpg', url: 'https://cdn.example.test/e.mp3?x=1' });
    assert.equal(handle.type, 'uri');
    assert.equal(handle.uri, 'https://cdn.example.test/e.mp3?x=1');
    assert.equal(handle.seekable, true);
    assert.match(handle.headers['User-Agent'], /^WiiJukebox\//);
    assert.deepEqual(metadata.at(-1), { title: 'Episode', artist: 'Show', album: '', artwork: 'https://example.test/a.jpg', duration: 1800 });
    assert.equal(source.state, 'playing');
    assert.equal(await source.advance(1), null);
    assert.equal(source.capabilities.next, undefined);
    await assert.rejects(source.open({ type: 'folder', title: 'A show' }), /choose an episode/);
    await assert.rejects(source.open({ url: 'file:///etc/passwd' }), /HTTP\(S\)/);
    await source.close();
    assert.equal(source.state, 'ready');
});

/** Serves a generated tone with byte-range support, like a podcast CDN. */
async function withTone(seconds, work) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wiijukebox-podcast-'));
    const file = path.join(tmp, 'tone.wav');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}:sample_rate=22050`, '-ac', '1', file]);
    const wav = await fs.readFile(file);
    const seen = [];
    const handler = (req, res) => {
        seen.push({ agent: req.headers['user-agent'], range: req.headers.range });
        const [, start] = /bytes=(\d+)-/.exec(req.headers.range || '') || [];
        const from = Number(start || 0);
        res.writeHead(start ? 206 : 200, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes',
            'Content-Length': wav.length - from, ...(start && { 'Content-Range': `bytes ${from}-${wav.length - 1}/${wav.length}` }) });
        res.on('error', () => {});
        res.end(wav.subarray(from));
    };
    try { await withServer(handler, (base) => work(base, seen)); }
    finally { await fs.rm(tmp, { recursive: true, force: true }); }
}

function silentPipeline() {
    const pipeline = new Pipeline();
    pipeline.pacer._write = () => true;
    pipeline.pacer.start();
    return pipeline;
}

test('episodes stream over HTTP, identify themselves to the host, and seek by range', { timeout: 30000 }, async () => {
    const pipeline = silentPipeline();
    try {
        await withTone(8, async (base, seen) => {
            await pipeline.attach(new PodcastsSource({}, {}), { type: 'track', title: 'Tone', artist: 'Show', duration: 8, url: `${base}/tone.wav` });
            await pipeline.waitForAudio();
            assert.equal(pipeline.status.capabilities.seek, true);
            assert.equal(pipeline.status.nowPlaying.duration, 8);
            assert.equal(await pipeline.seek(4), 4);
            await pipeline.waitForAudio();
            await sleep(300);
            assert.ok(seen.every((entry) => /^WiiJukebox\//.test(entry.agent)), 'ffmpeg sends the polite agent');
            assert.ok(seen.some((entry) => entry.range && !entry.range.startsWith('bytes=0-')), 'the seek asked for a later byte range');
        });
    } finally {
        await pipeline.shutdown();
    }
});

test('a finished episode ends playback instead of starting another', { timeout: 30000 }, async () => {
    const pipeline = silentPipeline();
    pipeline.on('track-ended', (event) => pipeline.advanceEnded(event));
    try {
        await withTone(1, async (base) => {
            await pipeline.attach(new PodcastsSource({}, {}), { type: 'track', title: 'Short', duration: 1, url: `${base}/tone.wav` });
            await waitFor(() => pipeline.activeSource === null, 10000);
            assert.equal(pipeline.status.nowPlaying.title, '');
        });
    } finally {
        await pipeline.shutdown();
    }
});

test('the web API and the Wii protocol browse subscriptions to episodes and play one', async () => {
    const config = new Config('/unused-test-config');
    config.save = () => {};
    await withServer(feedServer([]), async (base) => {
        const registry = new SourceRegistry(config, { fetch: fakeApple(`${base}/feed.xml`) });
        const pipeline = new Pipeline();
        const web = new WebServer({ config, registry, pipeline });
        const address = await web.listen(0, '127.0.0.1');
        const url = `http://127.0.0.1:${address.port}`;
        try {
            const post = (route, body) => fetch(`${url}${route}`, { method: 'POST', body: JSON.stringify(body) });
            const wii = async (query) => (await (await fetch(`${url}/api/wii/${query}`)).text())
                .trim().split('\n').slice(1).map((line) => line.split('\t').map(decodeURIComponent));

            const sources = (await wii('sources')).map((row) => row[1]);
            assert.equal(sources[sources.indexOf('radio') + 1], 'podcasts', 'the tile sits right after Internet Radio');

            const subscribed = await post('/api/sources/podcasts/action/subscribe', { feedUrl: `${base}/feed.xml`, title: 'Fixture', author: 'Hosts' });
            assert.equal((await subscribed.json()).subscriptions.length, 1);
            assert.equal(config.sourceConfig('podcasts').subscriptions.length, 1, 'saved through the registry');
            const settings = await (await fetch(`${url}/api/sources/podcasts/settings`)).json();
            assert.equal('subscriptions' in settings.values, false);
            assert.equal((await post('/api/sources/podcasts/action/subscribe', { feedUrl: 'ftp://nope' })).status, 400);

            const root = await wii('browse?source=podcasts');
            assert.deepEqual(root[0], ['page', '0', '2']);
            assert.deepEqual(root.slice(1).map((row) => row.slice(2)),
                [['folder', 'Subscriptions', '1 show'], ['folder', 'Top shows', 'Apple Podcasts chart']]);
            const shows = await wii(`browse?source=podcasts&ref=${root[1][1]}`);
            assert.deepEqual(shows[1].slice(2), ['folder', 'Fixture', 'Hosts']);
            const episodes = await wii(`browse?source=podcasts&ref=${shows[1][1]}`);
            assert.deepEqual(episodes[0], ['page', '0', '3']);
            assert.deepEqual(episodes[1].slice(2), ['track', 'Newest, no mime type', 'Mar 1, 2024 · 1:00:00']);

            const attached = [];
            pipeline.attach = async (source, item) => { attached.push([source.id, item]); };
            pipeline.waitForAudio = async () => {};
            const accepted = await fetch(`${url}/api/wii/play?source=podcasts&ref=${episodes[2][1]}`, { method: 'POST' });
            assert.equal(accepted.status, 200);
            await sleep(50);
            assert.equal(attached.length, 1);
            assert.equal(attached[0][0], 'podcasts');
            assert.equal(attached[0][1].url, 'https://cdn.example.test/two.m4a');
            assert.equal(attached[0][1].startId, undefined, 'a single episode, not a queue');

            const removed = await post('/api/sources/podcasts/action/unsubscribe', { feedUrl: `${base}/feed.xml` });
            assert.equal((await removed.json()).subscriptions.length, 0);
        } finally {
            web.close();
            await pipeline.shutdown();
            await registry.disconnectAll();
        }
    });
});
