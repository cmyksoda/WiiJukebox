// SPDX-License-Identifier: GPL-3.0-only
// The custom title bar: the title on the left, window buttons on the right (none on a Mac, which keeps its own).

const api = window.titlebar;
const SUFFIX = ' — WiiJukebox';
const now = document.querySelector('#title .now');
const maximize = document.querySelector('#maximize');

document.body.dataset.platform = api.platform;

function apply({ title, maximized, focused, theme }) {
    if (typeof title === 'string') {
        // The app name stays whole while a long song name is cut short.
        now.textContent = title.endsWith(SUFFIX) ? title.slice(0, -SUFFIX.length) : '';
        document.title = title;
    }
    if (typeof maximized === 'boolean') {
        maximize.querySelector('.g').className = maximized ? 'g g-restore' : 'g g-max';
        maximize.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
        maximize.title = maximized ? 'Restore' : 'Maximize';
    }
    if (typeof focused === 'boolean') document.body.dataset.focused = String(focused);
    // The page's own choice; null leaves it to the system, as the page does.
    if (theme !== undefined) {
        if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
        else delete document.documentElement.dataset.theme;
    }
}

api.onState(apply);
api.ready().then(apply);

document.querySelector('#minimize').onclick = () => api.minimize();
maximize.onclick = () => api.toggleMaximize();
document.querySelector('#close').onclick = () => api.close();
