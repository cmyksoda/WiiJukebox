// SPDX-License-Identifier: GPL-3.0-only
// Optional browser check of the web UI against a running server (not part of npm test).
//
//   WIIJUKEBOX_URL=http://127.0.0.1:4380 CHROMIUM=/path/to/chrome npm i --no-save playwright-core
//   node test/web-ui-check.js
//
// Needs one configured library source (Navidrome) for the browsing checks, and
// plays one track from it. Run it on a spare port, never against a live server.

const { chromium } = require('playwright-core');

const BASE = process.env.WIIJUKEBOX_URL || 'http://127.0.0.1:4380';
let failed = 0;
const check = (label, ok) => {
    console.log(ok ? 'ok  ' : 'FAIL', label);
    if (!ok) failed++;
};

(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox', '--mute-audio'] });
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE);
    await page.waitForSelector('.channel');

    await page.click('#sources-toggle');
    check('drawer opens', await page.evaluate(() => document.body.classList.contains('sources-open')));
    await page.keyboard.press('Escape');
    check('escape closes the drawer', await page.evaluate(() => !document.body.classList.contains('sources-open')));

    await page.click('.channel:has-text("Internet Radio")');
    await page.fill('#radio-url', 'http://example.invalid/test.mp3');
    await page.fill('#radio-name', 'UI check station');
    await page.click('#radio-save');
    await page.waitForSelector('button[aria-label="Remove UI check station"]');
    check('a station can be saved', true);
    await page.click('button[aria-label="Remove UI check station"]');
    await page.waitForFunction(() => !document.querySelector('#favorites').textContent.includes('UI check station'));
    check('and removed', true);

    await page.click('#sources-toggle');
    await page.click('.source-btn:has-text("Navidrome")');
    await page.waitForSelector('.category');
    await page.click('.category:has-text("Albums")');
    await page.waitForSelector('.card');
    check('albums page shows a back button', await page.isVisible('#back'));
    await page.click('.card >> nth=0');
    await page.waitForSelector('.row');
    await page.click('.row >> nth=0');
    await page.waitForFunction(() => document.querySelector('#mini-title').textContent !== 'Nothing playing', null, { timeout: 15000 });
    check('a track plays and the transport bar shows it', true);
    await page.click('#mini-open');
    check('the now-playing sheet opens', await page.evaluate(() => document.body.classList.contains('np-open')));
    await page.click('#playpause');
    await page.waitForFunction(() => document.querySelector('#playpause').classList.contains('show-play'));
    check('pause swaps the glyph', true);
    await page.click('#stop');
    await page.waitForFunction(() => document.querySelector('#np-title').textContent === 'Nothing playing');
    check('stop clears now playing', true);

    check('no console errors', errors.length === 0);
    if (errors.length) console.log(errors.join('\n'));
    await browser.close();
    process.exit(failed ? 1 : 0);
})();
