const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('monitoring', {
  snapshot: () => ipcRenderer.invoke('monitoring:snapshot'),
  configure: value => ipcRenderer.invoke('monitoring:configure', value),
  disconnect: () => ipcRenderer.invoke('monitoring:disconnect'),
  refresh: () => ipcRenderer.invoke('monitoring:refresh'),
  select: value => ipcRenderer.invoke('monitoring:select', value),
  trend: id => ipcRenderer.invoke('monitoring:trend', id),
  onChange: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('monitoring:changed', listener);
    return () => ipcRenderer.removeListener('monitoring:changed', listener);
  }
});
