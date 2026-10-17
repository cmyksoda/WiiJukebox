// SPDX-License-Identifier: GPL-3.0-only
// The ≡ menu. Main sends the entries and stretches this view over the window; clicks, keys and the pointer are
// answered here, and an entry that is chosen goes back to main by id alone.

(() => {
    const api = window.titlebar;
    const button = document.querySelector('#menu');
    const scrim = document.querySelector('#menu-scrim');
    const root = document.querySelector('#menu-root');
    const sub = document.querySelector('#menu-sub');
    // How long a pointer heading for the submenu may cross other rows before they take over.
    const AIM_GRACE = 150;
    let open = false;
    let owner = null;
    let switchTimer = null;
    let aimedAt = null;

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
    const usable = (row) => Boolean(row) && row.getAttribute('aria-disabled') !== 'true';

    // One entry is lit per level, and the keys continue from it. Where it came from decides whether the pointer may take it away.
    function light(row, by) {
        if (!row) return;
        for (const other of levelOf(row).querySelectorAll('.item.active')) {
            other.classList.remove('active');
            delete other.dataset.by;
        }
        row.classList.add('active');
        row.dataset.by = by;
        row.focus({ preventScroll: true });
    }

    // What the pointer lit goes when it leaves, except the parent of an open submenu; an entry the keys chose stays.
    function unlightPointerRows(container) {
        for (const row of container.querySelectorAll('.item.active[data-by="pointer"]')) {
            if (row === owner) continue;
            row.classList.remove('active');
            delete row.dataset.by;
        }
    }

    function cancelSwitch() {
        clearTimeout(switchTimer);
        switchTimer = null;
    }

    function closeSub() {
        sub.hidden = true;
        owner?.setAttribute('aria-expanded', 'false');
        owner = null;
        cancelSwitch();
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

    function choose(row, byKey) {
        if (row.getAttribute('aria-disabled') === 'true') return;
        if (row.entries) {
            openSub(row);
            if (byKey) light(rows(sub)[0], 'key');
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
        if (byKeyboard) light(rows(root)[0], 'key');
        else root.focus();
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

    // The last two places the pointer was, so a layout change under a resting pointer is not taken for it moving,
    // and so it is known which way it is heading.
    let prevPoint = { x: NaN, y: NaN };
    let point = { x: NaN, y: NaN };
    document.addEventListener('pointermove', (event) => {
        prevPoint = point;
        point = { x: event.clientX, y: event.clientY };
    }, true);

    // True while the pointer is inside the triangle from where it just was to the near edge of the open submenu:
    // crossing other entries on the way there must not count as going to them.
    function aimingAtSub() {
        if (sub.hidden || Number.isNaN(prevPoint.x)) return false;
        const box = sub.getBoundingClientRect();
        const rootBox = root.getBoundingClientRect();
        const edge = box.left >= rootBox.left + rootBox.width / 2 ? box.left : box.right;
        const corners = [[prevPoint.x, prevPoint.y], [edge, box.top], [edge, box.bottom]];
        const side = ([ax, ay], [bx, by]) => (point.x - bx) * (ay - by) - (ax - bx) * (point.y - by);
        const signs = [side(corners[0], corners[1]), side(corners[1], corners[2]), side(corners[2], corners[0])];
        return signs.every((value) => value >= 0) || signs.every((value) => value <= 0);
    }

    // The pointer is on `row` of the main list (or on nothing it can use): light it, and let go of the submenu behind
    // it at once unless that is the submenu's own parent.
    function pointerOnRoot(row) {
        cancelSwitch();
        if (row) light(row, 'pointer');
        else unlightPointerRows(root);
        if (row?.entries) openSub(row);
        else if (owner && row !== owner) closeSub();
    }

    scrim.addEventListener('pointermove', (event) => {
        const moved = point.x !== prevPoint.x || point.y !== prevPoint.y;
        const menu = event.target.closest('.menu');
        if (!menu || !moved || event.pointerType === 'touch') return;
        const row = event.target.closest('.item');
        const target = usable(row) ? row : null;
        if (menu === sub) {
            cancelSwitch();
            if (target) light(target, 'pointer');
            else unlightPointerRows(sub);
        } else if (target !== owner && aimingAtSub()) {
            // On the way to the submenu: leave it open briefly, without restarting the wait on every move.
            aimedAt = target;
            if (!switchTimer) switchTimer = setTimeout(() => { switchTimer = null; pointerOnRoot(aimedAt); }, AIM_GRACE);
        } else {
            pointerOnRoot(target);
        }
    });
    for (const menu of [root, sub]) menu.addEventListener('pointerleave', () => unlightPointerRows(menu));
    scrim.addEventListener('click', (event) => {
        const row = event.target.closest('.item');
        if (row) choose(row, false);
    });

    document.addEventListener('keydown', (event) => {
        if (!open) return;
        const current = document.activeElement?.closest('.item');
        const level = levelOf(document.activeElement);
        const list = rows(level);
        const at = list.indexOf(current);
        const move = (index) => {
            const next = list[(index + list.length) % list.length];
            if (next) light(next, 'key');
        };
        cancelSwitch();
        switch (event.key) {
            case 'ArrowDown': move(at + 1); break;
            case 'ArrowUp': move(at < 0 ? -1 : at - 1); break;
            case 'Home': move(0); break;
            case 'End': move(-1); break;
            case 'ArrowRight':
                if (current?.entries) choose(current, true);
                break;
            case 'ArrowLeft':
                if (level === sub) {
                    const parent = owner;
                    closeSub();
                    light(parent, 'key');
                }
                break;
            case 'Enter':
            case ' ':
                if (current) choose(current, true);
                break;
            case 'Escape':
                if (level === sub) {
                    const parent = owner;
                    closeSub();
                    light(parent, 'key');
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
