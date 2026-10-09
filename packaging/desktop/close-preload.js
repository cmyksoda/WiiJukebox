// SPDX-License-Identifier: GPL-3.0-only
// Gives the close card (a local page, never the server's) its two calls: it is ready, and this is the answer.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('closeDialog', {
    ready: (height) => ipcRenderer.send('close-dialog:ready', height),
    answer: (choice, remember) => ipcRenderer.send('close-dialog:answer', { choice, remember }),
});
