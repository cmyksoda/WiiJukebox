// SPDX-License-Identifier: GPL-3.0-only
// The web UI keeps its own theme choice (System, Light or Dark in localStorage, shown as data-theme on
// <html>). The app never gives the page a bridge: it reads that choice, and sets it by pressing the page's own control.
// Its Sidebar settings sheet is opened the same way.

const CHOICES = ['system', 'light', 'dark'];

// What the page shows right now. A page with no data-theme (the setup pages) follows the system.
const READ_THEME = `(() => {
    const choice = document.documentElement.dataset.theme;
    return JSON.stringify({ choice: choice === 'light' || choice === 'dark' ? choice : 'system' });
})()`;

/** The choice in a READ_THEME answer, or null when the answer is not one. */
function parsePageTheme(raw) {
    try {
        const { choice } = JSON.parse(raw);
        return CHOICES.includes(choice) ? choice : null;
    } catch {
        return null;
    }
}

/** Script that presses the page's own System, Light or Dark control, so the page does all of its own bookkeeping. */
function chooseThemeScript(choice) {
    if (!CHOICES.includes(choice)) throw new Error(`unknown theme: ${choice}`);
    return `document.querySelector('[data-theme-choice="${choice}"]')?.click()`;
}

/** Script that presses the page's own control for its Sidebar settings sheet. */
const OPEN_SIDEBAR_SETTINGS = `document.querySelector('#sidebar-settings')?.click()`;

const hexChannels = (hex) => {
    const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join('') : hex;
    return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16));
};

// The channels of "#rgb", "#rrggbb" (either with an alpha) or "rgb(r, g, b)", or null for any other string.
function colorChannels(color) {
    if (typeof color !== 'string') return null;
    const text = color.trim().toLowerCase();
    if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(text)) return hexChannels(text.slice(1));
    const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(text);
    return rgb ? rgb.slice(1).map(Number) : null;
}

/**
 * Whether the page's theme-color tag names a dark background: its relative luminance is below the point where black
 * and white text read equally well. Null for no color, or one that cannot be read.
 */
function isDarkColor(color) {
    const channels = colorChannels(color);
    if (!channels) return null;
    const [r, g, b] = channels.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.179;
}

/** What the title bar and the dialogs are told: the forced theme, or null to follow the system like the page does. */
const forcedTheme = (choice) => (choice === 'light' || choice === 'dark' ? choice : null);

/**
 * Reads which choice (System, Light or Dark) the page has and reports changes only. The page's theme-color tag
 * tells the app about a change at once; this is asked then, and on a slow timer in case the tag did not change
 * (System to Light on a light system). `read` resolves to a choice, or null when there is no page to ask.
 */
class ThemeFeed {
    constructor({ read, onChange, intervalMs = 5000 }) {
        this.read = read;
        this.onChange = onChange;
        this.intervalMs = intervalMs;
        this.choice = null;
        this.timer = null;
        this.paused = false;
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => this.poll(), this.intervalMs);
        this.timer.unref?.();
        this.poll();
    }

    stop() {
        clearInterval(this.timer);
        this.timer = null;
    }

    /** Makes the next answer count as a change, for when what was shown may have been guessed. */
    forget() {
        this.choice = null;
    }

    /** A window hidden in the tray shows nothing that needs it. */
    pause() {
        this.paused = true;
    }

    resume() {
        this.paused = false;
        this.poll();
    }

    /** `force` asks even while paused, for a choice just made from a menu. */
    async poll({ force = false } = {}) {
        if (this.paused && !force) return;
        let choice = null;
        try {
            choice = await this.read();
        } catch {
            // A page that is loading or going away has nothing to say yet.
        }
        if (!choice || choice === this.choice || (this.paused && !force)) return;
        this.choice = choice;
        this.onChange(choice);
    }
}

module.exports = { CHOICES, READ_THEME, OPEN_SIDEBAR_SETTINGS, parsePageTheme, chooseThemeScript, forcedTheme, isDarkColor, ThemeFeed };
