// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildMenuModel, formatAccelerator } = require(path.join(__dirname, '..', 'packaging', 'desktop', 'lib', 'menu-model'));
const { layoutViews, BAR_HEIGHT } = require(path.join(__dirname, '..', 'packaging', 'desktop', 'lib', 'window-layout'));

test('accelerators read the way a menu shows them', () => {
    assert.equal(formatAccelerator('CommandOrControl+Q'), 'Ctrl+Q');
    assert.equal(formatAccelerator('CmdOrCtrl+Shift+r'), 'Ctrl+Shift+R');
    assert.equal(formatAccelerator('CommandOrControl+Plus'), 'Ctrl++');
    assert.equal(formatAccelerator('CommandOrControl+-'), 'Ctrl+-');
    assert.equal(formatAccelerator('F11'), 'F11');
    assert.equal(formatAccelerator('Alt+F4'), 'Alt+F4');
    assert.equal(formatAccelerator(undefined), '');
    assert.equal(formatAccelerator(''), '');
});

test('a menu template becomes plain data for the bar, with separators tidied and roles named', () => {
    const calls = [];
    const template = [
        { type: 'separator' },
        { label: 'Open', click: () => calls.push('open') },
        { type: 'separator' },
        { type: 'separator' },
        { label: 'Start at login', type: 'checkbox', checked: true, click: (item) => calls.push(['login', item.checked]) },
        { label: 'Hidden', visible: false, click: () => calls.push('hidden') },
        { label: 'Needs setup', enabled: false, click: () => calls.push('disabled') },
        { label: 'Theme', submenu: [
            { label: 'System', type: 'radio', checked: false, click: (item) => calls.push(['system', item.checked]) },
            { label: 'Dark', type: 'radio', checked: true, click: (item) => calls.push(['dark', item.checked]) },
        ] },
        { type: 'separator' },
        { role: 'quit' },
        { type: 'separator' },
    ];
    const { items, actions } = buildMenuModel(template, {
        resolveRole: (role) => ({ quit: { label: 'Quit', accelerator: 'CommandOrControl+Q' } })[role],
        roleActions: { quit: () => calls.push('quit') },
    });
    assert.deepEqual(items.map((item) => item.type === 'separator' ? '---' : item.label), ['Open', '---', 'Start at login', 'Needs setup', 'Theme', '---', 'Quit']);
    assert.deepEqual(items.find((item) => item.label === 'Quit'), { id: '9', type: 'normal', label: 'Quit', enabled: true, checked: false, hint: 'Ctrl+Q' });
    assert.equal(items.find((item) => item.label === 'Start at login').checked, true);
    assert.equal(items.find((item) => item.label === 'Needs setup').enabled, false);
    assert.deepEqual(items.find((item) => item.label === 'Theme').submenu.map((item) => [item.label, item.type, item.checked]), [['System', 'radio', false], ['Dark', 'radio', true]]);
    assert.ok(items.every((item) => !('click' in item)), 'no function reaches the bar');
    assert.equal(JSON.stringify(items), JSON.stringify(JSON.parse(JSON.stringify(items))), 'it is plain, serializable data');

    const run = (id) => actions.get(id)?.();
    run(items[0].id);
    run(items.find((item) => item.label === 'Start at login').id);
    run(items.find((item) => item.label === 'Theme').submenu[0].id);
    run(items.find((item) => item.label === 'Quit').id);
    assert.deepEqual(calls, ['open', ['login', false], ['system', true], 'quit'], 'a checkbox is told what it becomes; a radio is always picked');
    assert.equal(actions.get(items.find((item) => item.label === 'Needs setup').id), undefined, 'a disabled entry has no action');
    assert.equal(actions.get('99'), undefined);
    assert.equal(actions.has(items.find((item) => item.label === 'Theme').id), false, 'a submenu is opened, not run');
});

test('a role the app cannot act on shows grayed out instead of doing nothing silently', () => {
    const { items, actions } = buildMenuModel([{ role: 'undo' }], { resolveRole: () => ({ label: 'Undo' }) });
    assert.equal(items[0].enabled, false);
    assert.equal(actions.size, 0);
});

test('the bar view covers the whole window while its menu shows, and is bar-sized otherwise', () => {
    assert.deepEqual(layoutViews({ width: 1280, height: 820, showBar: true, menuOpen: true }), {
        bar: { x: 0, y: 0, width: 1280, height: 820 },
        page: { x: 0, y: BAR_HEIGHT, width: 1280, height: 820 - BAR_HEIGHT },
    });
    assert.equal(layoutViews({ width: 1280, height: 820, showBar: true, menuOpen: false }).bar.height, BAR_HEIGHT);
    assert.equal(layoutViews({ width: 1280, height: 820, showBar: false, menuOpen: true }).bar, null, 'a window without the bar has no menu to show');
});
