const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('workspace', {
  request: (command, ...args) => ipcRenderer.invoke('workspace:request', command, args),
  onChange: callback => subscribe('workspace:changed', callback),
  onVisibility: callback => subscribe('workspace:visibility', callback),
  platform: process.platform,
  // { locale, messages }: the App language and its catalog with English fallback.
  language: ipcRenderer.sendSync('workspace:language')
});
