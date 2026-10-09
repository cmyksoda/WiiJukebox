// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { READ_THEME, OPEN_SIDEBAR_SETTINGS, parsePageTheme, chooseThemeScript, forcedTheme, ThemeFeed } = require(path.join(__dirname, '..', 'packaging', 'desktop', 'lib', 'page-theme'));

// A stand-in page: <html> with a data-theme, and the Theme control's buttons.
function fakePage(theme) {
    const pressed = [];
    const document = {
        documentElement: { dataset: theme ? { theme } : {} },
        querySelector: (selector) => ({ click: () => pressed.push(selector) }),
    };
    return { run: (script) => vm.runInNewContext(script, { document }), pressed };
}

test('the app reads the page\'s choice from data-theme, and no attribute means System', () => {
    for (const [attribute, choice] of [[undefined, 'system'], ['light', 'light'], ['dark', 'dark'], ['sepia', 'system']]) {
        assert.equal(parsePageTheme(fakePage(attribute).run(READ_THEME)), choice, String(attribute));
    }
});

test('an answer that is not a choice is ignored', () => {
    for (const raw of [undefined, null, '', 'dark', '{}', '{"choice":"sepia"}', '{"choice":["dark"]}', 42]) {
        assert.equal(parsePageTheme(raw), null, JSON.stringify(raw));
    }
});

test('a choice is made by pressing the page\'s own button, and only for the three known choices', () => {
    const page = fakePage();
    for (const choice of ['system', 'light', 'dark']) page.run(chooseThemeScript(choice));
    assert.deepEqual(page.pressed, ['[data-theme-choice="system"]', '[data-theme-choice="light"]', '[data-theme-choice="dark"]']);
    for (const bad of ['sepia', '"]; alert(1); ["', '', undefined, null]) assert.throws(() => chooseThemeScript(bad), /unknown theme/);
});

test('Sidebar settings is opened by pressing the page\'s own control, and nothing else', () => {
    const page = fakePage();
    page.run(OPEN_SIDEBAR_SETTINGS);
    assert.deepEqual(page.pressed, ['#sidebar-settings']);
});

test('the title bar is told to force Light or Dark, and to follow the system otherwise', () => {
    assert.equal(forcedTheme('dark'), 'dark');
    assert.equal(forcedTheme('light'), 'light');
    assert.equal(forcedTheme('system'), null);
    assert.equal(forcedTheme(undefined), null);
});

test('the theme feed reports changes only, skips pages that cannot answer and honors pause', async () => {
    const answers = ['system', 'system', 'dark', null, 'light'];
    const seen = [];
    let broken = false;
    const feed = new ThemeFeed({
        read: async () => {
            if (broken) throw new Error('the page is loading');
            return answers.shift();
        },
        onChange: (choice) => seen.push(choice),
    });
    for (let i = 0; i < 4; i++) await feed.poll();
    assert.deepEqual(seen, ['system', 'dark'], 'a repeat and an unreadable answer say nothing');
    broken = true;
    await feed.poll();
    assert.deepEqual(seen, ['system', 'dark'], 'a page that throws is not a change');
    broken = false;

    feed.pause();
    await feed.poll();
    assert.deepEqual(seen, ['system', 'dark'], 'a paused feed does not ask');
    await feed.poll({ force: true });
    assert.deepEqual(seen, ['system', 'dark', 'light'], 'a choice just made from a menu is read even while paused');
});

test('the theme feed starts and stops its own timer', async () => {
    const feed = new ThemeFeed({ read: async () => null, onChange: () => {}, intervalMs: 5 });
    feed.start();
    const timer = feed.timer;
    feed.start();
    assert.equal(feed.timer, timer);
    feed.stop();
    assert.equal(feed.timer, null);
});
