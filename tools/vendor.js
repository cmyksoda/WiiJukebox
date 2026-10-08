// SPDX-License-Identifier: GPL-3.0-only
// Copies the visualizer bundles from node_modules into public/vendor. Plain Node so
// it also works where npm runs scripts through cmd.exe.

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'public', 'vendor');
const files = [
    'butterchurn/dist/butterchurn.min.js',
    'butterchurn-presets/dist/base.min.js',
    'butterchurn-presets/dist/extra.min.js',
    'butterchurn-presets/dist/md1.min.js',
];

fs.mkdirSync(out, { recursive: true });
for (const file of files) fs.copyFileSync(path.join(root, 'node_modules', file), path.join(out, path.basename(file)));
