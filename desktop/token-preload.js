const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tokenAPI', {
  requestCurrentToken: () => ipcRenderer.send('get-current-token'),
  onCurrentToken: (callback) => {
    ipcRenderer.on('current-token', (_event, token) => callback(token));
  },
  setToken: (token) => ipcRenderer.send('set-token', token),
  cancel: () => ipcRenderer.send('cancel-token')
});
