// SPDX-License-Identifier: GPL-3.0-only
// Gives the custom title bar (a local page, never the server's) its window buttons.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('titlebar', {
    platform: process.platform,
    ready: () => ipcRenderer.invoke('titlebar:ready'),
    minimize: () => ipcRenderer.send('titlebar:minimize'),
    toggleMaximize: () => ipcRenderer.send('titlebar:toggle-maximize'),
    close: () => ipcRenderer.send('titlebar:close'),
    menu: (x, y) => ipcRenderer.send('titlebar:menu', { x, y }),
    onState: (callback) => ipcRenderer.on('titlebar:state', (event, state) => callback(state)),
});
