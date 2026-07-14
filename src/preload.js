const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  closeWindow: () => ipcRenderer.send('close-window'),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
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
  onDisplayModeUpdate: (callback) => {
    const handler = (_event, data) => {
      try {
        callback(data);
      } catch (error) {
        console.error('Display mode update callback error:', error);
      }
    };
    ipcRenderer.on('display-mode-update', handler);
    // Return cleanup function to prevent memory leaks
    return () => ipcRenderer.removeListener('display-mode-update', handler);
  },
  getVersion: () => ipcRenderer.invoke('get-version'),
  getPlatform: () => process.platform,
  getDisplayMode: () => ipcRenderer.invoke('get-display-mode')
});
