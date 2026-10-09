// SPDX-License-Identifier: GPL-3.0-only
// Turns an Electron menu template into the plain list the title bar draws, and keeps what each entry does
// here in main: the bar only ever sends back an entry's id, never a label or a command.

const ACCELERATOR_NAMES = { commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl', control: 'Ctrl', ctrl: 'Ctrl', command: 'Ctrl', cmd: 'Ctrl', plus: '+', alt: 'Alt', shift: 'Shift' };

/** "CommandOrControl+Shift+R" as it reads on a menu: "Ctrl+Shift+R". */
function formatAccelerator(accelerator) {
    if (typeof accelerator !== 'string' || !accelerator) return '';
    return accelerator.split(/\+(?=.)/).map((part) => ACCELERATOR_NAMES[part.toLowerCase()] || (part.length === 1 ? part.toUpperCase() : part)).join('+');
}

/**
 * `resolveRole(role)` gives a role's `{ label, accelerator }` and `roleActions[role]` what it does, since a role has
 * neither in the template itself. Entries that cannot be used still show, grayed out, but have no action.
 * Returns `{ items, actions }`: `items` is plain data for the bar, `actions` maps an entry's id to its function.
 */
function buildMenuModel(template, { resolveRole = () => ({}), roleActions = {} } = {}) {
    const actions = new Map();

    const convert = (entries, prefix) => {
        const out = [];
        entries.forEach((entry, index) => {
            if (entry.visible === false) return;
            if (entry.type === 'separator') {
                // Never two in a row, and none at either end.
                if (out.length && out.at(-1).type !== 'separator') out.push({ type: 'separator' });
                return;
            }
            const id = `${prefix}${index}`;
            const role = entry.role ? resolveRole(entry.role) : {};
            const type = entry.type === 'checkbox' || entry.type === 'radio' ? entry.type : 'normal';
            const item = {
                id,
                type,
                label: String(entry.label ?? role.label ?? entry.role ?? ''),
                enabled: entry.enabled !== false,
                checked: type !== 'normal' && Boolean(entry.checked),
                hint: formatAccelerator(entry.accelerator ?? role.accelerator),
            };
            if (entry.submenu) {
                item.submenu = convert(entry.submenu, `${id}.`);
                item.hint = '';
            } else if (item.enabled) {
                const run = entry.role ? roleActions[entry.role] : entry.click;
                if (run) {
                    // A checkbox is told what it is about to become, as the native menu does; a radio is always picked.
                    actions.set(id, () => run({ checked: type === 'checkbox' ? !item.checked : true }));
                } else {
                    item.enabled = false;
                }
            }
            out.push(item);
        });
        while (out.at(-1)?.type === 'separator') out.pop();
        return out;
    };

    return { items: convert(template, ''), actions };
}

module.exports = { buildMenuModel, formatAccelerator };
