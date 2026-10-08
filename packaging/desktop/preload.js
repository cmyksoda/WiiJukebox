// SPDX-License-Identifier: GPL-3.0-only
// Gives the app's own local pages (and only those) buttons that talk to the app.

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

if (location.protocol === 'file:') {
    contextBridge.exposeInMainWorld('desktop', {
        info: call('desktop:info'),
        beginSetup: call('desktop:begin-setup'),
        openPlayer: call('desktop:open-player'),
        recheck: call('desktop:recheck'),
        continueAnyway: call('desktop:continue'),
        restart: call('desktop:restart'),
        setPort: call('desktop:set-port'),
        allowFirewall: call('desktop:allow-firewall'),
        copy: call('desktop:copy'),
        onStep: (callback) => ipcRenderer.on('desktop:step', (event, text) => callback(text)),
    });
}
