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

        // --- Light, Dark or System ----------------------------------------------------------
        const backdrop = (view) => view.evaluate(() => getComputedStyle(document.body).backgroundColor);
        const LIGHT = 'rgb(243, 246, 249)';
        const DARK = 'rgb(13, 20, 28)';
        const choices = (view) => view.$$eval('[data-theme-choice]', (nodes) => nodes.map((n) => `${n.dataset.themeChoice}:${n.getAttribute('aria-checked')}`).join());
        for (const [name, viewport, phone] of [['desktop', { width: 1280, height: 800 }, false], ['phone', { width: 390, height: 844 }, true]]) {
            const view = await open(viewport, phone);
            if (phone) {
                await view.click('#sources-toggle');
                await view.waitForTimeout(400);
            }
            check(`${name}: the sidebar offers System, Light and Dark, with System chosen`, await choices(view) === 'system:true,light:false,dark:false');
            check(`${name}: and no data-theme is set`, await view.evaluate(() => !('theme' in document.documentElement.dataset)));
            check(`${name}: the control is on whole pixels and inside the sidebar`, await view.$eval('.segmented', (el) => {
                const r = el.getBoundingClientRect();
                const side = document.querySelector('#sidebar').getBoundingClientRect();
                return [r.x, r.y, r.width, r.height].every(Number.isInteger) && r.height % 2 === 0 && r.width % 2 === 0
                    && r.left >= side.left && r.right <= side.right && r.bottom <= side.bottom;
            }));
            await view.emulateMedia({ colorScheme: 'dark' });
            check(`${name}: System follows a dark system`, await backdrop(view) === DARK);
            await view.click('[data-theme-choice="light"]');
            check(`${name}: Light stays light on a dark system`, await backdrop(view) === LIGHT && await choices(view) === 'system:false,light:true,dark:false');
            await view.emulateMedia({ colorScheme: 'light' });
            await view.click('[data-theme-choice="dark"]');
            check(`${name}: Dark stays dark on a light system`, await backdrop(view) === DARK
                && await view.evaluate(() => getComputedStyle(document.documentElement).colorScheme) === 'dark');
            check(`${name}: the choice is stored and shown on <html>`, await view.evaluate(() => localStorage.getItem('wiijukebox.theme') === 'dark' && document.documentElement.dataset.theme === 'dark'));
            check(`${name}: the browser bar color follows it`, (await view.$$eval('meta[name="theme-color"]', (m) => m.map((x) => x.content))).every((c) => c === '#0d141c'));
            await view.reload();
            await view.waitForSelector('.channel');
            check(`${name}: it survives a reload`, await backdrop(view) === DARK && await choices(view) === 'system:false,light:false,dark:true');
            check(`${name}: and is applied by a script that runs before the stylesheet`, await view.evaluate(() => {
                const nodes = [...document.head.children];
                return nodes.findIndex((n) => n.tagName === 'SCRIPT') < nodes.findIndex((n) => n.rel === 'stylesheet');
            }));
            if (phone) {
                await view.click('#sources-toggle');
                await view.waitForTimeout(400);
            } else {
                await view.focus('[data-theme-choice="dark"]');
                await view.keyboard.press('ArrowRight');
                check(`${name}: arrow keys move through the choices and wrap`, await choices(view) === 'system:true,light:false,dark:false');
                await view.keyboard.press('ArrowLeft');
                check(`${name}: and arrow left goes back`, await choices(view) === 'system:false,light:false,dark:true');
            }
            await view.click('[data-theme-choice="system"]');
            check(`${name}: System clears the stored choice`, await view.evaluate(() => localStorage.getItem('wiijukebox.theme') === null && !('theme' in document.documentElement.dataset))
                && await backdrop(view) === LIGHT);
            await view.context().close();
        }
        {
            const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
            const view = await context.newPage();
            await view.addInitScript(() => {
                const refuse = () => { throw new Error('storage is blocked'); };
                Storage.prototype.getItem = refuse;
                Storage.prototype.setItem = refuse;
                Storage.prototype.removeItem = refuse;
            });
            await view.goto(app.base);
            await view.waitForSelector('.channel');
            await view.click('[data-theme-choice="dark"]');
            check('blocked storage still lets the choice apply for this visit', await backdrop(view) === DARK);
            await context.close();
        }

        // --- the now-playing column: drag, keys, minimize ------------------------------------------
        const playOne = async (view) => {
            await view.click('.home-section .card-wrap button.play-all >> nth=0');
            await view.waitForFunction(() => document.querySelector('#np-title').textContent !== 'Nothing playing', null, { timeout: 15000 });
        };
        const columnWidth = (view) => view.$eval('#nowplaying', (el) => el.offsetWidth);
        const stored = (view, name) => view.evaluate((key) => localStorage.getItem(`wiijukebox.${key}`), name);
        // Every control in the column is on a whole pixel, and the play button is centered in the column's content.
        const columnIsCrisp = (view) => view.evaluate(() => {
            const panel = document.querySelector('#nowplaying').getBoundingClientRect();
            const style = getComputedStyle(document.querySelector('#nowplaying'));
            const inner = panel.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
            const content = panel.width - parseFloat(style.borderLeftWidth) - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
            const rects = ['#np-art-frame', '#seekbar', '#prev', '#playpause', '#next', '#shuffle', '#stop', '#repeat', '#np-close']
                .map((sel) => document.querySelector(sel).getBoundingClientRect());
            const play = document.querySelector('#playpause').getBoundingClientRect();
            return {
                whole: rects.every((r) => [r.x, r.y, r.width, r.height].every(Number.isInteger)),
                centered: play.left + play.width / 2 === inner + content / 2,
                even: content % 2 === 0,
            };
        });

        for (const [name, width] of [['1280', 1280], ['1281', 1281]]) {
            const view = await open({ width, height: 800 }, false);
            await playOne(view);
            check(`${name}: the column starts at 340 with a splitter that reports its range`, await columnWidth(view) === 340
                && await view.$eval('#np-resizer', (el) => [el.getAttribute('role'), el.getAttribute('aria-valuenow'), el.getAttribute('aria-valuemin'), el.getAttribute('aria-valuemax'), el.tabIndex].join()) === 'separator,340,280,520,0');
            check(`${name}: and sits over the column's edge, seven pixels wide`, await view.$eval('#np-resizer', (el) => {
                const r = el.getBoundingClientRect();
                const panel = document.querySelector('#nowplaying').getBoundingClientRect();
                return r.width === 7 && r.left === panel.left - 3 && Number.isInteger(r.left);
            }));
            const centre = await view.$eval('#np-resizer', (el) => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + 300]; });
            await view.mouse.move(...centre);
            await view.mouse.down();
            await view.mouse.move(centre[0] - 33, centre[1], { steps: 3 });
            const during = await view.evaluate(() => document.documentElement.classList.contains('np-resizing'));
            await view.mouse.move(centre[0] - 81, centre[1], { steps: 3 });
            await view.mouse.up();
            const dragged = await columnWidth(view);
            check(`${name}: dragging the divider left widens it, to an even width`, dragged === 422 && during && await stored(view, 'np-width') === '422', String(dragged));
            check(`${name}: the main column took up the difference`, await view.$eval('#main', (el) => el.getBoundingClientRect().right) === width - 422);
            check(`${name}: and the column's content is still on whole pixels`, Object.values(await columnIsCrisp(view)).every(Boolean));
            await view.mouse.move(centre[0] - 81, centre[1]);
            await view.mouse.down();
            await view.mouse.move(40, centre[1], { steps: 4 });
            await view.mouse.up();
            check(`${name}: dragging far left stops at 520`, await columnWidth(view) === 520);
            const edge = await view.$eval('#np-resizer', (el) => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + 300]; });
            await view.mouse.move(...edge);
            await view.mouse.down();
            await view.mouse.move(width - 20, edge[1], { steps: 4 });
            await view.mouse.up();
            check(`${name}: dragging far right stops at 280`, await columnWidth(view) === 280 && await stored(view, 'np-width') === '280');
            check(`${name}: and 280 is still crisp`, Object.values(await columnIsCrisp(view)).every(Boolean));

            await view.focus('#np-resizer');
            await view.keyboard.press('ArrowLeft');
            check(`${name}: arrow left widens by 10`, await columnWidth(view) === 290 && await view.getAttribute('#np-resizer', 'aria-valuenow') === '290');
            await view.keyboard.press('ArrowRight');
            await view.keyboard.press('ArrowRight');
            check(`${name}: arrow right narrows, never below 280`, await columnWidth(view) === 280);
            await view.keyboard.press('Shift+ArrowLeft');
            check(`${name}: Shift moves by 50`, await columnWidth(view) === 330);
            await view.keyboard.press('End');
            check(`${name}: End goes to the widest`, await columnWidth(view) === 520);
            await view.keyboard.press('Home');
            check(`${name}: Home goes to the narrowest`, await columnWidth(view) === 280);
            await view.keyboard.press('ArrowLeft');
            await view.reload();
            await view.waitForSelector('.channel');
            check(`${name}: the width survives a reload`, await columnWidth(view) === 290 && await view.evaluate(() => document.documentElement.style.getPropertyValue('--np-w')) === '290px');
            await view.dblclick('#np-resizer');
            check(`${name}: a double click goes back to 340 and forgets the width`, await columnWidth(view) === 340 && await stored(view, 'np-width') === null
                && await view.evaluate(() => document.documentElement.style.getPropertyValue('--np-w')) === '');
            await view.context().close();
        }

        {
            const view = await open({ width: 1280, height: 800 }, false);
            await playOne(view);
            await view.evaluate(() => localStorage.setItem('wiijukebox.np-width', '401'));
            await view.reload();
            await view.waitForSelector('.channel');
            check('an odd saved width is rounded to an even one', await columnWidth(view) === 402);
            await view.evaluate(() => localStorage.setItem('wiijukebox.np-width', '9999'));
            await view.reload();
            await view.waitForSelector('.channel');
            check('a saved width out of range is ignored', await columnWidth(view) === 340);

            check('the column header carries a minimize button', await view.getAttribute('#np-close', 'aria-label') === 'Minimize to the bottom bar');
            check('and no transport bar shows while the column is out', await view.$eval('#player', (el) => getComputedStyle(el).display) === 'none');
            await view.click('#np-close');
            const bar = await view.evaluate(() => {
                const r = document.querySelector('#player').getBoundingClientRect();
                const play = document.querySelector('#mini-playpause').getBoundingClientRect();
                const art = document.querySelector('#mini-art').getBoundingClientRect();
                const rects = ['#mini-art', '#mini-playpause', '#mini-prev', '#mini-next', '#mini-expand', '#mini-title', '#mini-artist']
                    .map((sel) => document.querySelector(sel).getBoundingClientRect());
                return {
                    full: r.left === 0 && r.right === innerWidth && r.bottom === innerHeight && r.height === 73,
                    hiddenColumn: getComputedStyle(document.querySelector('#nowplaying')).display === 'none' && getComputedStyle(document.querySelector('#np-resizer')).display === 'none',
                    mainFills: document.querySelector('#main').getBoundingClientRect().right === innerWidth && document.querySelector('#app').getBoundingClientRect().bottom === innerHeight - 73,
                    whole: rects.every((q) => [q.x, q.y, q.width, q.height].every(Number.isInteger)),
                    centered: play.top + play.height / 2 === r.top + 1 + 36 && art.top + art.height / 2 === r.top + 1 + 36,
                    controls: ['#mini-prev', '#mini-playpause', '#mini-next', '#mini-expand'].every((sel) => getComputedStyle(document.querySelector(sel)).display !== 'none'),
                    monitorHidden: ['#mini-monitor', '#mini-viz'].every((sel) => getComputedStyle(document.querySelector(sel)).display === 'none'),
                    focus: document.activeElement.id,
                };
            });
            check('minimizing turns the column into a bar across the bottom', bar.full && bar.hiddenColumn && bar.mainFills, JSON.stringify(bar));
            check('with previous, play, next and expand, and the right things centered on whole pixels', bar.controls && bar.monitorHidden && bar.whole && bar.centered, JSON.stringify(bar));
            check('focus moves to Expand', bar.focus === 'mini-expand');
            check('it is remembered', await stored(view, 'np-collapsed') === '1');
            await view.reload();
            await view.waitForSelector('.channel');
            check('and survives a reload', await view.evaluate(() => document.documentElement.classList.contains('np-collapsed') && getComputedStyle(document.querySelector('#player')).display === 'flex'));
            check('the bar plays and pauses', await (async () => {
                const before = await view.getAttribute('#mini-playpause', 'aria-label');
                await view.click('#mini-playpause');
                await view.waitForFunction((was) => document.querySelector('#mini-playpause').getAttribute('aria-label') !== was, before, { timeout: 8000 });
                return true;
            })());
            await view.click('#mini-expand');
            check('Expand brings the column back at its saved width', await columnWidth(view) === 340 && await view.evaluate(() => document.activeElement.id) === 'np-close'
                && await stored(view, 'np-collapsed') === null);
            await view.click('#np-close');
            await view.click('#mini-open');
            check('so does a click on the bar\'s cover and title', await columnWidth(view) === 340 && await view.$eval('#player', (el) => getComputedStyle(el).display) === 'none');

            await view.click('#np-close');
            await view.evaluate(() => document.body.classList.add('viz'));
            const viz = await view.evaluate(() => {
                const bar = document.querySelector('#player');
                return { height: bar.getBoundingClientRect().height, dark: getComputedStyle(bar).backgroundColor, expand: getComputedStyle(document.querySelector('#mini-expand')).display,
                    close: getComputedStyle(document.querySelector('#mini-viz')).display };
            });
            check('the visualizer keeps its own bar: 68px, translucent, with Close and no Expand', viz.height === 68 && viz.dark.startsWith('rgba(13, 20, 28') && viz.expand === 'none' && viz.close !== 'none', JSON.stringify(viz));
            await view.evaluate(() => document.body.classList.remove('viz'));
            await view.context().close();
        }

        for (const [name, width] of [['1000', 1000], ['901', 901]]) {
            const view = await open({ width, height: 800 }, false);
            await playOne(view);
            const narrow = await view.evaluate(() => ({ w: document.querySelector('#nowplaying').offsetWidth, max: document.querySelector('#np-resizer').getAttribute('aria-valuemax'), side: document.querySelector('#sidebar').offsetWidth }));
            check(`${name}: the column starts at 300 and its widest leaves the library 360px`, narrow.w === 300 && Number(narrow.max) === Math.min(520, (width - narrow.side - 360) & ~1), JSON.stringify(narrow));
            await view.focus('#np-resizer');
            await view.keyboard.press('End');
            check(`${name}: End stops where the library still has its room`, await columnWidth(view) === Number(narrow.max) && await view.$eval('#main', (el) => el.getBoundingClientRect().width) >= 360);
            await view.keyboard.press('Home');
            check(`${name}: and crisp at its narrowest`, Object.values(await columnIsCrisp(view)).every(Boolean));
            await view.context().close();
        }

        {
            // A phone keeps its sheet and bar whatever was saved for the wide layout.
            const view = await open({ width: 390, height: 844 }, true);
            await view.evaluate(() => { localStorage.setItem('wiijukebox.np-collapsed', '1'); localStorage.setItem('wiijukebox.np-width', '500'); });
            await view.reload();
            await view.waitForSelector('.channel');
            const phone = await view.evaluate(() => ({
                bar: document.querySelector('#player').getBoundingClientRect().height,
                resizer: getComputedStyle(document.querySelector('#np-resizer')).display,
                expand: getComputedStyle(document.querySelector('#mini-expand')).display,
                sheet: getComputedStyle(document.querySelector('#nowplaying')).position,
                openLabel: document.querySelector('#np-close').getAttribute('aria-label'),
                columns: getComputedStyle(document.querySelector('#app')).gridTemplateColumns,
            }));
            check('a phone ignores the saved column state: sheet, 68px bar, no splitter', phone.bar === 68 && phone.resizer === 'none' && phone.expand === 'none' && phone.sheet === 'fixed'
                && phone.openLabel === 'Hide now playing' && !phone.columns.includes(' '), JSON.stringify(phone));
            await view.click('#mini-open');
            await view.waitForTimeout(400);
            check('and the bar still opens the sheet', await view.evaluate(() => document.body.classList.contains('np-open')));
            await view.click('#np-close');
            check('whose button closes it', await view.evaluate(() => !document.body.classList.contains('np-open')));
            await view.context().close();
        }

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
