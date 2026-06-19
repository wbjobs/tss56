const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stickyNoteAPI', {
  sendContentChange: (content) =>
    ipcRenderer.invoke('content:change', { content }),

  getAppInfo: () =>
    ipcRenderer.invoke('app:get-info'),

  toggleAlwaysOnTop: () =>
    ipcRenderer.invoke('window:toggle-always-on-top'),

  isAlwaysOnTop: () =>
    ipcRenderer.invoke('window:is-always-on-top'),

  refreshPeers: () =>
    ipcRenderer.invoke('peers:request-refresh'),

  requestSync: () =>
    ipcRenderer.invoke('content:request-sync'),

  onContentUpdate: (callback) => {
    ipcRenderer.on('content:update', (event, data) => callback(data));
  },

  onPeersUpdate: (callback) => {
    ipcRenderer.on('peers:update', (event, peers) => callback(peers));
  },

  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('content:update');
    ipcRenderer.removeAllListeners('peers:update');
  }
});
