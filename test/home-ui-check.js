// SPDX-License-Identifier: GPL-3.0-only
// Optional browser check of the home screen (not part of npm test). It starts its own
// server on WIIJUKEBOX_PORT (default 4880) over fake services, so nothing real is touched.
//
//   CHROMIUM=/path/to/chrome node test/home-ui-check.js     (playwright-core must be resolvable)

const { chromium } = require('playwright-core');
const { fakeSubsonic, fakeJellyfin, fakePlex, fakePodcasts } = require('./helpers/fake-services');
const { harness } = require('./helpers/app-harness');

let failed = 0;
const check = (label, ok) => {
    console.log(ok ? 'ok  ' : 'FAIL', label);
    if (!ok) failed++;
};

(async () => {
    const navidrome = await fakeSubsonic();
    const jellyfin = await fakeJellyfin();
    const plex = await fakePlex();
    const pods = await fakePodcasts();
    const app = await harness({
        subsonic: navidrome.config, jellyfin: jellyfin.config, plex: plex.config,
        podcasts: { subscriptions: [{ feedUrl: pods.feeds.morning, title: 'Morning Pages', author: 'Team' }] },
        radio: { stations: [{ id: 's1', name: 'Groove Salad', url: `${pods.url}/episode.wav` }] },
    }, { port: Number(process.env.WIIJUKEBOX_PORT || 4880) });

    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox', '--mute-audio'] });
    const errors = [];
    const open = async (viewport, phone) => {
        const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone });
        const page = await context.newPage();
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(app.base);
        await page.waitForSelector('.channel');
        await page.waitForFunction(() => !document.querySelector('#home-rows').textContent.includes('Loading'));
        return page;
    };
    const flat = (page) => page.evaluate(() =>
        [document.documentElement.scrollWidth <= innerWidth, document.querySelector('#main').scrollWidth <= document.querySelector('#main').clientWidth]);

    try {
        for (const [name, viewport] of [['390x844', { width: 390, height: 844 }], ['360x640', { width: 360, height: 640 }]]) {
            const page = await open(viewport, true);
            check(`${name}: no sideways page scroll`, (await flat(page)).every(Boolean));
            const shelf = await page.evaluate(() => {
                const row = document.querySelector('.shelf');
                return row.scrollWidth > row.clientWidth && getComputedStyle(row).overflowX === 'auto';
            });
            check(`${name}: a row scrolls sideways inside itself`, shelf);
            await page.context().close();
        }

        const page = await open({ width: 1280, height: 900 }, false);
        const titles = await page.$$eval('.home-section h3', (nodes) => nodes.map((n) => n.textContent));
        check('every configured service has its rows', ['Recently added', 'Most played', 'Recently played', 'Latest', 'On Deck', 'New episodes', 'Saved stations']
            .every((title) => titles.includes(title)));
        check('there is no Jump back in before anything was played', !titles.includes('Jump back in'));
        check('rows end with All channels', titles.at(-1) === 'All channels');
        // Covers below the fold are lazy, so only the ones in view need to have arrived.
        check('art comes through the proxy only', await page.$$eval('.home-section img', (imgs) =>
            imgs.length > 10 && imgs.every((img) => new URL(img.src).pathname.startsWith('/api/art/')) && imgs[0].naturalWidth > 0));

        await page.click('button[aria-label="Play Paper Lanterns"]');
        await page.waitForFunction(() => document.querySelector('#mini-title').textContent !== 'Nothing playing', null, { timeout: 15000 });
        check('the round button plays the album', await page.textContent('#mini-title') === 'One');
        await page.waitForSelector('#home-recent .shelf .card');
        check('and it appears under Jump back in', (await page.textContent('#home-recent .card .t')) === 'Paper Lanterns');

        await page.click('.home-section:has(h3:text("Recently added")) .card:has-text("Low Tide Radio")');
        await page.waitForSelector('.row');
        check('tapping an album opens it with Back available', await page.isVisible('#back') && (await page.textContent('#crumb')) === 'Low Tide Radio');
        const request = page.waitForRequest((r) => r.url().endsWith('/api/sources/subsonic/play'));
        await page.click('.row >> nth=2');
        const body = JSON.parse((await request).postData());
        check('a track click sends the album with the track to start at',
            body.type === 'album' && body.id === 'album/n2' && body.startId === 'n2-t3' && body.startIndex === 2);
        await page.waitForFunction(() => document.querySelector('#mini-title').textContent === 'Three', null, { timeout: 15000 });
        const queue = app.registry.get('subsonic').queue;
        check('the whole album is queued from that track', queue.items.length === 4 && queue.index === 2);

        await page.click('#back');
        await page.waitForSelector('#home-recent .shelf');
        check('Back returns to home', (await page.textContent('#crumb')) === 'Home');
        check('the album just started leads Jump back in', (await page.textContent('#home-recent .card .t')) === 'Low Tide Radio');

        await page.click('.source-btn:has-text("Internet Radio")');
        await page.waitForSelector('#radio-url');
        await page.click('#home-link');
        check('the logo returns home from a channel', (await page.textContent('#crumb')) === 'Home');
        await page.click('.source-btn:has-text("Plex")');
        await page.waitForSelector('.category');
        await page.click('.source-btn.home');
        check('so does the Home entry in the sidebar', (await page.textContent('#crumb')) === 'Home');

        await page.focus('#home-recent .card');
        await page.keyboard.press('Tab');
        check('cards take keyboard focus in order', await page.evaluate(() => document.activeElement.classList.contains('play-all')
            || document.activeElement.classList.contains('card')));
        await page.focus('#home-recent .card >> nth=1');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('#toast').textContent.startsWith('Playing'));
        check('Enter replays a card', true);

        navidrome.state.fail = true;
        app.web.home.forget('subsonic');
        await page.click('#home-link');
        await page.waitForFunction(() => document.querySelector('#home-rows').textContent.includes('Could not load'));
        const text = await page.textContent('#home-rows');
        check('a failing service shows one quiet note', (text.match(/Could not load/g) || []).length === 1 && text.includes('Latest'));
        navidrome.state.fail = false;
        await page.click('text=Try again');
        await page.waitForSelector('.home-section:has(h3:text("Most played")) .card');
        check('Try again loads it', true);
    } finally {
        check('no console errors', errors.length === 0);
        if (errors.length) console.log(errors.join('\n'));
        await browser.close();
        await app.close();
        await Promise.all([navidrome.close(), jellyfin.close(), plex.close(), pods.close()]);
    }
    process.exit(failed ? 1 : 0);
})();
