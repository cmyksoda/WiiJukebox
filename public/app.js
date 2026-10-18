// WiiJukebox WebUI.
//
// Deliberately dependency-free and un-built: the whole thing is a few files the
// server hands over as-is. That keeps the eventual single-executable packaging
// honest -- there is no bundler step that has to happen before the app can run.

import butterchurn from './vendor/butterchurn.min.js';
import { isContainer, playRequest } from './play-request.mjs';
import { bindMenuRequests, closeMenu, openMenu } from './context-menu.mjs';
import './scrollbars.mjs';

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

/** Per-device settings in localStorage; a blocked or full store just means nothing is remembered. */
const prefs = {
    get(name) {
        try {
            return localStorage.getItem(`wiijukebox.${name}`);
        } catch {
            return null;
        }
    },
    set(name, value) {
        try {
            if (value === null) localStorage.removeItem(`wiijukebox.${name}`);
            else localStorage.setItem(`wiijukebox.${name}`, value);
        } catch {
            /* nothing to do: the setting still applies until the page is reloaded */
        }
    },
};

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

/** Only this server's art proxy and inline images reach an <img>; service links stay on the server. */
function safeImage(url) {
    return typeof url === 'string' && /^(\/api\/art\/|data:image\/)/i.test(url) ? url : null;
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

/**
 * A small modal question. Resolves true on the confirm button; Cancel, Escape and a tap outside all
 * answer no. The browser's own modal dialog keeps focus inside and handles Escape.
 */
function confirmDialog({ question, detail, confirm }) {
    return new Promise((resolve) => {
        const dialog = h('dialog', { class: 'confirm', 'aria-labelledby': 'confirm-question', 'aria-describedby': 'confirm-text' },
            h('form', { method: 'dialog' },
                h('p', { id: 'confirm-text' }, h('strong', { id: 'confirm-question', text: question }), ` ${detail}`),
                h('div', { class: 'buttons' },
                    h('button', { class: 'pill', value: 'cancel', text: 'Cancel', autofocus: true }),
                    h('button', { class: 'pill primary', value: 'ok', text: confirm }))));
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) dialog.close('cancel');
        });
        dialog.addEventListener('close', () => {
            dialog.remove();
            resolve(dialog.returnValue === 'ok');
        });
        document.body.append(dialog);
        dialog.showModal();
    });
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

// Every view opens through setToolbar, so a view that waited on the network can tell it was left.
let navigations = 0;

function setToolbar({ title, back = false, search = false, settings = null, pages = false, placeholder = 'Search' }) {
    navigations++;
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
        state.sources.map((s) => [s.id, s.state, s.configured, s.hidden]), playingId, state.activeSource,
    ]);
    if (signature === sourcesSignature) return;
    sourcesSignature = signature;

    const homeButton = h('button', {
        class: 'source-btn home', 'aria-current': String(state.activeSource === null), onclick: goHome,
    }, h('i', { class: 'g g-home', 'aria-hidden': 'true' }), h('span', { class: 'name', text: 'Home' }));

    const shown = shownSources();
    const nav = $('#sources');
    nav.replaceChildren(...kids([homeButton, shown.map((src) => {
        const playing = playingId === src.id;
        const sub = playing ? 'playing' : src.configured ? 'ready' : 'needs setup';
        const btn = h('button', {
            class: `source-btn ${src.state}${src.configured ? ' configured' : ''}${playing ? ' playing' : ''}`,
            'aria-current': String(state.activeSource === src.id),
            'data-source': src.id,
            onclick: () => openSource(src),
        }, h('span', { class: 'dot' }),
        h('span', {}, h('span', { class: 'name', text: src.label }), h('span', { class: 'sub', text: sub })));
        return btn;
    }), shown.length ? null : h('p', { class: 'hint sources-empty', text: 'Every channel is hidden.' })]));

    sidebarSettings.paint?.();
    paintChannels();
}

// --- hiding channels -----------------------------------------------------------
//
// A channel can be hidden from the sidebar, Home and the Wii. The server keeps the list so every device agrees;
// hiding only changes what is offered, and a hidden channel keeps its settings and keeps playing.

const shownSources = () => state.sources.filter((src) => !src.hidden);
const hiddenIds = () => state.sources.filter((src) => src.hidden).map((src) => src.id);
const sidebarSettings = { paint: null };

let homeRefresh;
function refreshHome() {
    clearTimeout(homeRefresh);
    homeRefresh = setTimeout(() => {
        if (homeVisible()) loadHome(++homeView.token);
    }, 250);
}

/** Takes the server's list and repaints whatever lists channels. */
function applyHidden(list) {
    const hidden = new Set(list);
    if (state.sources.every((src) => src.hidden === hidden.has(src.id))) return;
    for (const src of state.sources) src.hidden = hidden.has(src.id);
    if (hidden.has(state.activeSource)) {
        goHome({ keepSidebar: true });
        return;
    }
    renderSources();
    refreshHome();
}

let hideRequests = Promise.resolve();
let hidePending = 0;

/** The page changes at once; the server's answer, or the truth after a failure, settles it once the last request is done. */
function changeHidden(change) {
    const before = hiddenIds();
    const next = new Set(before);
    for (const id of change.hide || []) next.add(id);
    for (const id of change.show || []) next.delete(id);
    applyHidden([...next]);
    hidePending++;
    hideRequests = hideRequests.then(async () => {
        let hidden;
        try {
            ({ hidden } = await api('/ui/hidden-sources', { method: 'POST', body: change }));
        } catch (err) {
            toast(err.message, true);
            hidden = await api('/ui/hidden-sources').then((answer) => answer.hidden, () => before);
        }
        if (--hidePending === 0) applyHidden(hidden);
    });
}

function hideChannel(src, trigger) {
    const list = trigger.parentElement;
    const peers = [...list.querySelectorAll('[data-source]')];
    const neighbor = peers[peers.indexOf(trigger) + 1] || peers[peers.indexOf(trigger) - 1];
    changeHidden({ hide: [src.id] });
    toast(`Hid ${SHORT[src.id] || src.label}. Bring it back in Sidebar settings.`);
    // The control that had focus is gone; the keyboard stays where it was.
    const fallback = list.id === 'sources' ? $('#sources .home') : $('#home-channels-title');
    if (fallback) fallback.tabIndex = -1;
    (neighbor && list.querySelector(`[data-source="${neighbor.dataset.source}"]`) || fallback)?.focus({ preventScroll: true });
}

function openChannelMenu(el, anchor) {
    const src = state.sources.find((entry) => entry.id === el.dataset.source);
    if (!src) return;
    openMenu({
        label: src.label, trigger: el, anchor,
        items: [
            { label: 'Open', run: () => openSource(src) },
            SETTINGS[src.id] ? { label: 'Settings', run: () => { enterSource(src); renderSettings(src); } } : null,
            'separator',
            { label: `Hide “${src.label}”`, run: () => hideChannel(src, el) },
        ].filter(Boolean),
    });
}
bindMenuRequests('[data-source]', openChannelMenu);

/** One checkbox per channel, ticked while it is shown. Changes apply and save at once. */
function openSidebarSettings() {
    const boxes = new Map();
    const rows = state.sources.map((src) => {
        const box = h('input', {
            type: 'checkbox', onchange: () => changeHidden(box.checked ? { show: [src.id] } : { hide: [src.id] }),
        });
        const sub = h('span', { class: 'svc-sub' });
        boxes.set(src.id, { box, sub });
        return h('label', { class: 'svc' }, box,
            h('span', { class: 'svc-text' }, h('span', { class: 'svc-name', text: src.label }), sub));
    });
    const showAll = h('button', { type: 'button', class: 'pill quiet', text: 'Show all', onclick: () => {
        changeHidden({ show: hiddenIds() });
    } });
    const done = h('button', { type: 'button', class: 'pill primary', text: 'Done', onclick: () => dialog.close() });
    const dialog = h('dialog', { class: 'sheet', 'aria-labelledby': 'sheet-title', 'aria-describedby': 'sheet-hint' },
        h('div', { class: 'sheet-head' },
            h('h3', { id: 'sheet-title', text: 'Sidebar settings' }),
            h('p', { id: 'sheet-hint', text: 'Unticked channels are hidden from the sidebar, Home and your Wii. '
                + 'They keep working, and anything playing carries on.' })),
        // Not a fieldset: Chromium paints a scrolling fieldset's rows over the buttons below it.
        h('div', { class: 'svc-list', role: 'group', 'aria-label': 'Channels to show' }, rows),
        h('div', { class: 'buttons' }, showAll, done));
    sidebarSettings.paint = () => {
        for (const src of state.sources) {
            const { box, sub } = boxes.get(src.id);
            box.checked = !src.hidden;
            sub.textContent = [KINDS[src.id], src.configured ? '' : 'needs setup'].filter(Boolean).join(' · ');
        }
        showAll.disabled = hiddenIds().length === 0;
    };
    sidebarSettings.paint();
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => {
        sidebarSettings.paint = null;
        dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    boxes.values().next().value?.box.focus();
}
$('#sidebar-settings').onclick = openSidebarSettings;

// --- home --------------------------------------------------------------------
//
// Recent plays come from the server's history; each configured service then fills in
// its own rows, so one slow or broken service never holds up or breaks the others.

// Short names for the tag on a card and the link beside a row title.
const SHORT = {
    subsonic: 'Navidrome', jellyfin: 'Jellyfin', plex: 'Plex', radio: 'Radio', podcasts: 'Podcasts',
    ytdlp: 'Web links', ytmusic: 'YouTube Music',
};
const homeView = { token: 0, recentTimer: null };
const homeVisible = () => state.activeSource === null && $('#content').dataset.view === 'home';

function goHome({ keepSidebar = false } = {}) {
    if (!keepSidebar && document.body.classList.contains('sources-open')) setSourcesOpen(false);
    state.activeSource = null;
    state.stack = [];
    sourcesSignature = '';
    renderSources();
    renderHome();
    $('#main').scrollTop = 0;
}

function renderHome() {
    stopPanelTimer();
    setToolbar({ title: 'Home' });
    const content = $('#content');
    content.className = '';
    content.dataset.view = 'home';
    const token = ++homeView.token;
    content.replaceChildren(
        h('div', { id: 'home-recent' }),
        h('div', { id: 'home-rows' }),
        h('section', { class: 'home-section', 'aria-labelledby': 'home-channels-title' },
            h('div', { class: 'home-head' }, h('h3', { id: 'home-channels-title', text: 'All channels' })),
            h('div', { class: 'grid', id: 'home-channels' })));
    paintChannels();
    loadHome(token);
}

/** The tile grid at the bottom of home; repainted alone when a source's state changes. */
// A Spotify with an account connected is a library, not just a receiver.
const kindOf = (src) => (src.id === 'spotify' && src.capabilities?.search ? 'Library' : KINDS[src.id] || '');

function paintChannels() {
    const grid = homeVisible() && $('#home-channels');
    if (!grid) return;
    const playingId = state.status?.source?.id;
    const shown = shownSources();
    if (!shown.length) {
        grid.replaceChildren(h('p', {
            class: 'home-note', text: 'Every channel is hidden. Bring some back in Sidebar settings.',
        }));
        return;
    }
    grid.replaceChildren(...shown.map((src) => {
        const playing = playingId === src.id;
        const label = playing ? 'Playing' : src.configured ? 'Ready' : 'Needs setup';
        return h('button', {
            class: `channel ${src.state}${src.configured ? ' configured' : ''}${playing ? ' playing' : ''}`,
            'data-source': src.id,
            onclick: () => openSource(src),
        }, h('span', { class: 'kind', text: kindOf(src) }),
        h('span', { class: 'name', text: src.label }),
        h('span', { class: 'state' }, h('span', { class: 'dot' }), label));
    }));
}

async function loadHome(token) {
    let overview;
    try {
        overview = await api('/home');
    } catch (err) {
        if (token === homeView.token) $('#home-rows').replaceChildren(homeNote(`Home could not load: ${err.message}`));
        return;
    }
    if (token !== homeView.token) return;
    paintRecent(overview.recent);

    const slots = overview.services.map(() => h('div', { class: 'home-service' }));
    $('#home-rows').replaceChildren(...slots);
    await Promise.all(overview.services.map((service, i) => loadService(service, slots[i], token)));
    if (token === homeView.token) showFirstRunHint();
}

/** On a page with nothing to offer yet, say where things come from. */
function showFirstRunHint() {
    if ($('#home-rows').querySelector('.home-section') || $('#home-recent .home-section')) return;
    $('#home-recent').replaceChildren(
        h('p', { class: 'hint', text: 'Start something from a channel below and it shows up here to play again.' }));
}

async function loadService(service, slot, token) {
    slot.replaceChildren(...service.rows.map((row) => homeSection(row.title, service, h('p', { class: 'hint', text: 'Loading…' }))));
    let data;
    try {
        data = await api(`/home/${service.id}`);
    } catch (err) {
        data = { error: err.message };
    }
    if (token !== homeView.token) return;

    const retry = () => {
        loadService(service, slot, token);
    };
    const channel = state.sources.find((src) => src.id === service.id);
    const rows = data.rows || [];
    // When every row fails together the cause is the same, so say it once.
    if (data.error || (rows.length && rows.every((row) => row.error))) {
        slot.replaceChildren(homeSection(service.label, null,
            homeNote(`Could not load: ${data.error || rows[0].error}`, retry, channel && (() => openSource(channel)))));
        return;
    }
    slot.replaceChildren(...rows.flatMap((row) => {
        if (row.error) return [homeSection(row.title, service, homeNote(`Could not load: ${row.error}`, retry))];
        if (!row.items.length) return [];
        return [homeSection(row.title, service, shelf(row.items.map((item) => homeCard(item, service.id))))];
    }));
}

function paintRecent(recent) {
    const slot = $('#home-recent');
    if (!slot) return;
    const focused = document.activeElement?.closest?.('[data-entry]')?.dataset.entry;
    slot.replaceChildren(...(recent.length ? [homeSection('Jump back in', null, shelf(recent.map((entry) => homeCard({
        ...entry.item, type: entry.type, title: entry.title, subtitle: entry.subtitle, artwork: entry.artwork,
    }, entry.source, { replay: entry.item, id: entry.id }))), clearButton())] : []));
    if (focused) slot.querySelector(`[data-entry="${focused}"] .card`)?.focus();
}

function clearButton() {
    return h('button', { class: 'pill small quiet', 'aria-label': 'Clear recently played', text: 'Clear', onclick: clearRecent });
}

async function clearRecent() {
    const yes = await confirmDialog({
        question: 'Clear recently played?', detail: 'This removes everything from Jump back in.', confirm: 'Clear',
    });
    if (!yes) return;
    try {
        await api('/home/recent', { method: 'DELETE' });
    } catch (err) {
        return toast(err.message, true);
    }
    paintRecent([]);
    showFirstRunHint();
    // The button that had focus is gone; keep the keyboard at the top of the page.
    const first = $('#content h3');
    first.tabIndex = -1;
    first.focus({ preventScroll: true });
    toast('Cleared recently played');
}

/** Plays count as new history, so what is showing may be out of date. */
function refreshRecent() {
    clearTimeout(homeView.recentTimer);
    homeView.recentTimer = setTimeout(async () => {
        if (!homeVisible()) return;
        try {
            const { recent } = await api('/home');
            if (homeVisible()) paintRecent(recent);
        } catch { /* the next visit loads it again */ }
    }, 400);
}

let sectionCount = 0;
function homeSection(title, service, body, action = null) {
    const id = `home-section-${++sectionCount}`;
    const shelfEl = body.classList?.contains('shelf') ? body : null;
    return h('section', { class: 'home-section', 'aria-labelledby': id },
        h('div', { class: 'home-head' },
            h('h3', { id, text: title }),
            service ? h('button', { class: 'chip home-from', 'aria-label': `Open ${service.label}`, onclick: () => {
                const src = state.sources.find((entry) => entry.id === service.id);
                if (src) openSource(src);
            } }, SHORT[service.id] || service.label, h('i', { class: 'g g-right', 'aria-hidden': 'true' })) : null,
            action,
            shelfEl ? shelfArrows(shelfEl) : null),
        body);
}

function homeNote(message, retry, openChannel) {
    return h('p', { class: 'home-note' }, message,
        retry ? h('button', { class: 'pill small', text: 'Try again', onclick: retry }) : null,
        openChannel ? h('button', { class: 'pill small', text: 'Open channel', onclick: openChannel }) : null);
}

function shelf(cards) {
    return h('ul', { class: 'shelf' }, cards.map((card) => h('li', {}, card)));
}

/** Scroll buttons for mouse users; touch scrolls the row directly. */
function shelfArrows(row) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const step = (direction) => row.scrollBy({
        left: direction * Math.max(200, row.clientWidth * 0.8), behavior: reduce.matches ? 'auto' : 'smooth',
    });
    const button = (direction, label, glyph) => h('button', {
        class: 'pill icon small', 'aria-label': label, onclick: () => step(direction),
    }, h('i', { class: `g g-${glyph}`, 'aria-hidden': 'true' }));
    const back = button(-1, 'Scroll left', 'left');
    const forward = button(1, 'Scroll right', 'right');
    const wrap = h('span', { class: 'home-arrows', hidden: true }, back, forward);
    const paint = () => {
        const room = row.scrollWidth - row.clientWidth;
        wrap.hidden = room <= 4;
        back.disabled = row.scrollLeft <= 2;
        forward.disabled = row.scrollLeft >= room - 2;
    };
    row.addEventListener('scroll', paint, { passive: true });
    new ResizeObserver(paint).observe(row);
    return wrap;
}

/**
 * A cover with its title. Albums and playlists open on tap with a round button to play
 * them whole, as in the library; stations, tracks and replays play on tap.
 */
function homeCard(item, source, { replay = null, id = null } = {}) {
    const playable = Boolean(replay) || item.type === 'track' || item.type === 'station';
    const cover = artwork(item);
    if (replay) cover.append(h('span', { class: 'tag', text: SHORT[source] || source }));
    const subtitle = item.type === 'track' && item.artist ? item.artist : item.subtitle;
    const card = h('button', {
        class: 'card',
        onclick: () => (playable ? play(replay || item, { source, name: item.title }) : openInLibrary(source, item)),
    }, cover, h('span', { class: 't', text: item.title || '' }), h('span', { class: 's', text: subtitle || '' }));
    const wrap = h('div', { class: 'card-wrap' }, card, playable
        ? h('span', { class: 'play-all', 'aria-hidden': 'true' }, h('i', { class: 'g g-right' }))
        : h('button', {
            class: 'play-all', 'aria-label': `Play ${item.title}`, title: 'Play all',
            onclick: () => play(item, { source, name: item.title }),
        }, h('i', { class: 'g g-right', 'aria-hidden': 'true' })));
    if (id) wrap.dataset.entry = id;
    return wrap;
}

/** Opens a card's album or playlist in its library, with Back returning to home. */
function openInLibrary(sourceId, item) {
    if (!state.sources.some((src) => src.id === sourceId)) return;
    state.activeSource = sourceId;
    state.stack = [{ render: goHome }];
    sourcesSignature = '';
    renderSources();
    $('#content').dataset.view = sourceId;
    browse(item.id, item.title, 0, isContainer(item) ? item : null);
}

/** Makes a channel the current one and clears the page for its view. */
function enterSource(src) {
    setSourcesOpen(false);
    state.activeSource = src.id;
    state.stack = [];
    sourcesSignature = '';
    renderSources();
    $('#content').dataset.view = src.id;
    $('#content').replaceChildren(h('p', { class: 'empty', text: 'Loading…' }));
}

async function openSource(src) {
    enterSource(src);

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
        if (problem) return renderSettings(src, { problem });
        // With an account signed in, Spotify opens its library; the receiver is one of its entries.
        if (src.id === 'spotify') {
            const info = await api('/sources/spotify/info').catch(() => null);
            if (info?.web?.state === 'connected') return browse('');
        }
        return renderReceiver(src);
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

async function browse(path, label, offset = 0, container = null) {
    const id = state.activeSource;
    const src = state.sources.find((s) => s.id === id);

    // Link-based sources have no library to page through, so their root is the
    // paste box rather than an empty grid. Reached again when backing out of a playlist.
    if (!path && (id === 'ytdlp' || id === 'ytmusic')) return renderLinks(src);

    setToolbar({
        title: label || src?.label || '',
        back: state.stack.length > 0,
        search: id === 'spotify' ? Boolean(src?.capabilities?.search) : !NO_SEARCH.has(id),
        settings: path ? null : settingsAction(src),
        pages: true,
    });
    const content = $('#content');
    content.dataset.view = id;
    content.className = '';
    content.replaceChildren(h('p', { class: 'empty', text: 'Loading…' }));

    try {
        const wantsPrimary = !path && src?.suggests;
        const [result, primary] = await Promise.all([
            api(`/sources/${id}/browse?path=${encodeURIComponent(path)}&offset=${offset}&limit=100`),
            wantsPrimary ? api('/home/primary').catch(() => null) : null,
        ]);
        if (state.activeSource !== id) return;
        const items = result.items.length > 100 ? result.items.slice(offset, offset + 100) : result.items;
        setPager(result.total, offset, items.length, (to) => browse(path, label, to, container));
        if (result.unavailable) {
            // Spotify keeps this playlist's tracks from the app, which is not the same as having none.
            content.replaceChildren(h('div', { class: 'panel' },
                h('h3', { text: items[0].title }),
                h('p', { class: 'hint', text: items[0].subtitle })));
            return;
        }
        renderItems(items, path, label, offset, container);
        if (primary) content.prepend(primaryRow(src, primary));
    } catch (err) {
        content.replaceChildren(...kids([id === 'spotify' ? spotifyProblem(src, err.message) : null]));
        toast(err.message, true);
    }
}

/** Why a Spotify page could not load, with the way to the settings where it is fixed. */
function spotifyProblem(src, message) {
    return h('div', { class: 'panel' },
        h('p', { class: 'notice error', text: message }),
        h('div', { class: 'buttons' },
            h('button', { class: 'pill small primary', text: 'Spotify settings', onclick: () => renderSettings(src) })));
}

// A library channel says whether its suggestions fill the home screen, and offers to make them.
function primaryRow(src, primary) {
    const row = h('div', { class: 'primary-row' });
    const paint = (current) => {
        if (current.id === src.id) {
            row.replaceChildren(h('span', { class: 'chip live', id: 'primary-badge', tabindex: '-1',
                title: 'The home screen suggests music from this service', text: 'Primary' }));
            return;
        }
        row.replaceChildren(h('button', { class: 'pill small quiet', text: 'Set as primary', onclick: async () => {
            const yes = await confirmDialog({
                question: 'Set as primary?', detail: 'This will affect suggestions on the home screen.', confirm: 'Set as primary',
            });
            if (!yes) return;
            try {
                paint(await api('/home/primary', { method: 'POST', body: { id: src.id } }));
            } catch (err) {
                return toast(err.message, true);
            }
            $('#primary-badge')?.focus();
            toast(`${SHORT[src.id] || src.label} is now the primary`);
        } }));
    };
    paint(primary);
    return row;
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
    const placeholder = () => frame.append(h('span', { class: `ph${item.type === 'station' ? ' live' : ''}`, 'aria-hidden': 'true' }));
    if (!url) {
        placeholder();
        return frame;
    }
    const img = h('img', { src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.onerror = () => {
        img.remove();
        placeholder();
    };
    frame.append(img);
    return frame;
}

function renderItems(items, path, label, offset = 0, container = null) {
    const content = $('#content');
    content.replaceChildren();
    content.className = '';

    if (!items.length) {
        content.append(h('p', { class: 'empty', text: 'Nothing here.' }));
        return;
    }

    const open = (item) => {
        if (item.unavailable) return toast(item.subtitle || 'That cannot be played', true);
        // A track inside an album or playlist queues all of it from that track.
        if (item.type === 'track') {
            return play(playRequest(item, { container, offset, index: items.indexOf(item) }), { name: item.title });
        }
        if (item.type === 'station') return play(item);
        // Folders and containers drill in.
        state.stack.push({ path, label, offset, container });
        browse(item.id, item.title, 0, isContainer(item) ? item : null);
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

async function play(item, { source = state.activeSource, name = item.title } = {}) {
    try {
        await api(`/sources/${source}/play`, { method: 'POST', body: item });
        toast(`Playing ${name}`);
        refreshRecent();
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
                browse(`list/${url()}`, 'Link contents', 0, { id: `list/${url()}`, type: 'playlist', title: 'Link contents' });
            } })),
        h('div', { id: 'favorites' }),
        h('p', { class: 'hint', text: music
            ? 'Search songs, albums and playlists with the box above. A playlist or album link queues the whole thing. For Premium quality and your own library, add your browser cookies in Settings.'
            : 'Plays links from YouTube, SoundCloud, Bandcamp, Mixcloud and many more sites, with yt-dlp. A playlist, album or channel link queues the whole thing. Or search YouTube with the box above.' })));

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
            src.id === 'spotify' && info.web ? spotifyInvite(src, info.web) : null,
            h('div', { class: 'buttons' },
                running
                    ? h('button', { class: 'pill', text: 'Stop receiver', onclick: () => control('stop') })
                    : h('button', { class: 'pill primary', text: 'Start receiver',
                        onclick: () => play({ id: 'receiver', type: 'station', title: name }) }),
                src.id === 'spotify' && (info.remembered || info.web?.state === 'connected')
                    ? h('button', { class: 'pill quiet', text: 'Forget this Spotify account',
                        onclick: () => forgetSpotify(running).then(draw) })
                    : null)]));
    };
    await draw();
    state.panelTimer = setInterval(draw, 3000);
}

async function forgetSpotify(running) {
    const yes = await confirmDialog({
        question: 'Forget this Spotify account?',
        detail: 'WiiJukebox stops the receiver, forgets the account that signed in to it and disconnects ' +
            'browsing. The next person to choose it in their Spotify app signs it in again. ' +
            'Your Client ID stays in Settings.',
        confirm: 'Forget',
    });
    if (!yes) return;
    try {
        if (running) await api('/control/stop', { method: 'POST', body: {} });
        await api('/sources/spotify/action/forget-account', { method: 'POST', body: {} });
        toast('Forgot the Spotify account');
    } catch (err) {
        toast(err.message, true);
    }
}

/** What the receiver page says about signing in to Spotify, when no account is connected. */
function spotifyInvite(src, web) {
    const text = {
        'no-client-id': 'Add your own free Spotify app to browse your library and control playback from here and the Wii.',
        'not-connected': 'Connect your Spotify account to browse your library and control playback from here and the Wii.',
    }[web.state] || web.message;
    return h('div', { class: 'notice' },
        h('p', { text }),
        h('div', { class: 'buttons' }, h('button', {
            class: 'pill small primary', onclick: () => renderSettings(src),
            text: web.state === 'reconnect' ? 'Reconnect Spotify' : 'Set up Spotify account',
        })));
}

// --- settings ------------------------------------------------------------------

const f = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });
// What a channel's short name leaves out, above its settings.
const INTRO = {
    subsonic: 'Navidrome, or any other Subsonic-compatible server, such as Gonic, Airsonic-Advanced or Ampache.',
    ytdlp: 'Plays links from YouTube, SoundCloud, Bandcamp, Mixcloud and many more sites, with yt-dlp.',
};

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
        f('clientId', 'Client ID', 'text', {
            account: true, placeholder: '32 letters and digits',
            hint: 'From your own free app at developer.spotify.com/dashboard.',
        }),
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
    const ticket = navigations;
    let current = { values: {}, secrets: {} };
    let web = null;
    if (fields) {
        try { current = await api(`/sources/${src.id}/settings`); } catch { /* a fresh source has nothing saved */ }
    }
    if (src.id === 'spotify') web = (await api('/sources/spotify/info').catch(() => null))?.web || null;
    // Title and form change together, so a slow reply never shows the new title over the old page.
    if (navigations !== ticket) return;
    setToolbar({ title: `${src.label} setup`, back: false });
    const content = $('#content');
    content.className = '';

    if (!fields) {
        content.replaceChildren(h('p', { class: 'empty', text: `${src.label} has no settings yet.` }));
        return;
    }

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

    const basic = fields.filter((fld) => !fld.advanced && !fld.account).map(fieldFor);
    const advanced = fields.filter((fld) => fld.advanced).map(fieldFor);
    const account = fields.filter((fld) => fld.account).map(fieldFor);

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
        INTRO[src.id] ? h('p', { class: 'hint', text: INTRO[src.id] }) : null,
        problem ? h('p', { class: 'notice error', text: problem }) : null,
        web ? spotifyAccount({
            web, field: account, input: inputs.get('clientId'), saved: current.values.clientId || '',
            onSaved: (id) => { current.values.clientId = id; },
        }) : null,
        basic,
        advanced.length ? h('details', { class: 'advanced', open: problem ? true : null },
            h('summary', { text: 'Advanced' }), h('div', { class: 'form' }, advanced)) : null,
        h('div', { class: 'buttons' },
            h('button', { class: 'pill primary', id: 'save-src', text: ['spotify', 'airplay', 'ytmusic', 'ytdlp'].includes(src.id) ? 'Save' : 'Connect', onclick: save })))]));
}

// --- Spotify account -------------------------------------------------------------

const ACCOUNT_CHIPS = {
    connected: ['Connected', 'live'],
    'not-connected': ['Not connected', ''],
    'no-client-id': ['Needs a Client ID', ''],
    reconnect: ['Reconnect needed', 'bad'],
};

const SETUP_STEPS = [
    () => ['Create a free app at ', h('a', {
        href: 'https://developer.spotify.com/dashboard', target: '_blank', rel: 'noopener',
        text: 'developer.spotify.com/dashboard',
    }), '. The app owner needs Spotify Premium.'],
    () => ['Under Redirect URIs, add the address below exactly as shown.'],
    () => ['Under User Management, add your Spotify account (an app in development mode allows 5 people).'],
    () => ['Paste the app’s Client ID here, then press Connect.'],
];

/** Puts text on the clipboard. Only secure pages get the clipboard API, so a plain-HTTP address needs the old route. */
async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const area = h('textarea', { readonly: true, style: 'position:fixed;top:0;opacity:0' });
        area.value = text;
        document.body.append(area);
        area.select();
        const done = document.execCommand?.('copy') === true;
        area.remove();
        return done;
    }
}

function proofList(steps) {
    const verdict = { true: ['Pass', 'live'], false: ['Fail', 'bad'], null: ['Skipped', ''] };
    return h('ul', { class: 'proof' }, steps.map((step) => {
        const [text, tone] = verdict[step.ok];
        return h('li', {},
            h('span', { class: `chip ${tone}`.trim(), text }),
            h('span', { class: 'meta' },
                h('strong', { text: step.name }),
                step.detail ? h('span', { class: 'hint', text: step.detail }) : null));
    }));
}

/** The account half of Spotify's settings: the Client ID, the address to register, signing in and the connection test. */
function spotifyAccount({ web: first, field, input, saved, onSaved }) {
    let web = first;
    let busy = false;
    let results = null;
    const box = h('section', { class: 'panel account', 'aria-label': 'Spotify account' });

    const refresh = async () => {
        web = (await api('/sources/spotify/info')).web;
        paint();
    };

    // Spotify signs in on the computer's own browser; the desktop app hands the link to it.
    const connect = async () => {
        const id = input.value.trim();
        if (!id) {
            toast('Paste your Spotify Client ID first', true);
            input.focus();
            return;
        }
        try {
            if (id !== saved) {
                await api('/sources/spotify/config', { method: 'POST', body: { clientId: id } });
                saved = id;
                onSaved(id);
                await refresh();
            }
            if (!web.loginUrl) throw new Error('The server address is not known yet.');
            window.open(web.loginUrl, '_blank', 'noopener');
            stopPanelTimer();
            state.panelTimer = setInterval(async () => {
                try {
                    await refresh();
                } catch {
                    return;
                }
                if (web.state === 'connected') {
                    stopPanelTimer();
                    toast(`Connected to Spotify as ${web.account}`);
                }
            }, 2000);
        } catch (err) {
            toast(err.message, true);
        }
    };

    const test = async (play) => {
        if (play) {
            const yes = await confirmDialog({
                question: 'Play a test song?',
                detail: 'This starts the receiver and plays your first Liked Song into the stream, ' +
                    'so the Wii will hear it.',
                confirm: 'Play',
            });
            if (!yes) return;
        }
        busy = play ? 'song' : 'check';
        paint();
        try {
            const body = { play, wait: 30 };
            results = (await api('/sources/spotify/action/proof', { method: 'POST', body })).steps;
        } catch (err) {
            results = [{ name: 'Test', ok: false, detail: err.message }];
        }
        busy = false;
        paint();
    };

    const disconnect = async () => {
        const yes = await confirmDialog({
            question: 'Disconnect Spotify?',
            detail: 'WiiJukebox forgets this sign-in. You can connect again at any time.',
            confirm: 'Disconnect',
        });
        if (!yes) return;
        try {
            await api('/sources/spotify/action/disconnect-account', { method: 'POST', body: {} });
            results = null;
            await refresh();
            toast('Disconnected from Spotify');
        } catch (err) {
            toast(err.message, true);
        }
    };

    const copy = async () => {
        const copied = await copyText(web.redirectUri);
        toast(copied ? 'Copied the redirect address' : 'Select the address and copy it');
    };

    function paint() {
        const connected = web.state === 'connected';
        const [chipText, chipTone] = ACCOUNT_CHIPS[web.state] || ACCOUNT_CHIPS['not-connected'];
        const button = (props) => h('button', { type: 'button', ...props });
        box.replaceChildren(...kids([
            h('div', { class: 'status-line' },
                h('h3', { text: 'Spotify account' }),
                h('span', { class: `chip ${chipTone}`.trim(), text: chipText })),
            connected ? h('p', {
                class: 'hint', text: `Signed in as ${web.account || 'your account'}. Browsing and playing use it.`,
            }) : null,
            web.state === 'reconnect' ? h('p', { class: 'notice error', text: web.message }) : null,
            connected || web.state === 'reconnect' ? null
                : h('ol', { class: 'steps' }, SETUP_STEPS.map((step) => h('li', {}, ...step()))),
            field,
            h('div', { class: 'field' }, 'Redirect address',
                h('div', { class: 'copy-row' },
                    h('code', { class: 'addr', text: web.redirectUri || 'Not known until the server is running' }),
                    button({ class: 'pill small', text: 'Copy', disabled: !web.redirectUri, onclick: copy })),
                h('span', {
                    class: 'field-hint',
                    text: 'Spotify only returns to 127.0.0.1, so connect from a browser on the computer ' +
                        'that runs WiiJukebox.',
                })),
            h('div', { class: 'buttons' },
                connected ? null : button({
                    class: 'pill primary', onclick: connect,
                    text: web.state === 'reconnect' ? 'Reconnect Spotify' : 'Connect Spotify account',
                }),
                connected ? button({
                    class: 'pill', disabled: Boolean(busy), onclick: () => test(false),
                    text: busy === 'check' ? 'Testing…' : 'Test connection',
                }) : null,
                connected ? button({
                    class: 'pill', disabled: Boolean(busy), onclick: () => test(true),
                    text: busy === 'song' ? 'Playing…' : 'Play a test song',
                }) : null,
                connected ? button({ class: 'pill quiet', text: 'Disconnect', onclick: disconnect }) : null),
            results ? proofList(results) : null,
        ]));
    }
    paint();
    return box;
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

const NEXT_REPEAT = { off: 'all', all: 'one', one: 'off' };

function applyModes(modes = {}, caps) {
    // A source that cannot use a mode shows it neutral, not lit.
    const shuffle = caps.shuffle && modes.shuffle === true;
    const repeat = caps.repeat && NEXT_REPEAT[modes.repeat] ? modes.repeat : 'off';
    const shuffleButton = $('#shuffle');
    shuffleButton.disabled = !caps.shuffle;
    shuffleButton.classList.toggle('lit', shuffle);
    shuffleButton.setAttribute('aria-pressed', String(shuffle));
    shuffleButton.title = `Shuffle ${shuffle ? 'on' : 'off'}`;
    const repeatButton = $('#repeat');
    repeatButton.disabled = !caps.repeat;
    repeatButton.classList.toggle('lit', repeat !== 'off');
    repeatButton.dataset.repeat = repeat;
    repeatButton.title = `Repeat ${{ off: 'off', all: 'all tracks', one: 'this track' }[repeat]}`;
    repeatButton.setAttribute('aria-label', repeatButton.title);
}

function applyStatus(status) {
    state.status = status;
    const playingKey = `${status.source?.id}|${status.nowPlaying?.title}`;
    if (state.playingKey !== undefined && playingKey !== state.playingKey && homeVisible()) refreshRecent();
    state.playingKey = playingKey;
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
    applyModes(status.modes, caps);
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
    es.addEventListener('sources', (e) => {
        if (!hidePending) applyHidden(JSON.parse(e.data).hidden);
    });
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
        // Leave fullscreen before hiding the stage: hiding it first left Windows' page still fullscreen.
        if (document.fullscreenElement === $('#viz-stage')) await document.exitFullscreen().catch(() => {});
        document.body.classList.remove('viz');
        paintThemeColor();
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
    paintThemeColor();
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

function fitVisualizer() {
    if (!viz.instance) return;
    const canvas = $('#visualizer');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    viz.instance.setRendererSize(canvas.width, canvas.height);
}
window.addEventListener('resize', fitVisualizer);

// --- fullscreen ----------------------------------------------------------
//
// F11 fullscreens the visualizer's stage while it is up, so the top layer covers every bar around it,
// and the page otherwise. Same approach as Feishin's F11 fix.

function toggleFullscreen() {
    if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
        return;
    }
    const target = document.body.classList.contains('viz') ? $('#viz-stage') : document.documentElement;
    target.requestFullscreen?.()?.catch(() => {});
}

function syncFullscreenButton() {
    const on = Boolean(document.fullscreenElement);
    const button = $('#viz-fullscreen');
    const label = on ? 'Exit fullscreen' : 'Enter fullscreen';
    button.setAttribute('aria-label', label);
    button.title = `${label} (F11)`;
    button.querySelector('.g').className = on ? 'g g-shrink' : 'g g-expand';
    fitVisualizer();
}

// Capture phase, so it still fires while a text field has focus.
window.addEventListener('keydown', (event) => {
    if (event.key !== 'F11') return;
    event.preventDefault();
    toggleFullscreen();
}, true);
document.addEventListener('fullscreenchange', syncFullscreenButton);
$('#viz-fullscreen').hidden = !document.fullscreenEnabled;
$('#viz-fullscreen').onclick = toggleFullscreen;

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

// --- theme and the page menu -------------------------------------------------
//
// Light, Dark or System. The choice lives in localStorage and shows as data-theme on <html> (no attribute
// means System); the inline script in index.html applies it before first paint.

const THEMES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
const THEME_COLORS = { light: '#f3f6f9', dark: '#0d141c' };
let themeChoice = 'system';

function savedTheme() {
    const saved = prefs.get('theme');
    return saved === 'light' || saved === 'dark' ? saved : 'system';
}

function applyTheme(choice) {
    holdTransitions();
    themeChoice = choice;
    if (choice === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = choice;
    paintThemeColor();
}

// Controls fade their colors on hover; without this a theme switch repaints them a beat after everything else.
function holdTransitions() {
    const root = document.documentElement;
    root.classList.add('theme-switching');
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
}

// Browsers tint their own bars from this, and the desktop app's title bar follows it as it changes.
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
function paintThemeColor() {
    const dark = themeChoice === 'system' ? systemDark.matches : themeChoice === 'dark';
    const color = THEME_COLORS[dark ? 'dark' : 'light'];
    document.querySelector('meta[name="theme-color"]').content = color;
    // The Android app's status bar icons sit on the page, so they follow its theme, and the visualizer's dark.
    window.WiiJukeboxApp?.setTheme?.(color, dark || document.body.classList.contains('viz'));
}
systemDark.addEventListener('change', () => {
    if (themeChoice === 'system') holdTransitions();
    paintThemeColor();
});

function chooseTheme(choice) {
    applyTheme(choice);
    prefs.set('theme', choice === 'system' ? null : choice);
}

for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.onclick = () => chooseTheme(button.dataset.themeChoice);
}
applyTheme(savedTheme());

// The toolbar's menu button: Theme and Sidebar settings. The desktop app has its own menu and hides this one.
const pageMenu = $('#page-menu');
const PAGE_MENU_WIDTH = 208;

pageMenu.onclick = (event) => {
    const box = pageMenu.getBoundingClientRect();
    openMenu({
        label: 'Menu', trigger: pageMenu, width: PAGE_MENU_WIDTH,
        anchor: { x: box.right - PAGE_MENU_WIDTH, top: box.bottom + 4, bottom: box.top - 4, keyboard: event.detail === 0 },
        items: [
            { heading: 'Theme' },
            ...THEMES.map(([id, label]) => ({ label, checked: themeChoice === id, run: () => chooseTheme(id) })),
            'separator',
            { label: 'Sidebar settings…', run: openSidebarSettings },
            ...(window.WiiJukeboxApp ? [{ label: 'Switch server…', run: () => window.WiiJukeboxApp.switchServer() }] : []),
        ],
    });
};

// --- now-playing column --------------------------------------------------
//
// On wide screens the column can be dragged wider or narrower and minimized into the transport bar. Its width
// stays even, so the controls centered in it sit on whole pixels; both settings are kept per device.

const NP = { min: 280, max: 520, step: 10, libraryMin: 360 };
const npRoot = document.documentElement;
const npResizer = $('#np-resizer');
const savedWidth = Number(prefs.get('np-width'));
let npWidth = savedWidth >= NP.min && savedWidth <= NP.max ? savedWidth : null;

const evenPx = (n) => Math.round(n / 2) * 2;

// The widest column that still leaves the library its room.
function npLimit() {
    const room = window.innerWidth - $('#sidebar').offsetWidth - NP.libraryMin;
    return Math.max(NP.min, Math.min(NP.max, room - (room % 2)));
}

function syncNowPlayingColumn() {
    const label = PHONE.matches ? 'Hide now playing' : 'Minimize to the bottom bar';
    $('#np-close').setAttribute('aria-label', label);
    $('#np-close').title = label;
    if (PHONE.matches) return;
    if (npWidth === null) npRoot.style.removeProperty('--np-w');
    else npRoot.style.setProperty('--np-w', `${Math.min(npLimit(), Math.max(NP.min, evenPx(npWidth)))}px`);
    const width = $('#nowplaying').offsetWidth;
    if (!width) return;
    npResizer.setAttribute('aria-valuemax', String(npLimit()));
    npResizer.setAttribute('aria-valuenow', String(width));
}

// A null width goes back to the stylesheet's own.
function setNowPlayingWidth(width, { save = true } = {}) {
    npWidth = width === null ? null : Math.min(npLimit(), Math.max(NP.min, evenPx(width)));
    syncNowPlayingColumn();
    if (save) prefs.set('np-width', npWidth === null ? null : String(npWidth));
}

function setNowPlayingCollapsed(collapsed) {
    npRoot.classList.toggle('np-collapsed', collapsed);
    prefs.set('np-collapsed', collapsed ? '1' : null);
    syncNowPlayingColumn();
}

npResizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    npResizer.setPointerCapture(event.pointerId);
    npRoot.classList.add('np-resizing');
    const startX = event.clientX;
    const startWidth = $('#nowplaying').offsetWidth;
    const move = (e) => setNowPlayingWidth(startWidth + startX - e.clientX, { save: false });
    const stop = () => {
        for (const [type, handler] of [['pointermove', move], ['pointerup', stop], ['pointercancel', stop]]) npResizer.removeEventListener(type, handler);
        npRoot.classList.remove('np-resizing');
        prefs.set('np-width', npWidth === null ? null : String(npWidth));
    };
    npResizer.addEventListener('pointermove', move);
    npResizer.addEventListener('pointerup', stop);
    npResizer.addEventListener('pointercancel', stop);
});
npResizer.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? NP.step * 5 : NP.step;
    const now = $('#nowplaying').offsetWidth;
    const next = { ArrowLeft: now + step, ArrowRight: now - step, Home: NP.min, End: npLimit() }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setNowPlayingWidth(next);
});
npResizer.addEventListener('dblclick', () => setNowPlayingWidth(null));
window.addEventListener('resize', syncNowPlayingColumn);

$('#home-link').onclick = goHome;
$('#sources-toggle').onclick = () => setSourcesOpen(!document.body.classList.contains('sources-open'));
$('#sources-close').onclick = () => setSourcesOpen(false);
$('#sidebar-shade').onclick = () => setSourcesOpen(false);
$('#mini-open').onclick = async () => {
    if (document.body.classList.contains('viz')) await toggleVisualizer();
    if (PHONE.matches) setNowPlayingOpen(true);
    else setNowPlayingCollapsed(false);
};
$('#np-close').onclick = () => {
    if (PHONE.matches) {
        setNowPlayingOpen(false);
        return;
    }
    setNowPlayingCollapsed(true);
    $('#mini-expand').focus();
};
$('#mini-expand').onclick = () => {
    setNowPlayingCollapsed(false);
    $('#np-close').focus();
};
PHONE.addEventListener('change', () => {
    closeMenu();
    setSourcesOpen(false);
    setNowPlayingOpen(false);
    syncNowPlayingColumn();
});
syncNowPlayingColumn();

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        // A dialog answers its own Escape.
        if (document.querySelector('dialog[open]')) return;
        // In fullscreen Escape only leaves it; the visualizer closes on the next press.
        if (document.fullscreenElement) return;
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
    else if (prev) browse(prev.path, prev.label, prev.offset, prev.container);
};

// The Android app asks this on its back button; true means the page used it.
window.wiiJukeboxBack = () => {
    const dialog = document.querySelector('dialog[open]');
    if (closeMenu({ restoreFocus: true })) return true;
    if (dialog) dialog.close('cancel');
    else if (document.body.classList.contains('viz')) toggleVisualizer();
    else if (document.body.classList.contains('np-open')) setNowPlayingOpen(false);
    else if (document.body.classList.contains('sources-open')) setSourcesOpen(false);
    else if (!$('#back').hidden) $('#back').click();
    else if (state.activeSource !== null) goHome();
    else return false;
    return true;
};

for (const [ids, action] of [[['#prev', '#mini-prev'], 'previous'], [['#next', '#mini-next'], 'next'], [['#stop'], 'stop']]) {
    for (const id of ids) $(id).onclick = () => control(action);
}
$('#shuffle').onclick = () => control('shuffle', { value: !state.status?.modes?.shuffle });
$('#repeat').onclick = () => control('repeat', { value: NEXT_REPEAT[state.status?.modes?.repeat] || 'all' });
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
        $('#wii-address').textContent = `If it can't find the server, press HOME on the Wii, choose Server address and type this address: ${settings.hostIp}:${settings.port}`;
    } catch {
        /* non-fatal; the setup panel just shows less */
    }
    await loadSources();
    $('#content').dataset.view = 'home';
    renderHome();
    connectEvents();
})();
