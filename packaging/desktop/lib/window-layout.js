// SPDX-License-Identifier: GPL-3.0-only
// Where the custom title bar and the page sit inside the window.

const BAR_HEIGHT = 34;

/** The bar is dropped (null) when it is not wanted, and the page then fills the window. */
function layoutViews({ width, height, showBar, barHeight = BAR_HEIGHT }) {
    const top = showBar ? Math.min(barHeight, height) : 0;
    return {
        bar: showBar ? { x: 0, y: 0, width, height: top } : null,
        page: { x: 0, y: top, width, height: Math.max(0, height - top) },
    };
}

module.exports = { BAR_HEIGHT, layoutViews };
