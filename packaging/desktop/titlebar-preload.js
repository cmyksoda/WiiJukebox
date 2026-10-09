// SPDX-License-Identifier: GPL-3.0-only
// Gives the custom title bar (a local page, never the server's) its window buttons.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('titlebar', {
    platform: process.platform,
    ready: () => ipcRenderer.invoke('titlebar:ready'),
    minimize: () => ipcRenderer.send('titlebar:minimize'),
    toggleMaximize: () => ipcRenderer.send('titlebar:toggle-maximize'),
    close: () => ipcRenderer.send('titlebar:close'),
    openMenu: () => ipcRenderer.send('titlebar:menu-open'),
    activateMenu: (id) => ipcRenderer.send('titlebar:menu-activate', id),
    closeMenu: () => ipcRenderer.send('titlebar:menu-close'),
    onMenu: (callback) => ipcRenderer.on('titlebar:menu', (event, model) => callback(model)),
    onMenuClosed: (callback) => ipcRenderer.on('titlebar:menu-closed', () => callback()),
    onState: (callback) => ipcRenderer.on('titlebar:state', (event, state) => callback(state)),
});
