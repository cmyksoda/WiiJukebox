// SPDX-License-Identifier: GPL-3.0-only
// The ≡ menu. Main sends the entries and stretches this view over the window; clicks and keys are answered
// here, and an entry that is chosen goes back to main by id alone.

(() => {
    const api = window.titlebar;
    const button = document.querySelector('#menu');
    const scrim = document.querySelector('#menu-scrim');
    const root = document.querySelector('#menu-root');
    const sub = document.querySelector('#menu-sub');
    let open = false;
    let owner = null;

    const span = (className, text) => {
        const node = document.createElement('span');
        node.className = className;
        if (text) node.textContent = text;
        return node;
    };

    function render(container, entries) {
        container.replaceChildren();
        for (const entry of entries) {
            if (entry.type === 'separator') {
                const line = document.createElement('div');
                line.className = 'separator';
                line.setAttribute('role', 'separator');
                container.append(line);
                continue;
            }
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'item';
            row.dataset.id = entry.id;
            row.setAttribute('role', { checkbox: 'menuitemcheckbox', radio: 'menuitemradio' }[entry.type] || 'menuitem');
            if (entry.type !== 'normal') row.setAttribute('aria-checked', String(entry.checked));
            if (!entry.enabled) row.setAttribute('aria-disabled', 'true');
            row.append(span('check'), span('label', entry.label));
            if (entry.submenu) {
                row.setAttribute('aria-haspopup', 'menu');
                row.setAttribute('aria-expanded', 'false');
                row.append(span('caret'));
                row.entries = entry.submenu;
            } else {
                row.append(span('hint', entry.hint));
            }
            container.append(row);
        }
    }

    const rows = (container) => [...container.querySelectorAll('.item:not([aria-disabled="true"])')];
    const levelOf = (node) => (sub.contains(node) ? sub : root);

    function closeSub() {
        sub.hidden = true;
        owner?.setAttribute('aria-expanded', 'false');
        owner = null;
    }

    // Beside its row, on whichever side of the menu has room, and on whole pixels.
    function openSub(row) {
        if (owner === row) return;
        closeSub();
        render(sub, row.entries);
        sub.hidden = false;
        row.setAttribute('aria-expanded', 'true');
        owner = row;
        const menu = root.getBoundingClientRect();
        const at = row.getBoundingClientRect();
        let left = menu.right - 4;
        if (left + sub.offsetWidth > innerWidth - 8) left = menu.left - sub.offsetWidth + 4;
        if (left < 8) left = Math.max(8, innerWidth - sub.offsetWidth - 8);
        const top = Math.min(Math.round(at.top) - 5, innerHeight - sub.offsetHeight - 8);
        sub.style.left = `${Math.round(left)}px`;
        sub.style.top = `${Math.max(top, 38)}px`;
    }

    function choose(row) {
        if (row.getAttribute('aria-disabled') === 'true') return;
        if (row.entries) {
            openSub(row);
            rows(sub)[0]?.focus();
        } else {
            api.activateMenu(row.dataset.id);
        }
    }

    function show({ items }, byKeyboard) {
        render(root, items);
        closeSub();
        open = true;
        scrim.hidden = false;
        document.body.classList.add('menu-open');
        button.setAttribute('aria-expanded', 'true');
        (byKeyboard ? rows(root)[0] : root)?.focus();
    }

    function hide() {
        open = false;
        closeSub();
        scrim.hidden = true;
        document.body.classList.remove('menu-open');
        button.setAttribute('aria-expanded', 'false');
    }

    let openedByKeyboard = false;
    button.addEventListener('click', (event) => {
        if (open) {
            api.closeMenu();
            return;
        }
        openedByKeyboard = event.detail === 0;
        api.openMenu();
    });
    api.onMenu((model) => show(model, openedByKeyboard));
    api.onMenuClosed(hide);

    // A press anywhere but on the menu (or the button, which toggles it) closes it, as does leaving the window.
    document.addEventListener('pointerdown', (event) => {
        if (open && !event.target.closest('.menu, #menu')) api.closeMenu();
    }, true);
    window.addEventListener('blur', () => {
        if (open) api.closeMenu();
    });

    // The row under the pointer is the one the keys continue from; a row with a submenu opens it.
    scrim.addEventListener('pointermove', (event) => {
        const row = event.target.closest('.item');
        if (!row || row.getAttribute('aria-disabled') === 'true') return;
        if (document.activeElement !== row) row.focus({ preventScroll: true });
        if (row.entries) openSub(row);
        else if (levelOf(row) === root) closeSub();
    });
    scrim.addEventListener('click', (event) => {
        const row = event.target.closest('.item');
        if (row) choose(row);
    });

    document.addEventListener('keydown', (event) => {
        if (!open) return;
        const current = document.activeElement?.closest('.item');
        const level = levelOf(document.activeElement);
        const list = rows(level);
        const at = list.indexOf(current);
        const move = (index) => list[(index + list.length) % list.length]?.focus();
        switch (event.key) {
            case 'ArrowDown': move(at + 1); break;
            case 'ArrowUp': move(at < 0 ? -1 : at - 1); break;
            case 'Home': move(0); break;
            case 'End': move(-1); break;
            case 'ArrowRight':
                if (current?.entries) choose(current);
                break;
            case 'ArrowLeft':
                if (level === sub) {
                    const parent = owner;
                    closeSub();
                    parent?.focus();
                }
                break;
            case 'Enter':
            case ' ':
                if (current) choose(current);
                break;
            case 'Escape':
                if (level === sub) {
                    const parent = owner;
                    closeSub();
                    parent?.focus();
                } else {
                    api.closeMenu();
                }
                break;
            case 'Tab':
                break;
            default:
                return;
        }
        event.preventDefault();
    });
})();
