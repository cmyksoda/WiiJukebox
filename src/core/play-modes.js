// SPDX-License-Identifier: GPL-3.0-only
const REPEAT_MODES = ['off', 'all', 'one'];

/** Saved settings are hand-editable, so anything unrecognized falls back to off. */
function playModes(saved) {
    return {
        shuffle: saved?.shuffle === true,
        repeat: REPEAT_MODES.includes(saved?.repeat) ? saved.repeat : 'off',
    };
}

/**
 * The new value for a shuffle or repeat request. A missing value flips shuffle
 * or advances repeat to its next mode; anything unrecognized throws.
 */
function nextMode(action, value, current) {
    if (action === 'shuffle') {
        if (value === undefined) return !current.shuffle;
        if (value === true || value === 'on') return true;
        if (value === false || value === 'off') return false;
        throw new Error('shuffle must be on or off');
    }
    if (value === undefined) return REPEAT_MODES[(REPEAT_MODES.indexOf(current.repeat) + 1) % REPEAT_MODES.length];
    if (REPEAT_MODES.includes(value)) return value;
    throw new Error('repeat must be off, all or one');
}

module.exports = { REPEAT_MODES, playModes, nextMode };
