// SPDX-License-Identifier: GPL-3.0-only
// Gives the local setup page (and only that page) buttons that talk to the app.

const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
    contextBridge.exposeInMainWorld('desktop', {
        recheck: () => ipcRenderer.invoke('desktop:recheck'),
        continueAnyway: () => ipcRenderer.invoke('desktop:continue'),
        restart: () => ipcRenderer.invoke('desktop:restart'),
        installYtdlp: () => ipcRenderer.invoke('desktop:install-ytdlp'),
    });
}
