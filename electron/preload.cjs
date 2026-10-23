const { contextBridge, ipcRenderer } = require('electron');
const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args);
contextBridge.exposeInMainWorld('libraryAPI', {
  snapshot: invoke('library:snapshot'), addFolder: invoke('library:add-folder'),
  removeFolder: invoke('library:remove-folder'), scan: invoke('library:scan'), cancelScan: invoke('library:cancel'),
  update: invoke('library:update'), reveal: invoke('library:reveal'), openExternal: invoke('library:open-external'),
  prepare: invoke('library:prepare'),
  on: (name, callback) => {
    if (!['scan-progress', 'library-changed'].includes(name)) return () => {};
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(name, listener);
    return () => ipcRenderer.removeListener(name, listener);
  }
});
