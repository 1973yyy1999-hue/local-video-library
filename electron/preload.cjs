const { contextBridge, ipcRenderer } = require('electron');
const invoke = channel => (...args) => ipcRenderer.invoke(`library:${channel}`, ...args);
contextBridge.exposeInMainWorld('libraryAPI', {
  snapshot: invoke('snapshot'), addFolder: invoke('add-folder'), relocateFolder: invoke('relocate-folder'),
  removeFolder: invoke('remove-folder'), scan: invoke('scan'), cancelScan: invoke('cancel'),
  update: invoke('update'), reveal: invoke('reveal'), openExternal: invoke('open-external'),
  prepare: invoke('prepare'), cancelMedia: invoke('cancel-media'), playing: invoke('playing'),
  contextMenu: invoke('context-menu'), fullscreen: invoke('fullscreen'), flush: invoke('flush'),
  settings: invoke('settings'), saveSettings: invoke('save-settings'), clearCache: invoke('clear-cache'), moveCache: invoke('move-cache'), quitReady: invoke('quit-ready'),
  on: (name, callback) => {
    if (!['scan-progress', 'scan-batch', 'library-changed', 'video-changed', 'storage-error', 'media-retry', 'player-action', 'prepare-quit', 'fullscreen-changed'].includes(name)) return () => {};
    const listener = (_event, data) => callback(data); ipcRenderer.on(name, listener);
    return () => ipcRenderer.removeListener(name, listener);
  }
});
