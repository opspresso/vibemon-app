const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Character registry (single source: src/shared/data/characters.json),
  // fetched from the main process — the sandboxed preload can't require
  // arbitrary files itself.
  getCharacterRegistry: () => ipcRenderer.invoke('get-character-registry'),
  showContextMenu: () => ipcRenderer.send('show-context-menu'),
  focusTerminal: () => ipcRenderer.invoke('focus-terminal'),
  onStateUpdate: (callback) => {
    const handler = (_event, data) => {
      try {
        callback(data);
      } catch (error) {
        console.error('State update callback error:', error);
      }
    };
    ipcRenderer.on('state-update', handler);
    // Return cleanup function to prevent memory leaks
    return () => ipcRenderer.removeListener('state-update', handler);
  },
  getVersion: () => ipcRenderer.invoke('get-version'),
  getPlatform: () => process.platform
});
