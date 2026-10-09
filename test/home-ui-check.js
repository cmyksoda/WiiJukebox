// SPDX-License-Identifier: GPL-3.0-only
// Optional browser check of the home screen (not part of npm test). It starts its own
// server on WIIJUKEBOX_PORT (default 4880) over fake services, so nothing real is touched.
//
//   CHROMIUM=/path/to/chrome node test/home-ui-check.js     (playwright-core must be resolvable)

const fs = require('node:fs');
const path = require('node:path');
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
    const serviceOrigins = [navidrome.url, jellyfin.url, plex.url];
    const direct = [];
    const open = async (viewport, phone) => {
        const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone, deviceScaleFactor: 1 });
        const page = await context.newPage();
        page.on('request', (r) => { if (serviceOrigins.some((origin) => r.url().startsWith(origin))) direct.push(r.url()); });
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
        check('the primary service and the other kinds have their rows', ['Recently added', 'Most played', 'Recently played', 'New episodes', 'Saved stations']
            .every((title) => titles.includes(title)));
        check('the other library services have none', !titles.includes('Latest') && !titles.includes('On Deck'));
        check('the row chip names the primary', (await page.$$eval('.home-from', (nodes) => nodes.map((n) => n.textContent.trim())))
            .filter((name) => /Navidrome|Jellyfin|Plex/.test(name)).every((name) => name === 'Navidrome'));
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
        check('a failing service shows one quiet note', (text.match(/Could not load/g) || []).length === 1 && text.includes('New episodes'));
        navidrome.state.fail = false;
        await page.click('text=Try again');
        await page.waitForSelector('.home-section:has(h3:text("Most played")) .card');
        check('Try again loads it', true);

        // --- the primary service --------------------------------------------------------
        const question = 'Set as primary? This will affect suggestions on the home screen.';
        const dialogText = () => page.textContent('dialog.confirm p');
        const primaryId = async () => (await (await fetch(`${app.base}/api/home/primary`)).json()).id;

        await page.click('.source-btn:has-text("Navidrome")');
        await page.waitForSelector('.category');
        check('the primary shows a badge and no button', (await page.textContent('.primary-row')).trim() === 'Primary'
            && !(await page.isVisible('.primary-row button')));

        await page.click('.source-btn:has-text("Jellyfin")');
        await page.waitForSelector('.primary-row button');
        check('another library offers Set as primary', (await page.textContent('.primary-row button')) === 'Set as primary');
        await page.click('.primary-row button');
        await page.waitForSelector('dialog.confirm[open]');
        check('the dialog asks with Jaxi\'s words', await dialogText() === question);
        check('with Cancel and Set as primary', (await page.$$eval('dialog.confirm button', (b) => b.map((x) => x.textContent))).join() === 'Cancel,Set as primary');
        check('focus starts on Cancel', await page.evaluate(() => document.activeElement.textContent) === 'Cancel');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Tab');
        check('Tab stays inside the dialog', await page.evaluate(() => !!document.activeElement.closest('dialog.confirm')));
        check('the page behind is inert while it is open', await page.evaluate(() => !document.elementFromPoint(5, 5)?.closest('#main')));
        await page.keyboard.press('Escape');
        check('Escape closes it and changes nothing', !(await page.isVisible('dialog.confirm')) && await primaryId() === 'subsonic');
        check('focus returns to the control', await page.evaluate(() => document.activeElement.textContent) === 'Set as primary');
        await page.click('.primary-row button');
        await page.click('dialog.confirm >> text=Cancel');
        check('Cancel closes it and changes nothing', !(await page.isVisible('dialog.confirm')) && await primaryId() === 'subsonic');
        await page.click('.primary-row button');
        await page.mouse.click(4, 4);
        check('a click outside closes it too', !(await page.isVisible('dialog.confirm')) && await primaryId() === 'subsonic');

        await page.click('.primary-row button');
        await page.click('dialog.confirm >> button:text-is("Set as primary")');
        await page.waitForSelector('#primary-badge');
        check('confirming makes it the primary', await primaryId() === 'jellyfin' && (await page.textContent('.primary-row')).trim() === 'Primary');
        check('and the badge takes focus', await page.evaluate(() => document.activeElement.id) === 'primary-badge');

        await page.click('.source-btn:has-text("Navidrome")');
        await page.waitForSelector('.primary-row button');
        check('Navidrome now offers the button', true);
        await page.click('.source-btn.home');
        await page.waitForSelector('.home-section:has(h3:text("Latest")) .card');
        await page.waitForSelector('.home-section:has(h3:text("New episodes")) .card');
        const after = await page.$$eval('.home-section h3', (nodes) => nodes.map((n) => n.textContent));
        check('home now suggests from Jellyfin only', after.includes('Latest') && !after.includes('Recently added')
            && !after.includes('Most played') && after.includes('New episodes'));
        check('its chip says Jellyfin', (await page.$$eval('.home-section:has(h3:text("Latest")) .home-from', (n) => n.map((x) => x.textContent.trim()))).join() === 'Jellyfin');

        // --- clearing Jump back in ----------------------------------------------------------
        await page.click('.home-section:has(h3:text("Latest")) .card >> nth=0');
        await page.waitForSelector('.row');
        await page.click('#back');
        await page.waitForSelector('#home-recent .shelf');
        const historyFile = path.join(app.dir, 'history.json');
        app.web.history.flush();
        check('there is history to clear', JSON.parse(fs.readFileSync(historyFile, 'utf8')).entries.length > 0);
        check('Clear sits beside the heading', (await page.textContent('#home-recent .home-head')).startsWith('Jump back inClear'));
        await page.click('#home-recent button:text("Clear")');
        await page.waitForSelector('dialog.confirm[open]');
        check('the dialog asks before clearing', await dialogText() === 'Clear recently played? This removes everything from Jump back in.');
        check('with Cancel and Clear', (await page.$$eval('dialog.confirm button', (b) => b.map((x) => x.textContent))).join() === 'Cancel,Clear');
        await page.click('dialog.confirm >> text=Cancel');
        check('Cancel keeps it all', await page.isVisible('#home-recent .shelf')
            && JSON.parse(fs.readFileSync(historyFile, 'utf8')).entries.length > 0);
        await page.click('#home-recent button:text("Clear")');
        await page.click('dialog.confirm >> button:text-is("Clear")');
        await page.waitForSelector('#home-recent .shelf', { state: 'detached' });
        check('confirming hides the section', !(await page.isVisible('#home-recent .home-section')));
        check('and empties history.json', JSON.parse(fs.readFileSync(historyFile, 'utf8')).entries.length === 0);
        check('and the server has nothing to offer again', (await (await fetch(`${app.base}/api/home`)).json()).recent.length === 0);
        check('focus stays at the top of the page', await page.evaluate(() => document.activeElement.tagName) === 'H3');

        check('covers came through the proxy, never from a service', direct.length === 0
            && await page.$$eval('img', (imgs) => imgs.every((img) => new URL(img.src).pathname.startsWith('/api/art/'))));

        // The dialog's edges and text stay on whole pixels at 1x, at odd and even widths and on a phone.
        for (const [name, viewport, phone] of [['1281x801', { width: 1281, height: 801 }, false], ['1280x800', { width: 1280, height: 800 }, false],
            ['390x844', { width: 390, height: 844 }, true], ['375x667', { width: 375, height: 667 }, true], ['361x640', { width: 361, height: 640 }, true]]) {
            const view = await open(viewport, phone);
            if (phone) {
                await view.click('#sources-toggle');
                await view.click('.source-btn:has-text("Navidrome")');
            } else await view.click('.source-btn:has-text("Navidrome")');
            await view.waitForSelector('.primary-row button');
            await view.click('.primary-row button');
            await view.waitForSelector('dialog.confirm[open]');
            const box = await view.$eval('dialog.confirm', (el) => {
                const r = el.getBoundingClientRect();
                return [r.left, r.top, r.width, r.height, ...[...el.querySelectorAll('button')].flatMap((b) => {
                    const q = b.getBoundingClientRect();
                    return [q.left, q.top, q.width, q.height];
                })];
            });
            check(`${name}: the dialog sits on whole pixels`, box.every(Number.isInteger));
            const fits = await view.$eval('dialog.confirm', (el) => {
                const r = el.getBoundingClientRect();
                return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
            });
            check(`${name}: and fits the screen`, fits);
            await view.keyboard.press('Escape');
            await view.context().close();
        }
    } finally {
        check('no console errors', errors.length === 0);
        if (errors.length) console.log(errors.join('\n'));
        await browser.close();
        await app.close();
        await Promise.all([navidrome.close(), jellyfin.close(), plex.close(), pods.close()]);
    }
    process.exit(failed ? 1 : 0);
})();
