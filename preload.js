const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stickyNoteAPI', {
  getAllNotes: () =>
    ipcRenderer.invoke('notes:get-all'),

  createNote: () =>
    ipcRenderer.invoke('note:create'),

  updateNoteTitle: (noteId, title) =>
    ipcRenderer.invoke('note:update-title', { noteId, title }),

  updateNoteContent: (noteId, content) =>
    ipcRenderer.invoke('note:update-content', { noteId, content }),

  updateNoteOrder: (noteId, order) =>
    ipcRenderer.invoke('note:update-order', { noteId, order }),

  deleteNote: (noteId) =>
    ipcRenderer.invoke('note:delete', { noteId }),

  getAppInfo: () =>
    ipcRenderer.invoke('app:get-info'),

  toggleAlwaysOnTop: () =>
    ipcRenderer.invoke('window:toggle-always-on-top'),

  isAlwaysOnTop: () =>
    ipcRenderer.invoke('window:is-always-on-top'),

  refreshPeers: () =>
    ipcRenderer.invoke('peers:request-refresh'),

  requestFullSync: () =>
    ipcRenderer.invoke('notes:request-sync'),

  onNotesUpdate: (callback) => {
    ipcRenderer.on('notes:update', (event, data) => callback(data));
  },

  onPeersUpdate: (callback) => {
    ipcRenderer.on('peers:update', (event, peers) => callback(peers));
  },

  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('notes:update');
    ipcRenderer.removeAllListeners('peers:update');
  }
});
