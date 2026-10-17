// SPDX-License-Identifier: GPL-3.0-only
// The private repository gets 500 MB of Actions storage, and installers kept from every push filled it
// in a day. Every artifact upload must be short-lived and must not happen on an ordinary push.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAX_RETENTION_DAYS = 3;
const dir = path.join(__dirname, '..', '.github', 'workflows');

/** Each step of a workflow as its own block of lines, found by indentation. */
function steps(text) {
    const lines = text.split('\n');
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
        const start = /^(\s*)- (name|uses|run):/.exec(lines[i]);
        if (!start) continue;
        const indent = start[1].length;
        let end = i + 1;
        while (end < lines.length) {
            const line = lines[end];
            if (line.trim() && line.length - line.trimStart().length <= indent) break;
            end++;
        }
        blocks.push(lines.slice(i, end).join('\n'));
    }
    return blocks;
}

const uploads = fs.readdirSync(dir).filter((file) => /\.ya?ml$/.test(file)).flatMap((file) =>
    steps(fs.readFileSync(path.join(dir, file), 'utf8'))
        .filter((step) => /uses:\s*actions\/upload-artifact@/.test(step))
        .map((step) => ({ file, step, name: /- name:\s*(.*)/.exec(step)?.[1] ?? '(unnamed)' })));

test('the workflows still upload something, so these checks see it', () => {
    assert.ok(uploads.length > 0);
});

for (const { file, step, name } of uploads) {
    test(`${file}: "${name}" keeps its upload for at most ${MAX_RETENTION_DAYS} days`, () => {
        const days = /retention-days:\s*(\d+)/.exec(step);
        assert.ok(days, 'needs an explicit retention-days');
        assert.ok(Number(days[1]) <= MAX_RETENTION_DAYS, `retention-days is ${days[1]}`);
    });

    test(`${file}: "${name}" only uploads on failure or a requested build`, () => {
        const condition = /^\s*if:\s*(.*)$/m.exec(step)?.[1] ?? '';
        assert.doesNotMatch(condition, /always\(\)/);
        assert.match(condition, /failure\(\)|workflow_dispatch/, `if: ${condition || '(none)'}`);
    });
}
