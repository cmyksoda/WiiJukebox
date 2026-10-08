// WiiJukebox WebUI.
//
// Deliberately dependency-free and un-built: the whole thing is three files the
// server hands over as-is. That keeps the eventual single-executable packaging
// honest -- there is no bundler step that has to happen before the app can run.

import butterchurn from './vendor/butterchurn.min.js';

const $ = (sel) => document.querySelector(sel);

const state = {
    sources: [],
    activeSource: null, // id of the source being browsed
    status: null,
    stack: [], // browse history, for the back button
};

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
    if (!seconds && seconds !== 0) return '';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

// --- sources -------------------------------------------------------------

async function loadSources() {
    const { sources } = await api('/sources');
    state.sources = sources;
    renderSources();
}

function renderSources() {
    const nav = $('#sources');
    nav.innerHTML = '';

    for (const src of state.sources) {
        const btn = document.createElement('button');
        btn.className = `source-btn ${src.state}`;
        btn.setAttribute('aria-current', String(state.activeSource === src.id));

        const playing = state.status?.source?.id === src.id;
        if (playing) btn.classList.add('playing');

        btn.innerHTML = `
            <span class="dot"></span>
            <span>
                ${src.label}
                <span class="sub">${
                    playing ? 'playing' : src.configured ? 'ready' : 'needs setup'
                }</span>
            </span>`;

        btn.onclick = () => openSource(src);
        nav.append(btn);
    }
}

async function openSource(src) {
    setSourcesOpen(false);
    state.activeSource = src.id;
    state.stack = [];
    renderSources();

    // An unconfigured server has nothing to browse, so go straight to the form
    // rather than showing an empty library and an error.
    if (!src.configured) return renderSettings(src);

    if (src.id === 'radio') return renderRadio();

    if (src.id === 'ytdlp') {
        // Connect first so a missing yt-dlp is reported here, with the install
        // hint, rather than surfacing as a puzzling failure on the first play.
        try {
            await api(`/sources/${src.id}/connect`, { method: 'POST' });
            await loadSources();
        } catch (err) {
            toast(`${src.label}: ${err.message}`, true);
        }
        return renderYtdlp();
    }

    try {
        await api(`/sources/${src.id}/connect`, { method: 'POST' });
        await loadSources();
        browse('');
    } catch (err) {
        toast(`${src.label}: ${err.message}`, true);
        renderSettings(src);
    }
}

// --- library browsing ----------------------------------------------------

async function browse(path, label, offset = 0) {
    const id = state.activeSource;

    // yt-dlp has no library to page through, so its root is the paste box
    // rather than an empty grid. Reached again when backing out of a playlist.
    if (!path && id === 'ytdlp') return renderYtdlp();

    $('#crumb').textContent = label || state.sources.find((s) => s.id === id)?.label || '';
    $('#back').hidden = state.stack.length === 0;
    $('#search').hidden = id === 'desktop';
    $('#empty').hidden = true;

    const content = $('#content');
    content.innerHTML = '<p class="empty">Loading…</p>';

    try {
        const result = await api(
            `/sources/${id}/browse?path=${encodeURIComponent(path)}&offset=${offset}&limit=100`,
        );
        if (state.activeSource !== id) return;
        const items = result.items.length > 100 ? result.items.slice(offset, offset + 100) : result.items;
        $('#pagination').hidden = result.total <= 100 && offset === 0;
        $('#library-prev').disabled = offset === 0;
        $('#library-next').disabled = offset + items.length >= result.total || !items.length;
        $('#library-page').textContent = `Page ${Math.floor(offset / 100) + 1}`;
        $('#library-prev').onclick = () => browse(path, label, Math.max(0, offset - 100));
        $('#library-next').onclick = () => browse(path, label, offset + 100);
        renderItems(items, path, label, offset);
    } catch (err) {
        content.innerHTML = '';
        toast(err.message, true);
    }
}

function renderItems(items, path, label, offset = 0) {
    const content = $('#content');
    content.innerHTML = '';

    if (!items.length) {
        content.innerHTML = '<p class="empty">Nothing here.</p>';
        return;
    }

    // Tracks read better as a list; everything else as artwork.
    const allTracks = items.every((i) => i.type === 'track');
    content.className = allTracks ? 'list' : '';

    for (const item of items) {
        const el = document.createElement('button');

        if (allTracks) {
            el.className = 'row';
            el.innerHTML = `
                ${item.artwork ? `<img src="${escapeHtml(item.artwork)}" alt="">` : '<span class="ph"></span>'}
                <span class="meta">
                    <span class="t">${escapeHtml(item.title || '')}</span>
                    <span class="s">${escapeHtml(item.subtitle || '')}</span>
                </span>
                <span class="dur">${fmtDuration(item.duration)}</span>`;
        } else {
            el.className = 'card';
            el.innerHTML = `
                ${item.artwork ? `<img src="${escapeHtml(item.artwork)}" alt="" loading="lazy">` : '<span class="ph"></span>'}
                <span class="t">${escapeHtml(item.title || '')}</span>
                <span class="s">${escapeHtml(item.subtitle || '')}</span>`;
        }

        el.onclick = () => {
            // Folders and containers drill in; anything playable plays. Albums
            // and playlists do both -- clicking one plays it whole, which is
            // what "play this album" should mean.
            if (item.type === 'track' || item.type === 'station') return play(item);
            if (item.type === 'folder' || item.type === 'artist') {
                state.stack.push({ path, label, offset });
                return browse(item.id, item.title);
            }
            state.stack.push({ path, label, offset });
            browse(item.id, item.title);
        };

        // Right-click an album or playlist to play it rather than open it.
        if (item.type === 'album' || item.type === 'playlist' || item.type === 'station') {
            el.oncontextmenu = (e) => {
                e.preventDefault();
                play(item);
            };
            el.title = 'Click to open, right-click to play';
        }

        content.append(el);
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
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
    $('#pagination').hidden = true;
    $('#crumb').textContent = 'Internet Radio';
    $('#search').hidden = true;
    $('#back').hidden = true;
    $('#empty').hidden = true;

    const content = $('#content');
    content.className = 'list';
    content.innerHTML = `
        <div class="form">
            <label>Stream URL
                <input id="radio-url" type="url" placeholder="http://ice1.somafm.com/groovesalad-128-mp3">
            </label>
            <label>Name (optional)
                <input id="radio-name" type="text" placeholder="Groove Salad">
            </label>
            <button class="btn" id="radio-play">Play</button>
            <button class="btn small" id="radio-save">Save station for Wii</button>
            <div id="favorites"></div>
        </div>`;

    bindFavorites('radio', '#radio-url', '#radio-name', '#radio-save');
    $('#radio-play').onclick = () => {
        const url = $('#radio-url').value.trim();
        if (!url) return toast('Enter a stream URL', true);
        play({ url, title: $('#radio-name').value.trim() || url, type: 'station' });
    };
}

// --- yt-dlp --------------------------------------------------------------

function renderYtdlp() {
    $('#pagination').hidden = true;
    $('#crumb').textContent = 'YouTube / SoundCloud';
    $('#back').hidden = true;
    $('#empty').hidden = true;
    // Unlike radio, the search box is useful here: it searches YouTube.
    $('#search').hidden = false;

    const content = $('#content');
    content.className = 'list';
    content.innerHTML = `
        <div class="form">
            <label>Paste a link
                <input id="yt-url" type="url"
                       placeholder="https://www.youtube.com/watch?v=…">
            </label>
            <label>Name (optional)<input id="yt-name" type="text" placeholder="My saved link"></label>
            <button class="btn" id="yt-play">Play</button>
            <button class="btn small" id="yt-save">Save link for Wii</button>
            <div id="favorites"></div>
            <button class="btn small" id="yt-open">Open as list</button>
            <p class="hint">
                A playlist, album or channel link queues the whole thing.
                Anything yt-dlp supports works — YouTube, SoundCloud, Bandcamp.
                Or search YouTube with the box above.
            </p>
        </div>`;

    bindFavorites('ytdlp', '#yt-url', '#yt-name', '#yt-save');
    const url = () => $('#yt-url').value.trim();

    $('#yt-play').onclick = () => {
        if (!url()) return toast('Paste a link first', true);
        play({ id: url(), title: url(), type: 'track' });
    };

    // Drills into a playlist instead of queueing it, for picking one track out.
    $('#yt-open').onclick = () => {
        if (!url()) return toast('Paste a link first', true);
        state.stack.push({ path: '', label: 'YouTube / SoundCloud' });
        browse(`list/${url()}`, 'Link contents');
    };

    $('#yt-url').onkeydown = (e) => {
        if (e.key === 'Enter') $('#yt-play').click();
    };
}

async function bindFavorites(source, urlInput, nameInput, saveButton) {
    const container = $('#favorites');
    const reload = async () => {
        const { items } = await api(`/sources/${source}/favorites`);
        container.replaceChildren();
        for (const item of items) {
            const row = document.createElement('div');
            const playButton = document.createElement('button');
            playButton.className = 'btn small';
            playButton.textContent = item.name;
            playButton.onclick = () => play(source === 'radio'
                ? { url: item.url, title: item.name, type: 'station' }
                : { id: item.url, title: item.name, type: 'track' });
            const remove = document.createElement('button');
            remove.className = 'btn small';
            remove.textContent = 'Remove';
            remove.onclick = async () => {
                try {
                    await api(`/sources/${source}/favorites`, { method: 'DELETE', body: { id: item.id } });
                    await reload();
                } catch (err) { toast(err.message, true); }
            };
            row.append(playButton, remove);
            container.append(row);
        }
    };
    $(saveButton).onclick = async () => {
        try {
            await api(`/sources/${source}/favorites`, { method: 'POST', body: {
                url: $(urlInput).value.trim(), name: $(nameInput).value.trim(),
            } });
            await reload();
            toast('Saved for the Wii source browser');
        } catch (err) { toast(err.message, true); }
    };
    try { await reload(); } catch (err) { toast(err.message, true); }
}

// --- settings ------------------------------------------------------------

const FIELDS = {
    plex: [
        ['url', 'Server URL', 'url', 'http://192.168.1.10:32400'],
        ['token', 'Plex token', 'password', ''],
    ],
    subsonic: [
        ['url', 'Server URL', 'url', 'https://music.example.com'],
        ['username', 'Username', 'text', ''],
        ['password', 'Password', 'password', ''],
    ],
    jellyfin: [
        ['url', 'Server URL', 'url', 'http://192.168.1.10:8096'],
        ['username', 'Username', 'text', ''],
        ['password', 'Password', 'password', ''],
    ],
};

function renderSettings(src) {
    $('#pagination').hidden = true;
    $('#crumb').textContent = `${src.label} setup`;
    $('#search').hidden = true;
    $('#back').hidden = true;
    $('#empty').hidden = true;

    const fields = FIELDS[src.id];
    const content = $('#content');
    content.className = 'list';

    if (!fields) {
        content.innerHTML = `<p class="empty">${src.label} has no settings yet.</p>`;
        return;
    }

    content.innerHTML = `
        <div class="form">
            ${fields
                .map(
                    ([key, label, type, ph]) => `
                <label>${label}
                    <input data-key="${key}" type="${type}" placeholder="${ph}"
                           autocomplete="${type === 'password' ? 'current-password' : 'off'}">
                </label>`,
                )
                .join('')}
            <button class="btn" id="save-src">Connect</button>
        </div>`;

    $('#save-src').onclick = async () => {
        const patch = {};
        for (const input of content.querySelectorAll('input[data-key]')) {
            patch[input.dataset.key] = input.type === 'password' ? input.value : input.value.trim();
        }
        try {
            await api(`/sources/${src.id}/config`, { method: 'POST', body: patch });
            await api(`/sources/${src.id}/connect`, { method: 'POST' });
            toast(`Connected to ${src.label}`);
            await loadSources();
            openSource(state.sources.find((s) => s.id === src.id));
        } catch (err) {
            toast(err.message, true);
        }
    };
}

// --- transport -----------------------------------------------------------

function applyStatus(status) {
    state.status = status;

    const np = status.nowPlaying || {};
    $('#np-title').textContent = np.title || 'Nothing playing';
    $('#np-artist').textContent = [np.artist, np.album].filter(Boolean).join(' — ');

    const art = $('#np-art');
    if (np.artwork) {
        art.src = np.artwork;
        art.hidden = false;
        $('#np-placeholder').hidden = true;
    } else {
        art.hidden = true;
        $('#np-placeholder').hidden = false;
    }

    // Enable only what the active source actually supports, so a control never
    // silently does nothing.
    const caps = status.capabilities || {};
    $('#prev').disabled = !caps.previous;
    $('#next').disabled = !caps.next;
    $('#stop').disabled = !caps.stop;
    $('#playpause').disabled = status.paused ? !caps.play : !caps.pause;
    $('#playpause').classList.toggle('show-play', !!status.paused || !status.source);
    $('#playpause').setAttribute('aria-label', status.paused ? 'Resume' : 'Pause');
    $('#playpause').title = status.paused ? 'Resume' : 'Pause';
    const capturing = status.source?.id === 'desktop';
    $('#monitor').disabled = capturing;
    if (capturing) {
        setMonitoring(false);
    }

    $('#listeners').textContent =
        status.listeners === 1 ? '1 listening' : `${status.listeners} listening`;

    renderSources();
}

async function control(action) {
    try {
        const res = await api(`/control/${action}`, { method: 'POST', body: {} });
        if (res.endOfQueue) toast('End of queue');
    } catch (err) {
        toast(err.message, true);
    }
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
    $('#monitor').setAttribute('aria-pressed', String(enabled));
    if (viz.outputGain) viz.outputGain.gain.value = enabled ? 1 : 0;
    if (!enabled && !viz.starting && !document.body.classList.contains('viz')) $('#monitor-audio').pause();
}

async function startAudio() {
    const audio = $('#monitor-audio');
    if (!audio.src) audio.src = state.mount || '/stream';

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

async function toggleVisualizer() {
    if (viz.starting) return;
    if (document.body.classList.contains('viz')) {
        document.body.classList.remove('viz');
        $('#viz-toggle').setAttribute('aria-pressed', 'false');
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

    document.body.classList.add('viz');
    $('#viz-toggle').setAttribute('aria-pressed', 'true');
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
    const modal = open && window.matchMedia('(max-width: 780px)').matches;
    $('#main').inert = modal;
    $('#player').inert = modal;
    $('#sidebar').setAttribute('role', modal ? 'dialog' : 'complementary');
    $('#sidebar').setAttribute('aria-modal', String(modal));
    if (open) $('#sources-close').focus();
    else if ($('#sidebar').contains(document.activeElement)) $('#sources-toggle').focus();
}

$('#sources-toggle').onclick = () => setSourcesOpen(!document.body.classList.contains('sources-open'));
$('#sources-close').onclick = () => setSourcesOpen(false);
$('#sidebar-shade').onclick = () => setSourcesOpen(false);
window.matchMedia('(max-width: 780px)').addEventListener('change', () => setSourcesOpen(false));
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setSourcesOpen(false);
    if (event.key === 'Tab' && $('#main').inert) {
        const targets = [...$('#sidebar').querySelectorAll('button, a[href]')].filter(el => !el.disabled);
        const first = targets[0], last = targets.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
});

$('#back').onclick = () => {
    const prev = state.stack.pop();
    if (prev) browse(prev.path, prev.label, prev.offset);
};

$('#prev').onclick = () => control('previous');
$('#next').onclick = () => control('next');
$('#stop').onclick = () => control('stop');
$('#playpause').onclick = () => control(state.status?.paused ? 'play' : 'pause');

$('#monitor').onclick = async () => {
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
};

$('#viz-toggle').onclick = toggleVisualizer;

let searchTimer;
$('#search').oninput = (e) => {
    clearTimeout(searchTimer);
    $('#pagination').hidden = true;
    const q = e.target.value.trim();
    if (!q) return;
    searchTimer = setTimeout(async () => {
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

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('viz')) toggleVisualizer();
});

(async function init() {
    try {
        const settings = await api('/settings');
        state.mount = settings.mount;
        $('#stream-addr').textContent = `Stream address: http://${settings.hostIp}:${settings.port}${settings.mount}`;
        $('#server-id').textContent = `Server ID: ${settings.serverId?.slice(0, 8) || 'unknown'}`;
    } catch {
        /* non-fatal; the setup panel just shows less */
    }
    await loadSources();
    connectEvents();
})();
