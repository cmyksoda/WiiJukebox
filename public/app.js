// WiiJukebox WebUI.
//
// Deliberately dependency-free and un-built: the whole thing is a few files the
// server hands over as-is. That keeps the eventual single-executable packaging
// honest -- there is no bundler step that has to happen before the app can run.

import butterchurn from './vendor/butterchurn.min.js';

const $ = (sel) => document.querySelector(sel);

const state = {
    sources: [],
    activeSource: null, // id of the source being browsed
    status: null,
    stack: [], // browse history, for the back button
    panelTimer: null, // polling for the receiver / sign-in panels
};

// Corner glyphs for a source's top-level folders, matching the Wii client's icons.
const FOLDER_GLYPHS = {
    artists: 'artist', albums: 'album', playlists: 'playlist', starred: 'star', top: 'star', subscriptions: 'podcast',
};

// What each channel is, for the label on its tile.
const KINDS = {
    subsonic: 'Library', jellyfin: 'Library', plex: 'Library',
    radio: 'Live', podcasts: 'Shows', ytdlp: 'Streaming', ytmusic: 'Streaming',
    spotify: 'Receiver', airplay: 'Receiver', desktop: 'Capture',
};
const NO_SEARCH = new Set(['radio', 'desktop', 'spotify', 'airplay']);
const PHONE = window.matchMedia('(max-width: 900px)');

// --- helpers -------------------------------------------------------------

async function api(path, opts = {}) {
    const res = await fetch(`/api${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...opts,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

/** Build an element; string children become text, so nothing is parsed as HTML. */
function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node[key] = value;
        else node.setAttribute(key, value === true ? '' : value);
    }
    node.append(...kids(children));
    return node;
}

/** Flatten nested arrays and drop empty slots, so conditionals read naturally. */
function kids(children) {
    return children.flat(Infinity)
        .filter((child) => child !== null && child !== undefined && child !== false)
        .map((child) => (child instanceof Node ? child : document.createTextNode(String(child))));
}

/** Only http(s) and inline images reach an <img>. */
function safeImage(url) {
    return typeof url === 'string' && /^(https?:\/\/|data:image\/)/i.test(url) ? url : null;
}

let toastTimer;
function toast(message, isError = false) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.toggle('error', isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        el.hidden = true;
    }, 5000);
}

function fmtDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return hours
        ? `${hours}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
}

function stopPanelTimer() {
    clearInterval(state.panelTimer);
    state.panelTimer = null;
}

function setToolbar({ title, back = false, search = false, settings = null, pages = false, placeholder = 'Search' }) {
    stopPanelTimer();
    $('#crumb').textContent = title;
    $('#back').hidden = !back;
    $('#search').hidden = !search;
    $('#search').placeholder = placeholder;
    $('#search').value = '';
    $('#settings-btn').hidden = !settings;
    $('#settings-btn').onclick = settings;
    if (!pages) $('#pagination').hidden = true;
}

// --- sources -------------------------------------------------------------

async function loadSources() {
    const { sources } = await api('/sources');
    state.sources = sources;
    renderSources();
}

let sourcesSignature = '';
function renderSources() {
    const playingId = state.status?.source?.id;
    const signature = JSON.stringify([
        state.sources.map((s) => [s.id, s.state, s.configured]), playingId, state.activeSource,
    ]);
    if (signature === sourcesSignature) return;
    sourcesSignature = signature;

    const nav = $('#sources');
    nav.replaceChildren(...state.sources.map((src) => {
        const playing = playingId === src.id;
        const sub = playing ? 'playing' : src.configured ? 'ready' : 'needs setup';
        const btn = h('button', {
            class: `source-btn ${src.state}${src.configured ? ' configured' : ''}${playing ? ' playing' : ''}`,
            'aria-current': String(state.activeSource === src.id),
            onclick: () => openSource(src),
        }, h('span', { class: 'dot' }),
        h('span', {}, h('span', { class: 'name', text: src.label }), h('span', { class: 'sub', text: sub })));
        return btn;
    }));

    if (state.activeSource === null && $('#content').dataset.view === 'home') renderHome();
}

function renderHome() {
    stopPanelTimer();
    setToolbar({ title: 'Pick a channel' });
    const content = $('#content');
    content.className = '';
    content.dataset.view = 'home';
    const playingId = state.status?.source?.id;
    const tiles = state.sources.map((src) => {
        const playing = playingId === src.id;
        const label = playing ? 'Playing' : src.configured ? 'Ready' : 'Needs setup';
        return h('button', {
            class: `channel ${src.state}${src.configured ? ' configured' : ''}${playing ? ' playing' : ''}`,
            onclick: () => openSource(src),
        }, h('span', { class: 'kind', text: KINDS[src.id] || '' }),
        h('span', { class: 'name', text: src.label }),
        h('span', { class: 'state' }, h('span', { class: 'dot' }), label));
    });
    content.replaceChildren(...kids([
        h('div', { class: 'grid' }, tiles),
        h('div', { class: 'panel', style: 'margin-top:18px' },
            h('h3', { text: 'Your Wii' }),
            h('p', { class: 'hint', text: 'Open WiiJukebox on your Wii and it connects to this server by itself.' }),
            h('p', { class: 'hint', text: $('#wii-address').textContent }),
            h('p', { class: 'hint', text: $('#stream-addr').textContent }),
            window.WiiJukeboxApp
                ? h('div', { class: 'buttons' }, h('button', { class: 'pill small', text: 'Choose another server',
                    onclick: () => window.WiiJukeboxApp.switchServer() }))
                : null),
    ]));
}

async function openSource(src) {
    setSourcesOpen(false);
    state.activeSource = src.id;
    state.stack = [];
    sourcesSignature = '';
    renderSources();
    $('#content').dataset.view = src.id;
    $('#content').replaceChildren(h('p', { class: 'empty', text: 'Loading…' }));

    // Every connect failure lands on the settings screen with the reason, so a
    // missing program or a bad login explains itself where it can be fixed.
    const connect = async () => {
        try {
            await api(`/sources/${src.id}/connect`, { method: 'POST' });
            await loadSources();
            return null;
        } catch (err) {
            await loadSources().catch(() => {});
            return err.message;
        }
    };

    if (src.id === 'radio') return renderRadio(src);
    if (src.id === 'podcasts') return renderPodcasts();

    if (src.family === 'push') {
        const problem = await connect();
        return problem ? renderSettings(src, { problem }) : renderReceiver(src);
    }

    if (!src.configured) return renderSettings(src);

    const problem = await connect();
    if (src.id === 'ytdlp' || src.id === 'ytmusic') {
        if (problem) toast(`${src.label}: ${problem}`, true);
        return renderLinks(src);
    }
    if (problem) {
        toast(`${src.label}: ${problem}`, true);
        return renderSettings(src, { problem });
    }
    return browse('');
}

const settingsAction = (src) => (SETTINGS[src.id] ? () => renderSettings(src) : null);

// --- library browsing ----------------------------------------------------

async function browse(path, label, offset = 0) {
    const id = state.activeSource;
    const src = state.sources.find((s) => s.id === id);

    // Link-based sources have no library to page through, so their root is the
    // paste box rather than an empty grid. Reached again when backing out of a playlist.
    if (!path && (id === 'ytdlp' || id === 'ytmusic')) return renderLinks(src);

    setToolbar({
        title: label || src?.label || '',
        back: state.stack.length > 0,
        search: !NO_SEARCH.has(id),
        settings: path ? null : settingsAction(src),
        pages: true,
    });
    const content = $('#content');
    content.dataset.view = id;
    content.className = '';
    content.replaceChildren(h('p', { class: 'empty', text: 'Loading…' }));

    try {
        const result = await api(
            `/sources/${id}/browse?path=${encodeURIComponent(path)}&offset=${offset}&limit=100`,
        );
        if (state.activeSource !== id) return;
        const items = result.items.length > 100 ? result.items.slice(offset, offset + 100) : result.items;
        setPager(result.total, offset, items.length, (to) => browse(path, label, to));
        renderItems(items, path, label, offset);
    } catch (err) {
        content.replaceChildren();
        toast(err.message, true);
    }
}

function setPager(total, offset, count, goTo) {
    $('#pagination').hidden = total <= 100 && offset === 0;
    $('#library-prev').disabled = offset === 0;
    $('#library-next').disabled = offset + count >= total || !count;
    const page = Math.floor(offset / 100) + 1;
    const pages = Math.max(page, Math.ceil(total / 100));
    $('#library-page').textContent = `${page} / ${pages}`;
    $('#library-page').setAttribute('aria-label', `Page ${page} of ${pages}`);
    $('#library-prev').onclick = () => goTo(Math.max(0, offset - 100));
    $('#library-next').onclick = () => goTo(offset + 100);
}

function artwork(item, extraClass = '') {
    const url = safeImage(item.artwork);
    const frame = h('span', { class: `art ${extraClass}`.trim() });
    if (url) {
        frame.append(h('img', { src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }));
        return frame;
    }
    frame.append(h('span', { class: 'ph', 'aria-hidden': 'true' }, h('b', { text: (item.title || '♪').trim().charAt(0).toUpperCase() || '♪' })));
    return frame;
}

function renderItems(items, path, label, offset = 0) {
    const content = $('#content');
    content.replaceChildren();
    content.className = '';

    if (!items.length) {
        content.append(h('p', { class: 'empty', text: 'Nothing here.' }));
        return;
    }

    const open = (item) => {
        // Folders and containers drill in; anything playable plays.
        if (item.type === 'track' || item.type === 'station') return play(item);
        state.stack.push({ path, label, offset });
        browse(item.id, item.title);
    };

    const rowFor = (item) => {
        const el = h('button', { class: `row${item.unavailable ? ' unavailable' : ''}`, onclick: () => open(item) },
            artwork(item),
            h('span', { class: 'meta' },
                h('span', { class: 't', text: item.title || '' }),
                h('span', { class: 's', text: item.subtitle || '' })),
            h('span', { class: 'dur', text: fmtDuration(item.duration) }));
        return el;
    };

    const cardFor = (item) => {
        if (item.type === 'folder' && !item.artwork) {
            const glyph = FOLDER_GLYPHS[item.id] || (String(item.id).startsWith('section/') ? 'album' : 'note');
            return h('button', { class: 'category', onclick: () => open(item) },
                h('i', { class: `g g-${glyph}`, 'aria-hidden': 'true' }), item.title || '');
        }
        const card = h('button', { class: 'card', onclick: () => open(item) },
            artwork(item),
            h('span', { class: 't', text: item.title || '' }),
            h('span', { class: 's', text: item.subtitle || '' }));
        const wrap = h('div', { class: 'card-wrap' }, card);
        // Tapping opens an album or playlist; the round button plays it whole.
        if (['album', 'playlist', 'station'].includes(item.type)) {
            wrap.append(h('button', {
                class: 'play-all', 'aria-label': `Play ${item.title}`, title: 'Play all',
                onclick: () => play(item),
            }, h('i', { class: 'g g-right', 'aria-hidden': 'true' })));
            card.oncontextmenu = (e) => {
                e.preventDefault();
                play(item);
            };
        }
        return wrap;
    };

    // Search results from some sources arrive tagged with a group (Songs, Albums...).
    const groups = new Map();
    for (const item of items) {
        const key = item.group || '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }

    for (const [name, members] of groups) {
        if (name) content.append(h('h3', { class: 'group-title', text: name }));
        const tracks = members.filter((i) => i.type === 'track');
        const others = members.filter((i) => i.type !== 'track');
        if (others.length) content.append(h('div', { class: 'grid' }, others.map(cardFor)));
        if (tracks.length) content.append(h('div', { class: 'list' }, tracks.map(rowFor)));
    }
}

async function play(item) {
    try {
        await api(`/sources/${state.activeSource}/play`, { method: 'POST', body: item });
        toast(`Playing ${item.title}`);
    } catch (err) {
        toast(err.message, true);
    }
}

// --- radio ---------------------------------------------------------------

function renderRadio() {
    setToolbar({ title: 'Internet Radio' });
    const content = $('#content');
    content.className = '';
    content.replaceChildren(h('div', { class: 'form' },
        h('label', {}, 'Stream URL',
            h('input', { id: 'radio-url', type: 'url', placeholder: 'http://ice1.somafm.com/groovesalad-128-mp3' })),
        h('label', {}, 'Name (optional)', h('input', { id: 'radio-name', type: 'text', placeholder: 'Groove Salad' })),
        h('div', { class: 'buttons' },
            h('button', { class: 'pill primary', id: 'radio-play', text: 'Play' }),
            h('button', { class: 'pill', id: 'radio-save', text: 'Save station for Wii' })),
        h('div', { id: 'favorites' })));

    bindFavorites('radio', '#radio-url', '#radio-name', '#radio-save');
    $('#radio-play').onclick = () => {
        const url = $('#radio-url').value.trim();
        if (!url) return toast('Enter a stream URL', true);
        play({ url, title: $('#radio-name').value.trim() || url, type: 'station' });
    };
}

// --- podcasts ------------------------------------------------------------

// Pills and the saved-shows list redraw from here, so subscribing in one place
// updates every other place it is showing.
const podcasts = { shows: [], feeds: new Set(), redraws: new Set(), view: 0, back: null };

const podcastLive = (view) => view === podcasts.view && state.activeSource === 'podcasts';

function startPodcastView() {
    podcasts.redraws.clear();
    $('#pagination').hidden = true;
    $('#content').className = '';
    return ++podcasts.view;
}

function rememberShows(shows) {
    podcasts.shows = shows;
    podcasts.feeds = new Set(shows.map((show) => show.feedUrl));
}

async function toggleSubscription(show) {
    const subscribing = !podcasts.feeds.has(show.feedUrl);
    try {
        const { subscriptions } = await api(`/sources/podcasts/action/${subscribing ? 'subscribe' : 'unsubscribe'}`, {
            method: 'POST',
            body: { feedUrl: show.feedUrl, title: show.title, author: show.subtitle ?? show.author, artwork: show.artwork },
        });
        rememberShows(subscriptions);
        toast(`${subscribing ? 'Subscribed to' : 'Unsubscribed from'} ${show.title}`);
        for (const redraw of podcasts.redraws) redraw();
    } catch (err) {
        toast(err.message, true);
    }
}

function subscribeButton(show) {
    const button = h('button', { class: 'pill small' });
    const paint = () => {
        const subscribed = podcasts.feeds.has(show.feedUrl);
        button.textContent = subscribed ? 'Unsubscribe' : 'Subscribe';
        button.classList.toggle('primary', !subscribed);
        button.setAttribute('aria-label', `${subscribed ? 'Unsubscribe from' : 'Subscribe to'} ${show.title}`);
        button.disabled = false;
    };
    const redraw = () => (button.isConnected ? paint() : podcasts.redraws.delete(redraw));
    button.onclick = () => {
        button.disabled = true;
        toggleSubscription(show).finally(paint);
    };
    podcasts.redraws.add(redraw);
    paint();
    return button;
}

function showRow(show) {
    return h('div', { class: 'show-row' },
        h('button', { class: 'row', onclick: () => {
            state.stack.push({ render: podcasts.back });
            podcastShow(show.feedUrl);
        } }, artwork(show),
        h('span', { class: 'meta' },
            h('span', { class: 't', text: show.title }),
            h('span', { class: 's', text: show.subtitle || '' }))),
        subscribeButton(show));
}

function renderPodcasts(query = '') {
    setToolbar({ title: 'Podcasts', search: true, placeholder: 'Search shows or feed URL' });
    $('#search').value = query;
    $('#content').dataset.view = 'podcasts';
    return query ? podcastResults(query) : podcastHome();
}

async function podcastHome() {
    const view = startPodcastView();
    podcasts.back = () => renderPodcasts();
    const mine = h('div', { class: 'show-list' });
    const popular = h('div', { class: 'show-list' }, h('p', { class: 'empty', text: 'Loading…' }));
    $('#content').replaceChildren(
        h('h3', { class: 'group-title', text: 'Your shows' }), mine,
        h('h3', { class: 'group-title', text: 'Popular right now' }), popular);

    try {
        rememberShows((await api('/sources/podcasts/browse?path=subscriptions&limit=500')).items);
    } catch (err) {
        toast(err.message, true);
    }
    if (!podcastLive(view)) return;
    const drawMine = () => mine.replaceChildren(...(podcasts.shows.length
        ? podcasts.shows.map(showRow)
        : [h('p', { class: 'hint', text: 'No shows yet. Search above, or subscribe to one below.' })]));
    podcasts.redraws.add(drawMine);
    drawMine();

    try {
        const { items } = await api('/sources/podcasts/browse?path=top&limit=100');
        if (podcastLive(view)) popular.replaceChildren(...items.map(showRow));
    } catch (err) {
        if (podcastLive(view)) popular.replaceChildren(h('p', { class: 'hint', text: `The chart is unavailable: ${err.message}` }));
    }
}

async function podcastResults(query) {
    const view = startPodcastView();
    podcasts.back = () => renderPodcasts(query);
    $('#content').replaceChildren(h('p', { class: 'empty', text: 'Searching…' }));
    try {
        if (!podcasts.shows.length) rememberShows((await api('/sources/podcasts/browse?path=subscriptions&limit=500')).items);
        const { items } = await api(`/sources/podcasts/search?q=${encodeURIComponent(query)}`);
        if (!podcastLive(view)) return;
        $('#content').replaceChildren(h('h3', { class: 'group-title', text: `Results for “${query}”` }),
            items.length ? h('div', { class: 'show-list' }, items.map(showRow))
                : h('p', { class: 'empty', text: 'No shows found.' }));
    } catch (err) {
        if (!podcastLive(view)) return;
        $('#content').replaceChildren(h('p', { class: 'empty', text: err.message }));
    }
}

function episodeRow(episode) {
    const when = episode.published
        ? new Date(episode.published).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : '';
    return h('button', { class: 'row episode', onclick: () => play(episode) },
        h('span', { class: 'ep-play', 'aria-hidden': 'true' }, h('i', { class: 'g g-right' })),
        h('span', { class: 'meta' },
            h('span', { class: 't', text: episode.title }),
            h('span', { class: 's', text: when })),
        h('span', { class: 'dur', text: fmtDuration(episode.duration) }));
}

async function podcastShow(feedUrl, offset = 0) {
    const view = startPodcastView();
    setToolbar({ title: 'Show', back: true, pages: true });
    $('#content').replaceChildren(h('p', { class: 'empty', text: 'Loading…' }));
    try {
        const { items, total, show } = await api(
            `/sources/podcasts/browse?path=${encodeURIComponent(`show/${feedUrl}`)}&offset=${offset}&limit=100`);
        if (!podcastLive(view)) return;
        $('#crumb').textContent = show.title;
        setPager(total, offset, items.length, (to) => podcastShow(feedUrl, to));
        $('#content').replaceChildren(
            h('div', { class: 'show-head' }, artwork(show),
                h('div', { class: 'show-info' },
                    h('h3', { text: show.title }),
                    show.author ? h('p', { class: 'by', text: show.author }) : null,
                    show.description ? h('p', { class: 'about', text: show.description }) : null,
                    subscribeButton({ ...show, subtitle: show.author }))),
            h('h3', { class: 'group-title', text: `Episodes · ${total}` }),
            items.length ? h('div', { class: 'list' }, items.map(episodeRow))
                : h('p', { class: 'empty', text: 'No episodes in this feed.' }));
        $('#main').scrollTop = 0;
    } catch (err) {
        if (!podcastLive(view)) return;
        $('#content').replaceChildren(h('p', { class: 'empty', text: err.message }));
    }
}

// --- yt-dlp and YouTube Music -----------------------------------------------

function renderLinks(src) {
    const music = src.id === 'ytmusic';
    setToolbar({ title: src.label, search: true, settings: settingsAction(src) });
    const content = $('#content');
    content.className = '';

    const url = () => $('#yt-url').value.trim();
    content.replaceChildren(h('div', { class: 'form' },
        h('label', {}, 'Paste a link',
            h('input', {
                id: 'yt-url', type: 'url',
                placeholder: music ? 'https://music.youtube.com/playlist?list=…' : 'https://www.youtube.com/watch?v=…',
                onkeydown: (e) => { if (e.key === 'Enter') $('#yt-play').click(); },
            })),
        h('label', {}, 'Name (optional)', h('input', { id: 'yt-name', type: 'text', placeholder: 'My saved link' })),
        h('div', { class: 'buttons' },
            h('button', { class: 'pill primary', id: 'yt-play', text: 'Play', onclick: () => {
                if (!url()) return toast('Paste a link first', true);
                play({ id: url(), title: url(), type: 'track' });
            } }),
            h('button', { class: 'pill', id: 'yt-save', text: 'Save link for Wii' }),
            // Drills into a playlist instead of queueing it, for picking one track out.
            h('button', { class: 'pill', id: 'yt-open', text: 'Open as list', onclick: () => {
                if (!url()) return toast('Paste a link first', true);
                state.stack.push({ path: '', label: src.label });
                browse(`list/${url()}`, 'Link contents');
            } })),
        h('div', { id: 'favorites' }),
        h('p', { class: 'hint', text: music
            ? 'Search songs, albums and playlists with the box above. A playlist or album link queues the whole thing. For Premium quality and your own library, add your browser cookies in Settings.'
            : 'A playlist, album or channel link queues the whole thing. Anything yt-dlp supports works: YouTube, SoundCloud, Bandcamp. Or search YouTube with the box above.' })));

    bindFavorites(src.id, '#yt-url', '#yt-name', '#yt-save');
}

async function bindFavorites(source, urlInput, nameInput, saveButton) {
    const container = $('#favorites');
    container.className = 'favorites';
    const reload = async () => {
        const { items } = await api(`/sources/${source}/favorites`);
        const radio = source === 'radio';
        const rows = items.map((item) => {
            const details = h('span', { class: 'favorite-details' }, h('span', { class: 'favorite-name', text: item.name }));
            try {
                details.append(h('span', { class: 'favorite-host', text: new URL(item.url).hostname }));
            } catch { /* Older saved links may not have an absolute URL. */ }
            return h('div', { class: 'favorite-row' },
                h('button', {
                    class: 'favorite-play', 'aria-label': `Play ${item.name}`,
                    onclick: () => play(radio
                        ? { url: item.url, title: item.name, type: 'station' }
                        : { id: item.url, title: item.name, type: 'track' }),
                }, h('span', { class: 'favorite-symbol', 'aria-hidden': 'true' }, h('i', { class: 'g g-right' })), details),
                h('button', {
                    class: 'favorite-remove', title: `Remove ${item.name}`, 'aria-label': `Remove ${item.name}`,
                    onclick: async () => {
                        try {
                            await api(`/sources/${source}/favorites`, { method: 'DELETE', body: { id: item.id } });
                            await reload();
                        } catch (err) { toast(err.message, true); }
                    },
                }, h('i', { class: 'g g-close', 'aria-hidden': 'true' })));
        });
        container.replaceChildren(...kids([
            h('h2', { class: 'favorites-heading' }, radio ? 'Saved stations' : 'Saved links',
                h('span', { class: 'favorites-count', text: items.length })),
            items.length ? null : h('p', { class: 'favorites-empty',
                text: 'Save a link above to keep it here and on your Wii.' }),
            rows]));
    };
    $(saveButton).onclick = async () => {
        try {
            await api(`/sources/${source}/favorites`, { method: 'POST', body: {
                url: $(urlInput).value.trim(), name: $(nameInput).value.trim(),
            } });
            $(urlInput).value = '';
            $(nameInput).value = '';
            await reload();
            toast('Saved for the Wii source browser');
        } catch (err) { toast(err.message, true); }
    };
    try { await reload(); } catch (err) { toast(err.message, true); }
}

// --- receivers (Spotify Connect, AirPlay) ------------------------------------

const RECEIVER_COPY = {
    spotify: {
        title: 'Spotify Connect',
        steps: (name) => [
            'Press Start receiver below.',
            'Open Spotify on your phone or computer and play something.',
            `Tap the speaker icon (Connect) and choose “${name}”.`,
        ],
        note: 'Needs Spotify Premium. Play, pause and skip happen in the Spotify app.',
    },
    airplay: {
        title: 'AirPlay',
        steps: (name) => [
            'Press Start receiver below.',
            'On your iPhone, iPad or Mac, open Apple Music (or any app) and play something.',
            `Tap the AirPlay icon and choose “${name}”.`,
        ],
        note: 'Plays Apple Music and anything else you send over AirPlay. Controls stay on the sending device.',
    },
};

async function renderReceiver(src) {
    const copy = RECEIVER_COPY[src.id] || { title: src.label, steps: () => [], note: '' };
    setToolbar({ title: copy.title, settings: settingsAction(src) });
    const content = $('#content');
    content.className = '';

    const panel = h('div', { class: 'panel' });
    content.replaceChildren(panel);

    const draw = async () => {
        if (state.activeSource !== src.id) return;
        let info = {};
        try { info = await api(`/sources/${src.id}/info`); } catch { /* shown as not running */ }
        const running = state.status?.source?.id === src.id;
        const name = info.deviceName || 'WiiJukebox';
        const detail = [info.user && `Signed in as ${info.user}`, info.client && `From ${info.client}`]
            .filter(Boolean).join(' · ');
        panel.replaceChildren(...kids([
            h('div', { class: 'status-line' },
                h('h3', { text: running ? 'Receiver is running' : 'Receiver is stopped' }),
                h('span', { class: `chip${running ? ' live' : ''}`, text: running ? 'Listening' : 'Off' })),
            h('ol', { class: 'steps' }, copy.steps(name).slice(running ? 1 : 0).map((step) => h('li', { text: step }))),
            detail ? h('p', { class: 'hint', text: detail }) : null,
            h('p', { class: 'hint', text: copy.note }),
            h('div', { class: 'buttons' },
                running
                    ? h('button', { class: 'pill', text: 'Stop receiver', onclick: () => control('stop') })
                    : h('button', { class: 'pill primary', text: 'Start receiver',
                        onclick: () => play({ id: 'receiver', type: 'station', title: name }) }))]));
    };
    await draw();
    state.panelTimer = setInterval(draw, 3000);
}

// --- settings ------------------------------------------------------------------

const f = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });
const SETTINGS = {
    plex: [f('url', 'Server URL', 'url', { placeholder: 'http://192.168.1.10:32400' }), f('token', 'Plex token', 'password', { secret: true })],
    subsonic: [
        f('url', 'Server URL', 'url', { placeholder: 'https://music.example.com' }),
        f('username', 'Username'), f('password', 'Password', 'password', { secret: true }),
    ],
    jellyfin: [
        f('url', 'Server URL', 'url', { placeholder: 'http://192.168.1.10:8096' }),
        f('username', 'Username'), f('password', 'Password', 'password', { secret: true }),
    ],
    spotify: [
        f('deviceName', 'Device name', 'text', { hint: 'What the Spotify app shows in its device list.' }),
        f('bitrate', 'Stream quality', 'select', { number: true, options: [[96, 'Low (96 kbps)'], [160, 'Normal (160 kbps)'], [320, 'High (320 kbps)']] }),
        f('normalise', 'Even out volume between tracks', 'checkbox'),
        f('binary', 'librespot path', 'text', { advanced: true, placeholder: 'librespot', hint: 'Only needed when librespot is not on PATH.' }),
        f('extraArgs', 'Extra librespot options', 'args', { advanced: true }),
    ],
    airplay: [
        f('deviceName', 'Device name', 'text', { hint: 'What iPhones and Macs show under AirPlay.' }),
        f('password', 'Password (optional)', 'password', { secret: true }),
        f('binary', 'shairport-sync path', 'text', { advanced: true, placeholder: 'shairport-sync', hint: 'Only needed when shairport-sync is not on PATH.' }),
    ],
    ytmusic: [
        f('extraArgs', 'Extra yt-dlp options', 'args', { advanced: true, placeholder: '--cookies-from-browser firefox', hint: 'Your browser cookies unlock your library and Premium quality.' }),
        f('binary', 'yt-dlp path', 'text', { advanced: true, placeholder: 'yt-dlp' }),
    ],
    ytdlp: [
        f('extraArgs', 'Extra yt-dlp options', 'args', { advanced: true, placeholder: '--cookies-from-browser firefox' }),
        f('binary', 'yt-dlp path', 'text', { advanced: true, placeholder: 'yt-dlp' }),
    ],
};

async function renderSettings(src, { problem } = {}) {
    const fields = SETTINGS[src.id];
    setToolbar({ title: `${src.label} setup`, back: false });
    const content = $('#content');
    content.className = '';

    if (!fields) {
        content.replaceChildren(h('p', { class: 'empty', text: `${src.label} has no settings yet.` }));
        return;
    }

    let current = { values: {}, secrets: {} };
    try { current = await api(`/sources/${src.id}/settings`); } catch { /* a fresh source has nothing saved */ }

    const inputs = new Map();
    const fieldFor = (field) => {
        const value = current.values[field.key];
        let input;
        if (field.type === 'select') {
            input = h('select', {}, field.options.map(([val, text]) => h('option', { value: val, text })));
            input.value = String(value ?? field.options[0][0]);
        } else if (field.type === 'checkbox') {
            input = h('input', { type: 'checkbox' });
            input.checked = Boolean(value);
        } else {
            input = h('input', {
                type: field.type === 'args' ? 'text' : field.type, placeholder: field.placeholder || '',
                autocomplete: field.secret ? 'new-password' : 'off', spellcheck: 'false',
            });
            input.value = field.secret ? '' : field.type === 'args' ? (value || []).join(' ') : (value ?? '');
        }
        inputs.set(field.key, input);
        const secretSet = field.secret && current.secrets[field.key];
        if (secretSet) input.placeholder = 'Saved (leave empty to keep)';
        const hint = field.hint ? h('span', { class: 'field-hint', text: field.hint }) : null;
        return field.type === 'checkbox'
            ? h('label', { class: 'check' }, input, field.label)
            : h('label', {}, field.label, input, hint);
    };

    const basic = fields.filter((fld) => !fld.advanced).map(fieldFor);
    const advanced = fields.filter((fld) => fld.advanced).map(fieldFor);

    const save = async () => {
        const patch = {};
        for (const field of fields) {
            const input = inputs.get(field.key);
            if (field.type === 'checkbox') {
                if (input.checked !== Boolean(current.values[field.key])) patch[field.key] = input.checked;
            } else if (field.secret) {
                if (input.value) patch[field.key] = input.value;
            } else if (field.type === 'args') {
                const args = input.value.split(/\s+/).filter(Boolean);
                if (args.join(' ') !== (current.values[field.key] || []).join(' ')) patch[field.key] = args;
            } else {
                const value = field.number ? Number(input.value) : input.value.trim();
                if (value !== (current.values[field.key] ?? (field.number ? 0 : ''))) patch[field.key] = value;
            }
        }
        try {
            if (Object.keys(patch).length) await api(`/sources/${src.id}/config`, { method: 'POST', body: patch });
            await loadSources();
            const updated = state.sources.find((s) => s.id === src.id);
            toast(updated.configured ? `Saved ${src.label}` : 'Saved');
            if (updated.configured) openSource(updated);
            else renderSettings(updated, { problem });
        } catch (err) {
            toast(err.message, true);
        }
    };

    content.replaceChildren(...kids([h('div', { class: 'form' },
        problem ? h('p', { class: 'notice error', text: problem }) : null,
        basic,
        advanced.length ? h('details', { class: 'advanced', open: problem ? true : null },
            h('summary', { text: 'Advanced' }), h('div', { class: 'form' }, advanced)) : null,
        h('div', { class: 'buttons' },
            h('button', { class: 'pill primary', id: 'save-src', text: ['spotify', 'airplay', 'ytmusic', 'ytdlp'].includes(src.id) ? 'Save' : 'Connect', onclick: save })))]));
}

// --- transport -----------------------------------------------------------

// The server reports position when something changes; between reports the
// bar advances on its own clock and is corrected by the next report.
const clock = { position: 0, duration: 0, at: 0, running: false, dragging: false };

function currentPosition() {
    const elapsed = clock.running ? (performance.now() - clock.at) / 1000 : 0;
    const position = clock.position + elapsed;
    return clock.duration > 0 ? Math.min(clock.duration, position) : position;
}

function drawProgress() {
    if (clock.dragging) return;
    const seek = $('#seekbar');
    const live = !(clock.duration > 0);
    $('#seek').classList.toggle('live', live);
    const fraction = live ? 0 : currentPosition() / clock.duration;
    seek.value = String(Math.round(fraction * 1000));
    seek.style.setProperty('--pct', `${(fraction * 100).toFixed(2)}%`);
    $('#mini-progress i').style.width = `${(fraction * 100).toFixed(2)}%`;
    $('#np-elapsed').textContent = fmtDuration(currentPosition());
    $('#np-total').textContent = clock.duration > 0 ? fmtDuration(clock.duration) : '';
}

function setPlayPauseGlyph(paused) {
    for (const id of ['#playpause', '#mini-playpause']) {
        $(id).classList.toggle('show-play', paused);
        $(id).setAttribute('aria-label', paused ? 'Resume' : 'Pause');
        $(id).title = paused ? 'Resume' : 'Pause';
    }
}

function applyStatus(status) {
    state.status = status;
    followJump(status.jump);

    const np = status.nowPlaying || {};
    const title = np.title || 'Nothing playing';
    const subtitle = [np.artist, np.album].filter(Boolean).join(' — ');
    $('#np-title').textContent = title;
    $('#np-artist').textContent = subtitle;
    $('#mini-title').textContent = title;
    $('#mini-artist').textContent = subtitle || (status.source ? status.source.label : 'Pick a channel');
    document.title = np.title ? `${np.title}${np.artist ? ` — ${np.artist}` : ''} · WiiJukebox` : 'WiiJukebox';

    const art = safeImage(np.artwork);
    for (const [img, placeholder] of [['#np-art', '#np-placeholder'], ['#mini-img', '#mini-placeholder']]) {
        if (art) $(img).src = art;
        $(img).hidden = !art;
        $(placeholder).hidden = Boolean(art);
    }

    const source = $('#np-source');
    source.hidden = !status.source;
    source.textContent = status.source ? status.source.label : '';

    // Enable only what the active source actually supports, so a control never
    // silently does nothing.
    const caps = status.capabilities || {};
    for (const [a, b] of [['#prev', '#mini-prev'], ['#next', '#mini-next']]) {
        $(a).disabled = $(b).disabled = !caps[a === '#prev' ? 'previous' : 'next'];
    }
    $('#stop').disabled = !caps.stop;
    const canToggle = status.paused ? caps.play : caps.pause;
    $('#playpause').disabled = $('#mini-playpause').disabled = !canToggle;
    setPlayPauseGlyph(Boolean(status.paused) || !status.source);

    clock.position = np.position || 0;
    clock.duration = np.duration || 0;
    clock.at = performance.now();
    clock.running = Boolean(status.source) && !status.paused && !status.starving;
    $('#seekbar').disabled = !(caps.seek && clock.duration > 0);
    drawProgress();

    const capturing = status.source?.id === 'desktop';
    $('#monitor').disabled = $('#mini-monitor').disabled = capturing;
    if (capturing) setMonitoring(false);

    $('#listeners').textContent =
        status.listeners === 1 ? '1 listening' : `${status.listeners} listening`;

    updateMediaSession(np, status);
    renderSources();
}

async function control(action, body = {}) {
    try {
        const res = await api(`/control/${action}`, { method: 'POST', body });
        if (res.endOfQueue) toast('End of queue');
    } catch (err) {
        toast(err.message, true);
    }
}

const seekbar = $('#seekbar');
seekbar.addEventListener('input', () => {
    clock.dragging = true;
    const fraction = Number(seekbar.value) / 1000;
    seekbar.style.setProperty('--pct', `${(fraction * 100).toFixed(2)}%`);
    $('#np-elapsed').textContent = fmtDuration(fraction * clock.duration);
});
seekbar.addEventListener('change', async () => {
    const seconds = (Number(seekbar.value) / 1000) * clock.duration;
    await control('seek', { position: Math.round(seconds) });
    clock.dragging = false;
});

setInterval(drawProgress, 250);
// Pauses and underruns are announced, but drift is not; a slow resync keeps the bar honest.
setInterval(async () => {
    if (!clock.running || clock.dragging || document.hidden) return;
    try { applyStatus(await api('/status')); } catch { /* the event stream will recover */ }
}, 7000);

function updateMediaSession(np, status) {
    if (!('mediaSession' in navigator) || !np.title) return;
    const art = safeImage(np.artwork);
    navigator.mediaSession.metadata = new MediaMetadata({
        title: np.title, artist: np.artist || '', album: np.album || '',
        artwork: art ? [{ src: art }] : [],
    });
    const caps = status.capabilities || {};
    const bind = (name, enabled, fn) => {
        try { navigator.mediaSession.setActionHandler(name, enabled ? fn : null); } catch { /* unsupported action */ }
    };
    bind('play', caps.play, () => control('play'));
    bind('pause', caps.pause, () => control('pause'));
    bind('nexttrack', caps.next, () => control('next'));
    bind('previoustrack', caps.previous, () => control('previous'));
}

// --- live updates --------------------------------------------------------

function connectEvents() {
    const es = new EventSource('/events');
    es.addEventListener('status', (e) => applyStatus(JSON.parse(e.data)));
    es.addEventListener('metadata', () => {
        /* status carries it too; nothing extra to do */
    });
    es.addEventListener('warning', (e) => {
        const { message } = JSON.parse(e.data);
        // Underruns are transient and self-healing; surfacing every one would
        // be noise on a flaky connection.
        if (!/underrun/.test(message)) toast(message, true);
    });
    // EventSource reconnects on its own, so a dropped connection needs no
    // handling beyond not treating it as fatal.
    es.onerror = () => {};
}

// --- visualizer ----------------------------------------------------------
//
// Analysis taps the stream before the speaker gain, so visualization continues
// when local monitoring is muted.

const viz = {
    instance: null,
    ctx: null,
    presets: null,
    names: [],
    index: 0,
    raf: null,
    cycleTimer: null,
    monitoring: false,
    starting: false,
};

// Presets that are known to error out in Butterchurn's renderer.
const IGNORED_PRESETS = ['Flexi + Martin - astral projection'];

async function loadPresets() {
    if (viz.presets) return viz.presets;

    // Loaded on demand rather than up front: the three bundles are ~2.4 MB
    // together, which is a lot to spend before anyone opens the visualizer.
    for (const name of ['base', 'extra', 'md1']) {
        await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = `vendor/${name}.min.js`;
            s.onload = resolve;
            s.onerror = () => reject(new Error(`could not load ${name} presets`));
            document.head.append(s);
        });
    }

    // Same merge the feishin fork uses: base + extra + md1, skipping the image
    // packs since those need separate texture data and break more readily.
    //
    // Each bundle is UMD and sets a global named after itself, with the presets
    // under .default -- so window.base.default, not window.butterchurnPresets.
    const merged = {
        ...(window.base?.default || {}),
        ...(window.extra?.default || {}),
        ...(window.md1?.default || {}),
    };

    viz.presets = merged;
    viz.names = Object.keys(merged).filter((n) => !IGNORED_PRESETS.includes(n));
    return merged;
}

function setMonitoring(enabled) {
    viz.monitoring = enabled;
    for (const id of ['#monitor', '#mini-monitor']) $(id).setAttribute('aria-pressed', String(enabled));
    if (viz.outputGain) viz.outputGain.gain.value = enabled ? 1 : 0;
    if (!enabled && !viz.starting && !document.body.classList.contains('viz')) $('#monitor-audio').pause();
}

// A Wii seek or skip bursts the new audio to every listener; following its jump
// marker keeps this player from falling further behind each time.
function followJump(jump) {
    if (!jump) return;
    const seen = state.jumpId;
    state.jumpId = jump.id;
    const audio = $('#monitor-audio');
    if (seen === undefined || seen === jump.id || !audio.src || audio.paused) return;
    audio.src = `${state.mount || '/stream'}?v=2&epoch=${jump.epoch}&from=${jump.byte}`;
    audio.play().catch(() => {});
}

async function startAudio() {
    const audio = $('#monitor-audio');
    if (!audio.src) audio.src = `${state.mount || '/stream'}?v=2`;

    if (!viz.ctx) {
        viz.ctx = new (window.AudioContext || window.webkitAudioContext)();
        viz.sourceNode = viz.ctx.createMediaElementSource(audio);
        viz.outputGain = viz.ctx.createGain();
        viz.outputGain.gain.value = viz.monitoring ? 1 : 0;
        viz.sourceNode.connect(viz.outputGain);
        viz.outputGain.connect(viz.ctx.destination);
    }
    await viz.ctx.resume();
    await audio.play();
}

function setVizPressed(pressed) {
    $('#viz-toggle').setAttribute('aria-pressed', String(pressed));
    $('#mini-viz').setAttribute('aria-pressed', String(pressed));
}

async function toggleVisualizer() {
    if (viz.starting) return;
    if (document.body.classList.contains('viz')) {
        document.body.classList.remove('viz');
        setVizPressed(false);
        $('#viz-overlay').hidden = true;
        cancelAnimationFrame(viz.raf);
        clearInterval(viz.cycleTimer);
        if (!viz.monitoring) $('#monitor-audio').pause();
        return;
    }

    viz.starting = true;
    try {
        await startAudio();
        await loadPresets();
    } catch (err) {
        if (!viz.monitoring) $('#monitor-audio').pause();
        return toast(`Visualizer: ${err.message}`, true);
    } finally {
        viz.starting = false;
    }

    if (!viz.names.length) {
        if (!viz.monitoring) $('#monitor-audio').pause();
        return toast('No presets loaded', true);
    }

    const canvas = $('#visualizer');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    if (!viz.instance) {
        viz.instance = butterchurn.createVisualizer(viz.ctx, canvas, {
            width: canvas.width,
            height: canvas.height,
        });
        viz.instance.connectAudio(viz.sourceNode);
    }

    setNowPlayingOpen(false);
    document.body.classList.add('viz');
    setVizPressed(true);
    $('#viz-overlay').hidden = false;

    loadPreset(Math.floor(Math.random() * viz.names.length));

    const render = () => {
        viz.instance.render();
        viz.raf = requestAnimationFrame(render);
    };
    render();

    clearInterval(viz.cycleTimer);
    viz.cycleTimer = setInterval(() => {
        loadPreset(Math.floor(Math.random() * viz.names.length));
    }, 25000);
}

function loadPreset(i) {
    viz.index = i;
    const name = viz.names[i];
    viz.instance.loadPreset(viz.presets[name], 5.0);
    $('#viz-preset').textContent = name;
}

window.addEventListener('resize', () => {
    if (!viz.instance) return;
    const canvas = $('#visualizer');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    viz.instance.setRendererSize(canvas.width, canvas.height);
});

// --- wire up -------------------------------------------------------------

function setSourcesOpen(open) {
    document.body.classList.toggle('sources-open', open);
    $('#sources-toggle').setAttribute('aria-expanded', String(open));
    const modal = open && PHONE.matches;
    $('#main').inert = modal;
    $('#player').inert = modal;
    $('#sidebar').setAttribute('role', modal ? 'dialog' : 'complementary');
    $('#sidebar').setAttribute('aria-modal', String(modal));
    if (open) $('#sources-close').focus();
    else if ($('#sidebar').contains(document.activeElement)) $('#sources-toggle').focus();
}

function setNowPlayingOpen(open) {
    const sheet = open && PHONE.matches;
    document.body.classList.toggle('np-open', sheet);
    $('#mini-open').setAttribute('aria-expanded', String(sheet));
    $('#main').inert = sheet;
    $('#player').inert = sheet;
    $('#nowplaying').setAttribute('role', sheet ? 'dialog' : 'region');
    if (sheet) $('#np-close').focus();
    else if ($('#nowplaying').contains(document.activeElement)) $('#mini-open').focus();
}

$('#sources-toggle').onclick = () => setSourcesOpen(!document.body.classList.contains('sources-open'));
$('#sources-close').onclick = () => setSourcesOpen(false);
$('#sidebar-shade').onclick = () => setSourcesOpen(false);
$('#mini-open').onclick = async () => {
    if (document.body.classList.contains('viz')) await toggleVisualizer();
    setNowPlayingOpen(true);
};
$('#np-close').onclick = () => setNowPlayingOpen(false);
PHONE.addEventListener('change', () => {
    setSourcesOpen(false);
    setNowPlayingOpen(false);
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        if (document.body.classList.contains('viz')) toggleVisualizer();
        else if (document.body.classList.contains('np-open')) setNowPlayingOpen(false);
        else setSourcesOpen(false);
    }
    if (event.key === 'Tab' && $('#main').inert) {
        const scope = document.body.classList.contains('np-open') ? $('#nowplaying') : $('#sidebar');
        const targets = [...scope.querySelectorAll('button, a[href], input:not([disabled])')].filter((el) => !el.disabled && !el.hidden);
        const first = targets[0];
        const last = targets.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
});

$('#back').onclick = () => {
    const prev = state.stack.pop();
    if (prev?.render) prev.render();
    else if (prev) browse(prev.path, prev.label, prev.offset);
};

// The Android app asks this on its back button; true means the page used it.
window.wiiJukeboxBack = () => {
    if (document.body.classList.contains('viz')) toggleVisualizer();
    else if (document.body.classList.contains('np-open')) setNowPlayingOpen(false);
    else if (document.body.classList.contains('sources-open')) setSourcesOpen(false);
    else if (!$('#back').hidden) $('#back').click();
    else if (state.activeSource !== null) { state.activeSource = null; sourcesSignature = ''; renderHome(); renderSources(); }
    else return false;
    return true;
};

for (const [ids, action] of [[['#prev', '#mini-prev'], 'previous'], [['#next', '#mini-next'], 'next'], [['#stop'], 'stop']]) {
    for (const id of ids) $(id).onclick = () => control(action);
}
for (const id of ['#playpause', '#mini-playpause']) {
    $(id).onclick = () => control(state.status?.paused ? 'play' : 'pause');
}

async function toggleMonitor() {
    if (viz.monitoring) {
        setMonitoring(false);
        return;
    }
    if (state.status?.source?.id === 'desktop') return;
    try {
        setMonitoring(true);
        await startAudio();
    } catch (err) {
        setMonitoring(false);
        toast(`Could not play here: ${err.message}`, true);
    }
}
$('#monitor').onclick = toggleMonitor;
$('#mini-monitor').onclick = toggleMonitor;

$('#viz-toggle').onclick = toggleVisualizer;
$('#mini-viz').onclick = toggleVisualizer;

let searchTimer;
$('#search').oninput = (e) => {
    clearTimeout(searchTimer);
    $('#pagination').hidden = true;
    const q = e.target.value.trim();
    const podcast = state.activeSource === 'podcasts';
    if (!q) {
        if (podcast) podcastHome();
        return;
    }
    searchTimer = setTimeout(async () => {
        if (podcast) return podcastResults(q);
        try {
            const { items } = await api(
                `/sources/${state.activeSource}/search?q=${encodeURIComponent(q)}`,
            );
            renderItems(items, '', `Results for “${q}”`);
        } catch (err) {
            toast(err.message, true);
        }
    }, 350);
};

(async function init() {
    try {
        const settings = await api('/settings');
        state.mount = settings.mount;
        $('#wii-address').textContent = `If it can't find the server, give it this address: ${settings.hostIp}:${settings.port}`;
        $('#stream-addr').textContent = `Other music players can open http://${settings.hostIp}:${settings.port}${settings.mount}`;
    } catch {
        /* non-fatal; the setup panel just shows less */
    }
    await loadSources();
    $('#content').dataset.view = 'home';
    renderHome();
    connectEvents();
})();
