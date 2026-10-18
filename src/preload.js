const { contextBridge, ipcRenderer } = require('electron');

// Main-process snapshots can arrive before images finish loading. Keep one
// latest value per channel and replay it to late renderer subscribers.
function bufferedSubscription(channel, errorMessage) {
  let latest;
  const handlers = new Set();
  ipcRenderer.on(channel, (_event, value) => {
    latest = value;
    for (const handler of Array.from(handlers)) handler(value);
  });
  return (callback) => {
    const handler = (value) => {
      try {
        callback(value);
      } catch (error) {
        console.error(errorMessage, error);
      }
    };
    handlers.add(handler);
    if (latest !== undefined) handler(latest);
    return () => handlers.delete(handler);
  };
}

const onStateUpdate = bufferedSubscription('state-update', 'State update callback error:');
const onDisplayOptions = bufferedSubscription('display-options', 'Display options callback error:');

contextBridge.exposeInMainWorld('electronAPI', {
  // Character/state registries (single sources: src/shared/data/
  // characters.json and states.json), fetched from the main process — the
  // sandboxed preload can't require arbitrary files itself.
  getCharacterRegistry: () => ipcRenderer.invoke('get-character-registry'),
  getStateRegistry: () => ipcRenderer.invoke('get-state-registry'),
  getRenderMode: () => ipcRenderer.invoke('get-render-mode'),
  getDisplayOptions: () => ipcRenderer.invoke('get-display-options'),
  onDisplayOptions,
  showContextMenu: () => ipcRenderer.send('show-context-menu'),
  focusTerminal: () => ipcRenderer.invoke('focus-terminal'),
  onStateUpdate,
  beginWindowDrag: () => ipcRenderer.send('window-drag-start'),
  onWindowPointer: (callback) => {
    const handler = (_event, point) => callback(point);
    ipcRenderer.on('window-pointer', handler);
    return () => ipcRenderer.removeListener('window-pointer', handler);
  },
  setIgnoreMouseEvents: (ignore) => ipcRenderer.send('window-ignore-mouse', ignore),
  endWindowDrag: () => ipcRenderer.send('window-drag-end'),
  moveWindowDrag: () => ipcRenderer.send('window-drag-move')
});
