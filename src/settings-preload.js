const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  getAll: () => ipcRenderer.invoke('settings:get-all'),
  setCharacterLock: (character) => ipcRenderer.invoke('settings:set-character-lock', character),
  setRenderMode: (mode) => ipcRenderer.invoke('settings:set-render-mode', mode),
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
  },
  onHookStatuses: (callback) => {
    const handler = (_event, hooks) => callback(hooks);
    ipcRenderer.on('settings:hook-statuses', handler);
    return () => ipcRenderer.removeListener('settings:hook-statuses', handler);
  },
  onSelectTab: (callback) => {
    const handler = (_event, tab) => callback(tab);
    ipcRenderer.on('settings:select-tab', handler);
    return () => ipcRenderer.removeListener('settings:select-tab', handler);
  }
});
