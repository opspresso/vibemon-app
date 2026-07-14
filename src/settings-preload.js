const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  getAll: () => ipcRenderer.invoke('settings:get-all'),
  setAppMode: (mode) => ipcRenderer.invoke('settings:set-app-mode', mode),
  setWindowMode: (mode) => ipcRenderer.invoke('settings:set-window-mode', mode),
  setCharacterLock: (character) => ipcRenderer.invoke('settings:set-character-lock', character),
  setAlwaysOnTopMode: (mode) => ipcRenderer.invoke('settings:set-always-on-top-mode', mode),
  setSpeechBubbleField: (field, enabled) => ipcRenderer.invoke('settings:set-speech-bubble-field', field, enabled),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke('settings:set-open-at-login', enabled),
  setToken: (token) => ipcRenderer.invoke('settings:set-token', token),
  refreshHookStatuses: () => ipcRenderer.invoke('settings:refresh-hook-statuses'),
  installHook: (flag) => ipcRenderer.invoke('settings:install-hook', flag),
  repairVibemonConfig: () => ipcRenderer.invoke('settings:repair-vibemon-config'),
  setVibemonConfig: (partial) => ipcRenderer.invoke('settings:set-vibemon-config', partial),
  addHttpUrl: (url) => ipcRenderer.invoke('settings:add-http-url', url),
  removeHttpUrl: (url) => ipcRenderer.invoke('settings:remove-http-url', url),
  checkForUpdates: () => ipcRenderer.invoke('settings:check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('settings:download-update'),
  installDownloaded: () => ipcRenderer.invoke('settings:install-downloaded'),
  openExternal: (key) => ipcRenderer.invoke('settings:open-external', key),
  onUpdateState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('settings:update-state', handler);
    return () => ipcRenderer.removeListener('settings:update-state', handler);
  }
});
