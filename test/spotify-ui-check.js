// SPDX-License-Identifier: GPL-3.0-only
// Optional browser check of the Spotify screens (not part of npm test). It starts its own server on
// WIIJUKEBOX_PORT (default 4880) over a fake Spotify, so nothing real is touched, and writes screenshots.
//
//   CHROMIUM=/path/to/chrome SHOTS=dir node test/spotify-ui-check.js     (playwright-core must be resolvable)

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { rig } = require('./helpers/spotify-rig');

const PORT = Number(process.env.WIIJUKEBOX_PORT || 4880);
const SHOTS = process.env.SHOTS || path.join(__dirname, '..', 'project-notes', 'spotify-web');
let failed = 0;
const check = (label, ok) => {
    console.log(ok ? 'ok  ' : 'FAIL', label);
    if (!ok) failed++;
};

(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const r = await rig({ signedIn: false, spotify: { clientId: '' }, port: PORT });
    const redirect = `http://127.0.0.1:${PORT}/api/spotify/callback`;
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox', '--mute-audio'] });
    const errors = [];
    const open = async (viewport, phone = false) => {
        const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone, deviceScaleFactor: 1 });
        const page = await context.newPage();
        page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(r.app.base);
        await page.waitForSelector('.source-btn[data-source="spotify"]', { state: 'attached' });
        return page;
    };
    const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    const flat = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    const spotify = async (page) => {
        // On a phone the channel list is a drawer.
        if (!await page.isVisible('.source-btn[data-source="spotify"]')) await page.click('#sources-toggle');
        await page.click('.source-btn[data-source="spotify"]');
    };

    try {
        const page = await open({ width: 1280, height: 800 });

        // --- signed out ----------------------------------------------------------------
        await spotify(page);
        await page.waitForSelector('.panel .notice');
        check('without an account the receiver page invites setting one up', /Connect your Spotify account|own free Spotify app/.test(await page.textContent('.panel .notice')));
        await shot(page, '01-receiver-invite');
        await page.click('.panel .notice button');
        await page.waitForSelector('.account');
        check('settings show the exact redirect address', (await page.textContent('.account .addr')) === redirect);
        check('Connect asks for the Client ID first', await page.isVisible('.account button:has-text("Connect Spotify account")'));
        await shot(page, '02-settings-signed-out');
        await page.click('.account button:has-text("Connect Spotify account")');
        check('an empty Client ID is refused with a message', (await page.textContent('#toast')).includes('Client ID'));
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: r.app.base }).catch(() => {});
        await page.click('.account button:has-text("Copy")');
        await page.waitForFunction(() => /Copied|Select the address/.test(document.querySelector('#toast').textContent));
        const copied = await page.textContent('#toast');
        check(`Copy confirms (${copied})`, copied.includes('Copied'));

        // --- signing in -----------------------------------------------------------------
        await page.fill('.account input', r.fake.clientId);
        const popup = page.waitForEvent('popup');
        await page.click('.account button:has-text("Connect Spotify account")');
        const sign = await popup;
        await sign.waitForLoadState();
        const authorizeUrl = sign.url();
        check('Connect opens Spotify sign-in with PKCE and the redirect address', authorizeUrl.startsWith(r.fake.url) && authorizeUrl.includes('code_challenge_method=S256'));
        await sign.goto(r.fake.authorize(authorizeUrl, { redirectUri: redirect }));
        check('the callback page says it worked', (await sign.textContent('h1')) === 'Spotify is connected');
        await sign.setViewportSize({ width: 640, height: 360 });
        await shot(sign, '03-signed-in-page');
        await sign.close();
        await page.waitForSelector('.account .chip.live', { timeout: 10000 });
        check('the settings page notices the sign-in', (await page.textContent('.account')).includes('Signed in as Jaxi'));
        await shot(page, '04-settings-connected');

        await page.click('.account button:has-text("Test connection")');
        await page.waitForSelector('.proof li');
        await page.waitForFunction(() => !document.querySelector('.account button[disabled]'));
        const verdicts = await page.$$eval('.proof li', (rows) => rows.map((row) => [row.querySelector('strong').textContent, row.querySelector('.chip').textContent]));
        check('Test connection lists each step', verdicts.length === 5 && verdicts[0][1] === 'Pass' && verdicts.at(-1)[1] === 'Fail');
        await shot(page, '05-test-connection');

        // --- phone ----------------------------------------------------------------------
        const phone = await open({ width: 390, height: 844 }, true);
        await spotify(phone);
        await phone.waitForSelector('.category');
        check('phone: the library opens without sideways scroll', await flat(phone));
        await shot(phone, '12-phone-library');
        await phone.click('#settings-btn');
        await phone.waitForSelector('.account');
        check('phone: settings fit', await flat(phone));
        await phone.screenshot({ path: path.join(SHOTS, '13-phone-settings.png'), fullPage: false });
        await phone.context().close();

        // --- library --------------------------------------------------------------------
        await spotify(page);
        await page.waitForSelector('.category');
        const roots = await page.$$eval('.category, .card .t', (nodes) => nodes.map((n) => n.textContent.trim()));
        check('the library root has Liked Songs, Playlists, Albums and the receiver', ['Liked Songs', 'Playlists', 'Albums', 'WiiJukebox'].every((name) => roots.includes(name)));
        await shot(page, '06-library-root');
        await page.click('.category:has-text("Playlists")');
        await page.waitForSelector('.card:has-text("Road Trip")');
        check('playlists show their cover through the proxy', await page.$$eval('.card img', (imgs) => imgs.length >= 3 && imgs.every((img) => new URL(img.src).pathname.startsWith('/api/art/'))));
        await shot(page, '07-playlists');
        await page.click('.card:has-text("Road Trip") >> nth=0');
        await page.waitForSelector('.row');
        check('an unreadable entry is dimmed but keeps its place', await page.$$eval('.row.unavailable', (rows) => rows.length === 2));
        await shot(page, '08-playlist-tracks');

        const request = page.waitForRequest((q) => q.url().endsWith('/api/sources/spotify/play'));
        await page.click('.row >> nth=13');
        const body = JSON.parse((await request).postData());
        check('a track click sends the playlist with its absolute position', body.id === 'playlist/plRoadTrip' && body.startIndex === 13 && body.startId === 'track/rt014');
        await page.waitForFunction(() => document.querySelector('#mini-title').textContent === 'Road Trip 14', null, { timeout: 15000 });
        check('Spotify plays it on the receiver', r.fake.player.playing && r.fake.player.index === 13);
        await page.waitForFunction(() => [...document.querySelectorAll('#playpause, #next, #prev, #shuffle, #repeat')].every((n) => !n.disabled), null, { timeout: 5000 })
            .then(() => check('transport is enabled for the remote player', true), () => check('transport is enabled for the remote player', false));
        await shot(page, '09-playing');

        await page.click('#playpause');
        await page.waitForFunction(() => document.querySelector('#playpause').classList.contains('show-play'));
        check('Pause reaches Spotify', r.fake.player.playing === false);
        await page.click('#playpause');
        await page.waitForFunction(() => !document.querySelector('#playpause').classList.contains('show-play'));
        await page.click('#next');
        await page.waitForFunction(() => document.querySelector('#mini-title').textContent === 'Road Trip 15', null, { timeout: 10000 });
        check('Next moves Spotify to the following song', r.fake.player.index === 14 && r.runs() === 1);

        await page.click('#back');
        await page.waitForSelector('.card:has-text("Editorial Picks")');
        await page.click('.card:has-text("Editorial Picks") >> nth=0');
        await page.waitForSelector('.panel h3');
        check('a playlist Spotify hides says so instead of looking empty', (await page.textContent('.panel')).includes('Tracks are not shared with this app')
            && (await page.textContent('.panel')).includes('own or collaborate'));
        await shot(page, '10-playlist-hidden');
        await page.click('#back');
        await page.click('.card:has-text("Empty One") >> nth=0');
        await page.waitForFunction(() => document.querySelector('.empty')?.textContent.includes('Nothing here'));
        check('an empty playlist says Nothing here', true);

        await spotify(page);
        await page.waitForSelector('.card:has-text("Liked Songs")');
        await page.click('.card:has-text("Liked Songs") >> nth=0');
        await page.waitForSelector('.row');
        check('Liked Songs pages at 100 with a pager', await page.isVisible('#pagination') && (await page.textContent('#library-page')).trim() === '1 / 2');
        await shot(page, '11-liked-songs');
        await page.click('#library-next');
        await page.waitForFunction(() => document.querySelector('.row .t')?.textContent === 'Liked Song 101');
        check('the second page starts at the absolute offset', true);

        await spotify(page);
        await page.waitForSelector('#search:not([hidden])');
        await page.fill('#search', 'lantern');
        await page.waitForSelector('.group-title');
        check('search groups Albums and Songs', (await page.$$eval('.group-title', (nodes) => nodes.map((n) => n.textContent))).includes('Albums'));
        await shot(page, '14-search');

        // --- failures ---------------------------------------------------------------------
        r.fake.knobs.allowlisted = false;
        await spotify(page);
        await page.waitForSelector('.category');
        await page.click('.category:has-text("Albums")');
        await page.waitForSelector('.panel .notice.error');
        check('a development-mode refusal says to add the account', (await page.textContent('.panel .notice.error')).includes('User Management'));
        await shot(page, '15-development-mode');
        r.fake.knobs.allowlisted = true;

        r.fake.revoke();
        // The receiver's status poll notices the revoked sign-in on its own.
        for (let i = 0; i < 100 && r.source().auth !== 'reconnect'; i++) await new Promise((resolve) => setTimeout(resolve, 100));
        await spotify(page);
        await page.waitForSelector('.panel .notice:has-text("Reconnect Spotify")', { timeout: 10000 });
        check('a revoked sign-in says Reconnect Spotify and takes the controls away', await page.$eval('#playpause', (n) => n.disabled) || await page.$eval('#next', (n) => n.disabled));
        await shot(page, '16-reconnect-needed');
        await page.click('.panel .notice button:has-text("Reconnect Spotify")');
        await page.waitForSelector('.account button:has-text("Reconnect Spotify")');
        check('the settings offer Reconnect Spotify', (await page.textContent('.account .chip')) === 'Reconnect needed');
        await shot(page, '17-settings-reconnect');
        check('the page had no script errors', errors.length === 0);
        if (errors.length) console.log(errors);
    } catch (err) {
        // Whatever the first page last showed, to see why a step did not find its element.
        const [first] = browser.contexts()[0]?.pages() || [];
        await first?.screenshot({ path: path.join(SHOTS, 'failure.png') }).catch(() => {});
        throw err;
    } finally {
        await browser.close();
        await r.close();
    }
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
