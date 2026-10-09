// SPDX-License-Identifier: GPL-3.0-only
// The web UI keeps its own theme choice (System, Light or Dark in localStorage, shown as data-theme on
// <html>). The app never gives the page a bridge: it reads that choice, and sets it by pressing the page's own control.

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

/** What the title bar and the dialogs are told: the forced theme, or null to follow the system like the page does. */
const forcedTheme = (choice) => (choice === 'light' || choice === 'dark' ? choice : null);

/**
 * Asks the page for its theme every `intervalMs` and reports changes only, so a choice made in the page
 * (not just in the app's menu) reaches the title bar. `read` resolves to a choice, or null when there is no page to ask.
 */
class ThemeFeed {
    constructor({ read, onChange, intervalMs = 1000 }) {
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

module.exports = { CHOICES, READ_THEME, parsePageTheme, chooseThemeScript, forcedTheme, ThemeFeed };
