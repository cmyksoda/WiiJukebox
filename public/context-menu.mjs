// The page's own context menu: compact rows in the app's colors, opened by right-click, the Menu key or
// Shift+F10, or a long press on touch screens. A native menu can't follow the theme or fit this UI.

const MARGIN = 8;
const WIDTH = 256;
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;

let current = null; // { menu, trigger, stop }
let swallowClick = false;

/** True when a menu was open. Focus goes back to what opened it when asked, for Escape and Tab. */
export function closeMenu({ restoreFocus = false } = {}) {
    if (!current) return false;
    const { menu, trigger, stop } = current;
    current = null;
    stop();
    menu.remove();
    delete trigger?.dataset.menu;
    if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
    return true;
}

/**
 * `items` are { label, run } or 'separator'. `anchor` is { x, top, bottom }: the menu starts at `top` and
 * grows down, or ends at `bottom` and grows up when there is no room below.
 */
export function openMenu({ label, items, trigger, anchor }) {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', label);
    const rows = [];
    for (const item of items) {
        if (item === 'separator') {
            const line = document.createElement('div');
            line.className = 'sep';
            line.setAttribute('role', 'separator');
            menu.append(line);
            continue;
        }
        const row = document.createElement('button');
        row.type = 'button';
        row.tabIndex = -1;
        row.setAttribute('role', 'menuitem');
        row.textContent = item.label;
        row.addEventListener('click', () => {
            closeMenu();
            item.run();
        });
        // One highlighted row at a time, whether the pointer or the keys moved it.
        row.addEventListener('pointermove', () => row.focus({ preventScroll: true }));
        rows.push(row);
        menu.append(row);
    }
    document.body.append(menu);
    if (trigger) trigger.dataset.menu = 'open';
    place(menu, anchor);
    for (const row of rows) if (row.scrollWidth > row.clientWidth) row.title = row.textContent;

    const step = (from, by) => rows[(from + by + rows.length) % rows.length];
    const onKey = (event) => {
        const at = rows.indexOf(document.activeElement);
        const moves = {
            ArrowDown: () => step(at, 1),
            ArrowUp: () => step(at < 0 ? 0 : at, -1),
            Home: () => rows[0],
            End: () => rows.at(-1),
        };
        const next = moves[event.key];
        if (event.key === 'Escape' || event.key === 'Tab') {
            event.preventDefault();
            event.stopPropagation();
            closeMenu({ restoreFocus: true });
        } else if (next) {
            event.preventDefault();
            next().focus({ preventScroll: true });
        }
    };
    const onPointerDown = (event) => {
        if (menu.contains(event.target)) return;
        closeMenu();
        // The press that dismisses a menu must not also activate what is under it.
        if (event.button === 0) swallowClick = true;
    };
    const away = () => closeMenu();
    const listeners = [
        [document, 'keydown', onKey, true], [document, 'pointerdown', onPointerDown, true],
        [document, 'wheel', away, { capture: true, passive: true }], [window, 'resize', away], [window, 'blur', away],
    ];
    for (const [target, type, handler, options] of listeners) target.addEventListener(type, handler, options);
    current = {
        menu, trigger,
        stop: () => {
            for (const [target, type, handler, options] of listeners) target.removeEventListener(type, handler, options);
        },
    };
    rows[0]?.focus({ preventScroll: true });
}

// Whole-pixel position, kept clear of the screen edges.
function place(menu, { x, top, bottom }) {
    const width = Math.min(WIDTH, innerWidth - 2 * MARGIN);
    menu.style.width = `${width}px`;
    const height = menu.offsetHeight;
    const left = Math.max(MARGIN, Math.min(Math.round(x), innerWidth - MARGIN - width));
    let y = Math.round(top);
    if (y + height > innerHeight - MARGIN) y = Math.round(bottom) - height;
    y = Math.max(MARGIN, Math.min(y, innerHeight - MARGIN - height));
    menu.style.left = `${left}px`;
    menu.style.top = `${y}px`;
}

/**
 * Calls `open(element, anchor)` for whatever matches `selector` when it is right-clicked, has the keyboard's
 * menu key pressed, or is held down for half a second on a touch screen.
 */
export function bindMenuRequests(selector, open) {
    let lastPointer = 'mouse';
    let press = null;

    const below = (el, x) => {
        const rect = el.getBoundingClientRect();
        return { x, top: rect.bottom - 4, bottom: rect.top + 4 };
    };
    const cancelPress = () => {
        if (press) clearTimeout(press.timer);
        press = null;
    };

    document.addEventListener('pointerdown', (event) => {
        swallowClick = false;
        lastPointer = event.pointerType;
        cancelPress();
        const el = event.button === 0 && event.pointerType !== 'mouse' && event.target.closest?.(selector);
        if (!el) return;
        press = {
            x: event.clientX, y: event.clientY,
            timer: setTimeout(() => {
                press = null;
                swallowClick = true;
                if (current?.trigger !== el) open(el, below(el, event.clientX));
            }, LONG_PRESS_MS),
        };
    }, true);
    document.addEventListener('pointermove', (event) => {
        if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_SLOP) cancelPress();
    }, true);
    for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, cancelPress, true);

    // Android also sends its own contextmenu event after a long press; the page draws only one menu.
    document.addEventListener('contextmenu', (event) => {
        if (current?.menu.contains(event.target)) return event.preventDefault();
        const el = event.target.closest?.(selector);
        if (!el) return;
        event.preventDefault();
        const touch = lastPointer === 'touch' || lastPointer === 'pen';
        if (touch) swallowClick = true;
        if (current?.trigger === el) return;
        open(el, touch ? below(el, event.clientX) : { x: event.clientX, top: event.clientY, bottom: event.clientY });
    });

    document.addEventListener('keydown', (event) => {
        if (current || !(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return;
        const el = document.activeElement?.closest?.(selector);
        if (!el) return;
        event.preventDefault();
        const rect = el.getBoundingClientRect();
        open(el, { x: rect.left + 16, top: rect.bottom - 6, bottom: rect.top + 6 });
    });

    document.addEventListener('click', (event) => {
        if (!swallowClick) return;
        swallowClick = false;
        event.preventDefault();
        event.stopPropagation();
    }, true);
}
