// SPDX-License-Identifier: GPL-3.0-only
// A release tag names one version, so every app and package file must carry the same one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const { version } = JSON.parse(read('package.json'));

test('the version is plain major.minor.patch, which the Android versionCode is made from', () => {
    assert.match(version, /^\d+\.\d{1,2}\.\d{1,2}$/);
});

for (const file of ['package-lock.json', 'packaging/desktop/package.json', 'packaging/desktop/package-lock.json']) {
    test(`${file} carries the same version`, () => {
        const data = JSON.parse(read(file));
        assert.equal(data.version, version);
        if (data.packages) assert.equal(data.packages[''].version, version);
    });
}

test('the Wii app\'s meta.xml carries the same version', () => {
    assert.equal(/<version>([^<]*)<\/version>/.exec(read('client/dist/apps/wiijukebox/meta.xml'))?.[1], version);
});
