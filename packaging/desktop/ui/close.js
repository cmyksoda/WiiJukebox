// SPDX-License-Identifier: GPL-3.0-only
// The "Keep WiiJukebox running?" card. Escape cancels and Enter keeps playing; every answer goes to main
// as a choice plus whether to remember it.

const api = window.closeDialog;
const params = new URLSearchParams(location.search);
const remember = document.querySelector('#remember');
const buttons = [...document.querySelectorAll('button')];

if (params.get('theme') === 'light' || params.get('theme') === 'dark') document.documentElement.dataset.theme = params.get('theme');
if (params.get('tray')) document.querySelector('#tray').textContent = params.get('tray');

const answer = (choice) => api.answer(choice, remember.checked);
document.querySelector('#cancel').onclick = () => answer('cancel');
document.querySelector('#quit').onclick = () => answer('quit');
document.querySelector('#background').onclick = () => answer('background');

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        answer('cancel');
    } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
        // A focused button answers for itself; anywhere else Enter is the safe default.
        answer('background');
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const at = buttons.indexOf(document.activeElement);
        if (at < 0) return;
        buttons[(at + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length].focus();
    } else {
        return;
    }
    event.preventDefault();
});

document.querySelector('#background').focus();
// Main sizes the window to the card. The first measure starts the font loading, and the font decides where the text wraps.
const cardHeight = () => Math.ceil(document.querySelector('main').getBoundingClientRect().height);
cardHeight();
document.fonts.ready.then(() => api.ready(cardHeight()));
