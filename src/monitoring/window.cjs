const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

class MonitoringWindow {
  constructor(client) {
    this.client = client;
    this.window = null;
    const handlers = {
      snapshot: () => client.snapshot(),
      configure: value => client.configure(value),
      disconnect: () => client.disconnect(),
      refresh: () => client.poll(true),
      select: value => client.select(value),
      trend: id => client.trend(id)
    };
    for (const [name, handler] of Object.entries(handlers)) {
      ipcMain.handle(`monitoring:${name}`, async (event, value) => {
        if (!this.window || event.sender !== this.window.webContents || event.senderFrame !== this.window.webContents.mainFrame) throw new Error('Untrusted monitoring request');
        try { return { ok: true, value: await handler(value) }; }
        catch (error) { return { ok: false, error: error.code || error.message }; }
      });
    }
    this.changed = snapshot => {
      if (this.window && !this.window.isDestroyed()) this.window.webContents.send('monitoring:changed', snapshot);
    };
    client.on('change', this.changed);
  }
  open() {
    if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); return; }
    this.window = new BrowserWindow({ width: 1050, height: 760, minWidth: 640, minHeight: 500, title: 'VibeMon Monitoring', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', event => event.preventDefault());
    this.window.loadFile(path.join(__dirname, 'index.html'));
    this.window.on('closed', () => { this.window = null; });
    this.client.poll(true);
  }
  cleanup() {
    this.client.off('change', this.changed);
    if (this.window && !this.window.isDestroyed()) this.window.close();
    for (const name of ['snapshot', 'configure', 'disconnect', 'refresh', 'select', 'trend']) ipcMain.removeHandler(`monitoring:${name}`);
  }
}
module.exports = { MonitoringWindow };
