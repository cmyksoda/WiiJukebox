// SPDX-License-Identifier: GPL-3.0-only
function queueStart(items, selection) {
    if (selection.startId === undefined) return 0;
    // Prefer the original position so repeated songs in playlists stay distinct.
    const index = Number.isSafeInteger(selection.startIndex) &&
        items[selection.startIndex]?.id === selection.startId
        ? selection.startIndex : items.findIndex((item) => item.id === selection.startId);
    if (index < 0) throw new Error('selected track is no longer in this album or playlist; refresh and try again');
    return index;
}
module.exports = { queueStart };
