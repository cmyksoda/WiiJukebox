// What the web sends when a track in a list is clicked: the album or playlist it sits in
// plus where to start, as the Wii does, so shuffle and repeat see the whole list.

export const isContainer = (item) => item?.type === 'album' || item?.type === 'playlist';

/** `offset` is where this page of the list begins and `index` the track's place within the page. */
export function playRequest(track, { container = null, offset = 0, index = 0 } = {}) {
    if (!isContainer(container)) return track;
    return { ...container, startId: track.id, startIndex: offset + index };
}
