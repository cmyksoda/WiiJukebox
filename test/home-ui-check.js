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
        check('Home has no Your Wii panel, while the sidebar keeps its Your Wii section', await page.$$eval('#content h3', (nodes) => nodes.every((n) => n.textContent !== 'Your Wii'))
            && await page.$eval('#sidebar #setup h3', (n) => n.textContent) === 'Your Wii');
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

        // --- hiding channels --------------------------------------------------------------------
        const hiddenOnServer = async () => (await (await fetch(`${app.base}/api/ui/hidden-sources`)).json()).hidden;
        const everyId = async () => (await (await fetch(`${app.base}/api/sources`)).json()).sources.map((source) => source.id);
        const reveal = async () => fetch(`${app.base}/api/ui/hidden-sources`, { method: 'POST', body: JSON.stringify({ show: await everyId() }) });
        const listed = (view, where) => view.$$eval(`${where} [data-source]`, (nodes) => nodes.map((node) => node.dataset.source));
        const menuRows = (view) => view.$$eval('.ctx [role="menuitem"]', (nodes) => nodes.map((node) => node.textContent));
        const focusedRow = (view) => view.evaluate(() => document.activeElement?.closest('.ctx') ? document.activeElement.textContent : null);
        const whole = (rect) => [rect.x, rect.y, rect.width, rect.height].every(Number.isInteger);
        const menuIsCrisp = (view) => view.$eval('.ctx', (menu) => {
            const rects = [menu, ...menu.querySelectorAll('button, .sep, .head')].map((node) => node.getBoundingClientRect());
            return rects.every((r) => [r.x, r.y, r.width, r.height].every(Number.isInteger))
                && rects[0].left >= 0 && rects[0].top >= 0 && rects[0].right <= innerWidth && rects[0].bottom <= innerHeight;
        });
        // The page menu at the toolbar's right: Theme, then Sidebar settings with a count while channels are hidden.
        const openPageMenu = async (view) => {
            await view.click('#page-menu');
            await view.waitForSelector('.ctx');
        };
        const openSettings = async (view) => {
            await openPageMenu(view);
            await view.click('.ctx >> text=Sidebar settings…');
            await view.waitForSelector('dialog.sheet[open]');
        };
        const chip = async (view) => {
            await openPageMenu(view);
            const text = await view.$eval('.ctx', (menu) => menu.querySelector('.detail')?.textContent ?? '');
            await view.keyboard.press('Escape');
            return text;
        };
        const toastText = (view) => view.textContent('#toast');
        const everyChannel = ['radio', 'podcasts', 'subsonic', 'jellyfin', 'plex', 'ytdlp', 'spotify', 'airplay', 'ytmusic', 'desktop'];
        const settled = (view) => view.waitForTimeout(450);

        await page.click('#home-link');
        await page.waitForSelector('.channel');
        check('the sidebar and the tiles both carry their channels', JSON.stringify(await listed(page, '#sources')) === JSON.stringify(everyChannel)
            && JSON.stringify(await listed(page, '#home-channels')) === JSON.stringify(everyChannel));
        check('the sidebar has no Theme or Sidebar settings foot, and ends with Your Wii', await page.evaluate(() => !document.querySelector('#sidebar-foot')
            && !document.querySelector('#sidebar .segmented') && !document.querySelector('#sidebar [data-theme-choice], #sidebar #sidebar-settings')
            && document.querySelector('#sidebar').lastElementChild.id === 'setup'));
        check('a menu button sits at the top right of the toolbar, a 44px circle on whole pixels', await page.$eval('#page-menu', (el) => {
            const r = el.getBoundingClientRect();
            const bar = document.querySelector('#toolbar').getBoundingClientRect();
            return [r.x, r.y, r.width, r.height].every(Number.isInteger) && r.width === 44 && r.height === 44 && r.right === bar.right && r.top >= bar.top && r.bottom <= bar.bottom
                && el.getAttribute('aria-label') === 'Menu' && el.getAttribute('aria-haspopup') === 'menu';
        }));
        check('its three dots are 4px squares on whole pixels, centered in it', await page.$eval('#page-menu .g', (el) => {
            const r = el.getBoundingClientRect();
            const b = document.querySelector('#page-menu').getBoundingClientRect();
            return [r.x, r.y, r.width, r.height].every(Number.isInteger) && r.width === 20 && r.height === 4 && r.left - b.left === b.right - r.right && r.top - b.top === b.bottom - r.bottom;
        }));
        check('no count shows by Sidebar settings while nothing is hidden', await chip(page) === '');

        // The menu: right-click, Escape, and a click outside.
        await page.click('#sources [data-source="plex"]', { button: 'right' });
        await page.waitForSelector('.ctx');
        check('right-clicking a channel opens our own menu, not the browser\'s', await page.$eval('.ctx', (menu) => menu.getAttribute('role') === 'menu'
            && menu.getAttribute('aria-label') === 'Plex' && getComputedStyle(menu).position === 'fixed'));
        check('with Open, Settings and Hide "Plex"', (await menuRows(page)).join('|') === 'Open|Settings|Hide “Plex”');
        check('on whole pixels and inside the window', await menuIsCrisp(page));
        check('keyboard focus is in it, and the channel it is for stays marked', await focusedRow(page) === 'Open'
            && await page.$eval('#sources [data-source="plex"]', (el) => el.dataset.menu === 'open'));
        check('in light it is the white surface', await page.$eval('.ctx', (menu) => getComputedStyle(menu).backgroundColor) === 'rgb(255, 255, 255)');
        await page.keyboard.press('Escape');
        check('Escape closes it, leaves the page where it was and returns focus to the channel', !(await page.isVisible('.ctx'))
            && (await page.textContent('#crumb')) === 'Home' && await page.evaluate(() => document.activeElement.dataset.source) === 'plex'
            && await page.$eval('#sources [data-source="plex"]', (el) => !('menu' in el.dataset)));

        await page.click('#sources [data-source="radio"]', { button: 'right' });
        await page.waitForSelector('.ctx');
        check('a channel with no settings form gets no Settings entry', (await menuRows(page)).join('|') === 'Open|Hide “Internet Radio”');
        await page.keyboard.press('Escape');

        await page.click('#sources [data-source="plex"]', { button: 'right' });
        await page.click('#sources [data-source="podcasts"]');
        check('a click outside closes it and does not also open what was under the pointer', !(await page.isVisible('.ctx')) && (await page.textContent('#crumb')) === 'Home');
        await page.click('#sources [data-source="podcasts"]');
        await page.waitForSelector('#search:not([hidden])');
        check('and the next click works as usual', (await page.textContent('#crumb')) === 'Podcasts');
        await page.click('#sources .home');
        await page.waitForSelector('.channel');

        await page.click('#sources [data-source="plex"]', { button: 'right' });
        await page.click('#sources [data-source="plex"]', { button: 'right' });
        check('right-clicking again moves the one menu', await page.locator('.ctx').count() === 1);
        await page.keyboard.press('Escape');

        // The keyboard: Menu key and Shift+F10, arrows, Home, End, Tab.
        await page.focus('#sources [data-source="plex"]');
        await page.keyboard.press('ContextMenu');
        await page.waitForSelector('.ctx');
        check('the Menu key opens it below the focused channel, with the first entry focused', await focusedRow(page) === 'Open'
            && await page.evaluate(() => document.querySelector('.ctx').getBoundingClientRect().top >= document.activeElement.closest('.ctx').getBoundingClientRect().top)
            && await menuIsCrisp(page));
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        check('arrows walk the entries', await focusedRow(page) === 'Hide “Plex”');
        await page.keyboard.press('ArrowDown');
        check('and wrap round', await focusedRow(page) === 'Open');
        await page.keyboard.press('ArrowUp');
        check('in both directions', await focusedRow(page) === 'Hide “Plex”');
        await page.keyboard.press('Home');
        const first = await focusedRow(page);
        await page.keyboard.press('End');
        check('Home and End jump to the ends', first === 'Open' && await focusedRow(page) === 'Hide “Plex”');
        await page.keyboard.press('Tab');
        check('Tab closes it and focus goes back', !(await page.isVisible('.ctx')) && await page.evaluate(() => document.activeElement.dataset.source) === 'plex');
        await page.keyboard.press('Shift+F10');
        await page.waitForSelector('.ctx');
        check('Shift+F10 opens it too', await focusedRow(page) === 'Open');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await page.waitForSelector('#crumb:has-text("Plex setup")');
        check('Enter on Settings opens that channel\'s setup', !(await page.isVisible('.ctx')) && await page.$$eval('#content label', (n) => n.length) >= 2);
        await page.click('#home-link');
        await page.waitForSelector('.channel');

        // Hiding from the menu, with the keyboard.
        await page.focus('#sources [data-source="plex"]');
        await page.keyboard.press('ContextMenu');
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => !document.querySelector('#sources [data-source="plex"]'));
        check('Enter on Hide takes it out of the sidebar, the tiles and the server\'s list', !(await listed(page, '#sources')).includes('plex')
            && !(await listed(page, '#home-channels')).includes('plex') && (await hiddenOnServer()).join() === 'plex');
        check('and says where to get it back', await toastText(page) === 'Hid Plex. Bring it back in Sidebar settings.');
        check('focus moves to the next channel, not to the top of the page', await page.evaluate(() => document.activeElement.dataset.source) === 'ytdlp');
        check('the menu counts what is hidden', await chip(page) === '1 hidden');

        // Persistence: this page after a reload, and a second browser that has never seen the page.
        await page.reload();
        await page.waitForSelector('.channel');
        check('it survives a reload', !(await listed(page, '#sources')).includes('plex') && await chip(page) === '1 hidden');
        const other = await open({ width: 1100, height: 800 }, false);
        check('and a second browser, which keeps nothing locally, sees the same sidebar and tiles', !(await listed(other, '#sources')).includes('plex')
            && !(await listed(other, '#home-channels')).includes('plex') && await chip(other) === '1 hidden');
        await page.click('#home-channels [data-source="podcasts"]', { button: 'right' });
        await page.click('.ctx >> text=Hide “Podcasts”');
        await other.waitForFunction(() => !document.querySelector('#sources [data-source="podcasts"]'));
        check('a change on one device reaches the other without a reload', !(await listed(other, '#home-channels')).includes('podcasts')
            && await chip(other) === '2 hidden');
        await other.waitForFunction(() => !document.querySelector('#home-rows').textContent.includes('New episodes'));
        check('home on the other device drops that channel\'s rows as well', !(await other.textContent('#home-rows')).includes('New episodes'));
        await other.context().close();

        // A tile gets the same menu, and Open and Settings work from it.
        await page.waitForFunction(() => !document.querySelector('#home-rows').textContent.includes('New episodes'));
        await page.click('#home-channels [data-source="jellyfin"]', { button: 'right', position: { x: 40, y: 20 } });
        await page.waitForSelector('.ctx');
        check('a tile opens the same menu', (await menuRows(page)).join('|') === 'Open|Settings|Hide “Jellyfin”' && await menuIsCrisp(page)
            && await page.$eval('#home-channels [data-source="jellyfin"]', (el) => el.dataset.menu === 'open'));
        await page.click('.ctx >> text=Settings');
        await page.waitForSelector('#crumb:has-text("Jellyfin setup")');
        check('Settings opens the setup page', (await page.textContent('#crumb')) === 'Jellyfin setup');
        await page.click('#home-link');
        await page.waitForSelector('.channel');
        await page.click('#home-channels [data-source="radio"]', { button: 'right' });
        await page.click('.ctx >> text=Open');
        await page.waitForSelector('#radio-url');
        check('Open goes to the channel', (await page.textContent('#crumb')) === 'Internet Radio');
        await page.click('#home-link');
        await page.waitForSelector('.channel');

        // The menu follows the theme.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.click('#home-channels [data-source="radio"]', { button: 'right' });
        check('in dark it is the dark surface', await page.$eval('.ctx', (menu) => getComputedStyle(menu).backgroundColor) === 'rgb(20, 29, 39)');
        await page.keyboard.press('Escape');
        await page.emulateMedia({ colorScheme: 'light' });

        // A hidden primary gives way to the automatic one; a hidden playing service keeps playing.
        await reveal();
        await settled(page);
        await page.click('#home-link');
        await page.waitForSelector('.home-section:has(h3:text("Latest")) .card');
        await page.click('.home-section:has(h3:text("Latest")) .card-wrap button.play-all >> nth=0');
        await page.waitForFunction(() => document.querySelector('#np-source').textContent === 'Jellyfin', null, { timeout: 15000 });
        const playing = await page.textContent('#np-title');
        await page.click('#sources [data-source="jellyfin"]', { button: 'right' });
        await page.click('.ctx >> text=Hide “Jellyfin”');
        await page.waitForSelector('.home-section:has(h3:text("Recently added")) .card');
        const rows = await page.$$eval('.home-section h3', (nodes) => nodes.map((n) => n.textContent));
        check('hiding the primary puts the automatic one on home', rows.includes('Recently added') && !rows.includes('Latest'));
        const primary = await (await fetch(`${app.base}/api/home/primary`)).json();
        check('the server agrees, offers only what is showing, and keeps the saved choice', primary.id === 'subsonic' && primary.auto === true
            && primary.eligible.map((entry) => entry.id).join() === 'subsonic,plex' && app.config.data.home.primary === 'jellyfin');
        check('what was playing keeps playing, still labelled with its channel', await page.textContent('#np-source') === 'Jellyfin'
            && await page.textContent('#np-title') === playing && app.pipeline.status.source.id === 'jellyfin' && !app.pipeline.status.paused);
        check('and Jump back in leaves out what came from it', !(await page.$$eval('#home-recent .tag', (n) => n.map((x) => x.textContent))).includes('Jellyfin'));
        await page.click('#sources [data-source="plex"]');
        await page.waitForSelector('.primary-row button');
        check('Set as primary is still offered for the others', (await page.textContent('.primary-row button')) === 'Set as primary');
        await page.click('#sources .home');
        await page.waitForSelector('.home-section:has(h3:text("Recently added")) .card');
        await reveal();
        await page.waitForSelector('.home-section:has(h3:text("Latest")) .card');
        const back = await page.$$eval('.home-section h3', (nodes) => nodes.map((n) => n.textContent));
        check('showing it again brings the saved primary back', back.includes('Latest') && !back.includes('Recently added')
            && (await (await fetch(`${app.base}/api/home/primary`)).json()).id === 'jellyfin');
        await page.click('#sources [data-source="subsonic"]');
        await page.waitForSelector('.category');
        await page.click('#sources [data-source="subsonic"]', { button: 'right' });
        await page.click('.ctx >> text=Hide “Navidrome / Subsonic”');
        await page.waitForSelector('.channel');
        check('hiding the channel you are in takes you home', (await page.textContent('#crumb')) === 'Home'
            && !(await listed(page, '#sources')).includes('subsonic') && await page.getAttribute('#sources .home', 'aria-current') === 'true');
        await reveal();
        await settled(page);

        // Sidebar settings.
        await openSettings(page);
        const sheet = await page.$eval('dialog.sheet', (dialog) => ({
            title: document.getElementById(dialog.getAttribute('aria-labelledby')).textContent,
            described: !!document.getElementById(dialog.getAttribute('aria-describedby')).textContent,
            boxes: [...dialog.querySelectorAll('input[type="checkbox"]')].map((box) => [box.checked, box.labels[0]?.textContent.trim()]),
            focus: document.activeElement.type,
        }));
        check('it opens a dialog titled Sidebar settings with one real checkbox per channel, all ticked', sheet.title === 'Sidebar settings' && sheet.described
            && sheet.boxes.length === everyChannel.length && sheet.boxes.every(([ticked, name]) => ticked && name.length > 3), JSON.stringify(sheet));
        check('each checkbox is named by its channel and says what kind it is', sheet.boxes[0][1].startsWith('Internet Radio') && sheet.boxes[0][1].includes('Live')
            && sheet.boxes[6][1].includes('needs setup'));
        check('the first checkbox has focus', sheet.focus === 'checkbox');
        check('Show all waits until something is hidden', await page.isDisabled('dialog.sheet >> text=Show all'));
        const geometry = await page.$eval('dialog.sheet', (dialog) => {
            const rects = [dialog, ...dialog.querySelectorAll('input, label, button, .svc-list, .sheet-head')].map((node) => node.getBoundingClientRect());
            const r = dialog.getBoundingClientRect();
            return { whole: rects.every((q) => [q.x, q.y, q.width, q.height].every(Number.isInteger)), fits: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
                box: [...dialog.querySelectorAll('input')].every((el) => el.getBoundingClientRect().width === 22 && el.getBoundingClientRect().height === 22),
                scrolls: dialog.querySelector('.svc-list').scrollHeight > dialog.querySelector('.svc-list').clientHeight };
        });
        check('on whole pixels, 22px boxes, fitting a 900px-tall window without scrolling', geometry.whole && geometry.fits && geometry.box && !geometry.scrolls, JSON.stringify(geometry));
        await page.keyboard.press('Space');
        await page.waitForFunction(() => !document.querySelector('#sources [data-source="radio"]'));
        check('Space unticks it and the sidebar behind changes at once', (await hiddenOnServer()).join() === 'radio'
            && !(await page.$eval('dialog.sheet input', (box) => box.checked)));
        check('Show all is available now', !(await page.isDisabled('dialog.sheet >> text=Show all')));
        await page.click('dialog.sheet label:has-text("Spotify Connect")');
        await page.click('dialog.sheet label:has-text("AirPlay")');
        check('clicking rows hides more, in the order the sidebar lists them', (await hiddenOnServer()).join() === 'radio,spotify,airplay');
        check('home behind it lost the tiles too', !(await listed(page, '#home-channels')).some((id) => ['radio', 'spotify', 'airplay'].includes(id)));
        await page.click('dialog.sheet label:has-text("Spotify Connect")');
        check('and ticking one shows it again', (await hiddenOnServer()).join() === 'radio,airplay');
        await page.click('dialog.sheet >> text=Show all');
        check('Show all ticks everything and the server forgets the list', (await hiddenOnServer()).length === 0
            && await page.$$eval('dialog.sheet input', (boxes) => boxes.every((box) => box.checked))
            && await page.isDisabled('dialog.sheet >> text=Show all') && await page.evaluate(() => document.activeElement.textContent) === 'Done');
        await page.keyboard.press('Escape');
        check('Escape closes it and focus returns to the menu button', !(await page.isVisible('dialog.sheet')) && await page.evaluate(() => document.activeElement.id) === 'page-menu');
        await openSettings(page);
        await page.mouse.click(4, 4);
        check('a click on the backdrop closes it', !(await page.isVisible('dialog.sheet')));
        await openSettings(page);
        await page.click('dialog.sheet >> text=Done');
        check('so does Done', !(await page.isVisible('dialog.sheet')));

        // A failed save is undone and says why.
        const loggedBefore = errors.length;
        await page.route('**/api/ui/hidden-sources', (route) => (route.request().method() === 'POST'
            ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'the disk is full' }) }) : route.continue()));
        await openSettings(page);
        await page.click('dialog.sheet label:has-text("Podcasts")');
        await page.waitForFunction(() => document.querySelector('#toast').textContent === 'the disk is full');
        await page.waitForFunction(() => [...document.querySelectorAll('dialog.sheet input')][1].checked);
        check('the box goes back and the sidebar keeps the channel', (await hiddenOnServer()).length === 0 && (await listed(page, '#sources')).includes('podcasts'));
        await page.unroute('**/api/ui/hidden-sources');
        await page.keyboard.press('Escape');
        check('the only console complaint was the browser noting that failed save', errors.splice(loggedBefore).every((line) => line.includes('500')));

        // Hiding everything leaves a way back.
        await fetch(`${app.base}/api/ui/hidden-sources`, { method: 'POST', body: JSON.stringify({ hide: await everyId() }) });
        await page.reload();
        await page.waitForSelector('#home-channels .home-note');
        check('with everything hidden, the sidebar and home say so', (await page.textContent('#sources')).includes('Every channel is hidden.')
            && (await page.textContent('#home-channels')).includes('Bring some back in Sidebar settings') && await chip(page) === '10 hidden');
        await openSettings(page);
        await page.click('dialog.sheet >> text=Show all');
        await page.keyboard.press('Escape');
        await page.waitForSelector('.channel');
        check('and Show all gets everything back', (await hiddenOnServer()).length === 0 && (await listed(page, '#sources')).length === everyChannel.length);

        // On a phone: the toolbar's menu button opens Sidebar settings, the drawer has no foot, and a long press opens the menu.
        for (const [name, viewport] of [['390x844', { width: 390, height: 844 }], ['361x640', { width: 361, height: 640 }]]) {
            const view = await open(viewport, true);
            check(`${name}: the menu button is at the top right of the toolbar's first row, beside the title, on whole pixels`, await view.$eval('#page-menu', (el) => {
                const r = el.getBoundingClientRect();
                const bar = document.querySelector('#toolbar').getBoundingClientRect();
                const title = document.querySelector('#crumb').getBoundingClientRect();
                const toggle = document.querySelector('#sources-toggle').getBoundingClientRect();
                return [r.x, r.y, r.width, r.height].every(Number.isInteger) && r.width === 44 && r.height === 44 && r.right === bar.right - 16
                    && r.top === toggle.top && r.left >= title.right && getComputedStyle(el).display !== 'none';
            }));
            await openSettings(view);
            const card = await view.$eval('dialog.sheet', (dialog) => {
                const r = dialog.getBoundingClientRect();
                const list = dialog.querySelector('.svc-list');
                return { whole: [r.x, r.y, r.width, r.height].every(Number.isInteger), fits: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
                    scrolls: list.scrollHeight > list.clientHeight, bottomRows: [...dialog.querySelectorAll('.svc input')].every((el) => el.getBoundingClientRect().width === 22) };
            });
            check(`${name}: the dialog is a card on whole pixels and inside the screen`, card.whole && card.fits && card.bottomRows, JSON.stringify(card));
            if (viewport.height < 700) {
                check(`${name}: and its list scrolls on a short screen`, card.scrolls);
            }
            await view.click('dialog.sheet label:has-text("Plex")');
            check(`${name}: unticking a channel hides it`, (await hiddenOnServer()).join() === 'plex');
            await view.click('dialog.sheet >> text=Show all');
            await view.click('dialog.sheet >> text=Done');
            await view.click('#sources-toggle');
            await view.waitForTimeout(400);
            check(`${name}: the drawer has no Theme or Sidebar settings foot, and ends with Your Wii`, await view.evaluate(() => !document.querySelector('#sidebar-foot')
                && document.querySelector('#sidebar').lastElementChild.id === 'setup'));

            const cdp = await view.context().newCDPSession(view);
            const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
            const middle = async (selector) => {
                const box = await view.locator(selector).boundingBox();
                return [box.x + box.width / 2, box.y + box.height / 2];
            };
            const [px, py] = await middle('#sources [data-source="plex"]');
            await touch('touchStart', px, py);
            await view.waitForTimeout(250);
            check(`${name}: a press shorter than half a second opens nothing yet`, !(await view.isVisible('.ctx')));
            await view.waitForSelector('.ctx', { timeout: 2000 });
            check(`${name}: holding for half a second opens the menu`, (await menuRows(view)).join('|') === 'Open|Settings|Hide “Plex”' && await menuIsCrisp(view));
            await touch('touchEnd');
            await view.waitForTimeout(300);
            check(`${name}: lifting the finger leaves it open and does not open the channel`, await view.isVisible('.ctx') && (await view.textContent('#crumb')) === 'Home');
            await view.touchscreen.tap(px, 60);
            await view.waitForTimeout(200);
            check(`${name}: a tap elsewhere closes it, and does nothing else`, !(await view.isVisible('.ctx')) && (await view.textContent('#crumb')) === 'Home'
                && await view.evaluate(() => document.body.classList.contains('sources-open')));
            await touch('touchStart', px, py);
            await touch('touchMove', px, py + 40);
            await view.waitForTimeout(700);
            await touch('touchEnd');
            check(`${name}: a finger that moves away does not count as a long press`, !(await view.isVisible('.ctx')));
            await view.tap('#sources [data-source="plex"]');
            await view.waitForSelector('.primary-row button');
            check(`${name}: a short tap still opens the channel`, (await view.textContent('#crumb')) === 'Plex' && !(await view.isVisible('.ctx')));

            await view.click('#sources-toggle');
            await view.waitForTimeout(400);
            await touch('touchStart', ...(await middle('#sources [data-source="podcasts"]')));
            await view.waitForSelector('.ctx', { timeout: 2000 });
            await touch('touchEnd');
            await view.tap('.ctx >> text=Hide “Podcasts”');
            await view.waitForFunction(() => !document.querySelector('#sources [data-source="podcasts"]'));
            check(`${name}: choosing Hide in the menu hides it, and the drawer stays open`, (await hiddenOnServer()).join() === 'podcasts'
                && await view.evaluate(() => document.body.classList.contains('sources-open')));
            await reveal();
            await view.context().close();
        }

        {
            const view = await open({ width: 390, height: 844 }, true);
            const cdp = await view.context().newCDPSession(view);
            await view.evaluate(() => document.querySelector('#home-channels [data-source="plex"]').scrollIntoView({ block: 'center' }));
            await view.waitForTimeout(200);
            const where = await view.locator('#home-channels [data-source="plex"]').boundingBox();
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: where.x + 30, y: where.y + 30 }] });
            await view.waitForSelector('.ctx', { timeout: 2000 });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            check('a tile opens the menu on a long press too, and stays on whole pixels', await menuIsCrisp(view) && (await view.textContent('#crumb')) === 'Home');
            await view.context().close();
        }

        // --- Light, Dark or System ----------------------------------------------------------
        const backdrop = (view) => view.evaluate(() => getComputedStyle(document.body).backgroundColor);
        const LIGHT = 'rgb(243, 246, 249)';
        const DARK = 'rgb(13, 20, 28)';
        // The page menu's Theme rows, as "System:true,Light:false,Dark:false", read with the menu open and closed again.
        const choices = async (view) => {
            await openPageMenu(view);
            const text = await view.$$eval('.ctx [role="menuitemradio"]', (rows) => rows.map((n) => `${n.textContent}:${n.getAttribute('aria-checked')}`).join());
            await view.keyboard.press('Escape');
            return text;
        };
        const pick = async (view, label) => {
            await openPageMenu(view);
            await view.click(`.ctx [role="menuitemradio"]:has-text("${label}")`);
        };
        for (const [name, viewport, phone] of [['desktop', { width: 1280, height: 800 }, false], ['phone', { width: 390, height: 844 }, true]]) {
            const view = await open(viewport, phone);
            check(`${name}: the menu offers System, Light and Dark, with System chosen`, await choices(view) === 'System:true,Light:false,Dark:false');
            check(`${name}: and no data-theme is set`, await view.evaluate(() => !('theme' in document.documentElement.dataset)));
            await openPageMenu(view);
            check(`${name}: the menu is Theme, three choices, a rule and Sidebar settings, 208px wide below the button`, await view.$eval('.ctx', (menu) => {
                const r = menu.getBoundingClientRect();
                const b = document.querySelector('#page-menu').getBoundingClientRect();
                return [...menu.children].map((n) => n.className || n.getAttribute('role')).join() === 'head,menuitemradio,menuitemradio,menuitemradio,sep,menuitem'
                    && menu.querySelector('.head').textContent === 'Theme' && r.width === 208 && r.right <= b.right && r.top >= b.bottom && r.height === 2 + 8 + 28 + 36 * 4 + 9
                    && menu.getAttribute('aria-label') === 'Menu' && document.querySelector('#page-menu').getAttribute('aria-expanded') === 'true';
            }) && await menuIsCrisp(view));
            check(`${name}: and the check mark is drawn left of the chosen label`, await view.$eval('.ctx [aria-checked="true"]', (row) => {
                const mark = getComputedStyle(row, '::before');
                return mark.content !== 'none' && mark.width === '12px' && mark.height === '12px' && row.textContent === 'System';
            }));
            await view.keyboard.press('Escape');
            check(`${name}: Escape closes it and focus returns to the button`, !(await view.isVisible('.ctx')) && await view.evaluate(() => document.activeElement.id) === 'page-menu'
                && await view.getAttribute('#page-menu', 'aria-expanded') === 'false');
            await view.emulateMedia({ colorScheme: 'dark' });
            check(`${name}: System follows a dark system`, await backdrop(view) === DARK);
            await pick(view, 'Light');
            check(`${name}: Light stays light on a dark system`, await backdrop(view) === LIGHT && await choices(view) === 'System:false,Light:true,Dark:false');
            await view.emulateMedia({ colorScheme: 'light' });
            await pick(view, 'Dark');
            check(`${name}: Dark stays dark on a light system`, await backdrop(view) === DARK
                && await view.evaluate(() => getComputedStyle(document.documentElement).colorScheme) === 'dark');
            check(`${name}: the choice is stored and shown on <html>`, await view.evaluate(() => localStorage.getItem('wiijukebox.theme') === 'dark' && document.documentElement.dataset.theme === 'dark'));
            check(`${name}: the browser bar color follows it`, (await view.$$eval('meta[name="theme-color"]', (m) => m.map((x) => x.content))).every((c) => c === '#0d141c'));
            await view.reload();
            await view.waitForSelector('.channel');
            check(`${name}: it survives a reload`, await backdrop(view) === DARK && await choices(view) === 'System:false,Light:false,Dark:true');
            check(`${name}: and is applied by a script that runs before the stylesheet`, await view.evaluate(() => {
                const nodes = [...document.head.children];
                return nodes.findIndex((n) => n.tagName === 'SCRIPT') < nodes.findIndex((n) => n.rel === 'stylesheet');
            }));
            if (!phone) {
                await view.focus('#page-menu');
                await view.keyboard.press('Enter');
                check(`${name}: Enter on the button opens the menu with the first choice focused`, await view.evaluate(() => document.activeElement.textContent) === 'System');
                for (let i = 0; i < 3; i++) await view.keyboard.press('ArrowDown');
                check(`${name}: arrows skip the heading and the rule`, await view.evaluate(() => document.activeElement.textContent) === 'Sidebar settings…');
                await view.keyboard.press('ArrowDown');
                check(`${name}: and wrap`, await view.evaluate(() => document.activeElement.textContent) === 'System');
                for (let i = 0; i < 3; i++) await view.keyboard.press('ArrowUp');
                await view.keyboard.press('Enter');
                check(`${name}: Enter chooses the row: Light`, await choices(view) === 'System:false,Light:true,Dark:false' && await backdrop(view) === LIGHT);
            }
            await pick(view, 'System');
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
            await pick(view, 'Dark');
            check('blocked storage still lets the choice apply for this visit', await backdrop(view) === DARK);
            await context.close();
        }
        {
            // The desktop app's user agent carries WiiJukebox/<version>; there the menu button is not drawn (the app has its own menu).
            const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 WiiJukebox/0.1.0 Chrome/140.0.0.0 Electron/41.7.2 Safari/537.36' });
            const view = await context.newPage();
            await view.goto(app.base);
            await view.waitForSelector('.channel');
            check('inside the desktop app the menu button is not drawn', await view.evaluate(() => document.documentElement.classList.contains('in-app')
                && getComputedStyle(document.querySelector('#page-menu')).display === 'none'));
            check('and the app can still press the page\'s own Theme and Sidebar settings controls', await view.evaluate(() => {
                document.querySelector('[data-theme-choice="dark"]').click();
                const dark = document.documentElement.dataset.theme === 'dark';
                document.querySelector('#sidebar-settings').click();
                return dark && !!document.querySelector('dialog.sheet[open]');
            }));
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
            const center = await view.$eval('#np-resizer', (el) => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + 300]; });
            await view.mouse.move(...center);
            await view.mouse.down();
            await view.mouse.move(center[0] - 33, center[1], { steps: 3 });
            const during = await view.evaluate(() => document.documentElement.classList.contains('np-resizing'));
            await view.mouse.move(center[0] - 81, center[1], { steps: 3 });
            await view.mouse.up();
            const dragged = await columnWidth(view);
            check(`${name}: dragging the divider left widens it, to an even width`, dragged === 422 && during && await stored(view, 'np-width') === '422', String(dragged));
            check(`${name}: the main column took up the difference`, await view.$eval('#main', (el) => el.getBoundingClientRect().right) === width - 422);
            check(`${name}: and the column's content is still on whole pixels`, Object.values(await columnIsCrisp(view)).every(Boolean));
            await view.mouse.move(center[0] - 81, center[1]);
            await view.mouse.down();
            await view.mouse.move(40, center[1], { steps: 4 });
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
