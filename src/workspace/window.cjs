const { BrowserWindow, ipcMain, shell, autoUpdater } = require('electron');
const path = require('node:path');
const { URL } = require('node:url');
const { centerOnCursorDisplay } = require('../modules/window-position.cjs');
const { webOrigin, validId } = require('../monitoring/domain.cjs');
const { WORKSPACE_UPDATE_MS } = require('../shared/constants.cjs');

const ROUTES = ['overview', 'resources', 'agents', 'connections', 'companion', 'integrations', 'about'];
const CHANNEL = 'workspace:request';
const WEB_PATHS = { account: '/account', resources: '/resources/new', agents: '/coding-accounts/new', docs: '/docs', dashboard: '/dashboard' };

class WorkspaceWindow {
  constructor({ monitoring, settings, getActivity, getUsage, showCompanion, reportError, openExternal = url => shell.openExternal(url) }) {
    Object.assign(this, { monitoring, settings, getActivity, getUsage, showCompanion, reportError, openExternal });
    this.window = null;
    this.route = 'overview';
    this.timer = null;
    this.disposed = false;
    this.cache = { cloud: monitoring.snapshot() };
    this.dirty = new Set(['settings', 'activity', 'usage']);
    this.onCloudChange = snapshot => {
      this.cache.cloud = snapshot;
      this.notify('usage');
    };
    monitoring.on('change', this.onCloudChange);
    // macOS quitAndInstall closes windows before app's before-quit event.
    // Release hide-on-close before that sequence can cancel the update.
    this.onBeforeUpdate = () => this.cleanup();
    autoUpdater.on('before-quit-for-update', this.onBeforeUpdate);
    ipcMain.handle(CHANNEL, async (event, command, args = []) => {
      if (!this.window || this.window.isDestroyed() || event.sender !== this.window.webContents || event.senderFrame !== this.window.webContents.mainFrame) throw new Error('Untrusted workspace request');
      if (!Array.isArray(args) || args.length > 3) throw new Error('Invalid workspace arguments');
      try { return { ok: true, value: await this.request(command, args) }; }
      catch (error) { return { ok: false, error: String(error.code || error.message || 'Request failed').replace(/vm_[a-f0-9]{60}/g, '[redacted]') }; }
    });
  }

  snapshot() {
    for (const section of this.dirty) {
      if (section === 'settings') this.cache.settings = this.settings.getSnapshot();
      if (section === 'activity') this.cache.activity = this.getActivity();
      if (section === 'usage') this.cache.usage = this.getUsage();
    }
    this.dirty.clear();
    return { ...this.cache, route: this.route, platform: process.platform };
  }

  notify(section) {
    if (section) this.dirty.add(section);
    if (!this.window || this.window.isDestroyed() || !this.window.isVisible() || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.publish();
    }, WORKSPACE_UPDATE_MS);
  }

  publish() {
    if (this.window && !this.window.isDestroyed() && this.window.isVisible()) {
      this.window.webContents.send('workspace:changed', this.snapshot());
    }
  }

  navigate(route) {
    if (!ROUTES.includes(route)) throw new Error('Unknown workspace page');
    this.route = route;
    this.notify();
  }

  async request(command, args) {
    switch (command) {
      case 'snapshot': return this.snapshot();
      case 'navigate': this.navigate(args[0]); return this.snapshot();
      case 'configure': return this.monitoring.configure(args[0]);
      case 'disconnect': return this.monitoring.disconnect();
      case 'refresh': return this.monitoring.poll(true);
      case 'select': return this.monitoring.select(args[0]);
      case 'trend': return this.monitoring.trend(args[0]);
      case 'settings': {
        const [action, values = []] = args;
        if (!Array.isArray(values) || values.length > 2) throw new Error('Invalid settings arguments');
        const result = await this.settings.invoke(action, ...values);
        this.notify('settings');
        return { result, frame: this.snapshot() };
      }
      case 'show-companion': this.showCompanion(); return true;
      case 'open-write-token-account': {
        if (typeof args[0] !== 'string') throw new Error('Enter a valid Web address');
        const origin = webOrigin(args[0], this.monitoring.allowLocalHttp);
        await this.openExternal(new URL('/account?purpose=write', origin).href);
        return true;
      }
      case 'open-web': {
        const [destination, sourceId] = args;
        let pathname = Object.hasOwn(WEB_PATHS, destination) ? WEB_PATHS[destination] : null;
        if (destination === 'edit-resource' && validId(sourceId)) pathname = `/resources/${encodeURIComponent(sourceId)}/edit`;
        if (!pathname) throw new Error('Unknown Web destination');
        const origin = webOrigin(this.monitoring.snapshot().url, this.monitoring.allowLocalHttp);
        await this.openExternal(new URL(pathname, origin).href);
        return true;
      }
      default: throw new Error('Unknown workspace command');
    }
  }

  open(route = 'overview') {
    if (this.disposed) return;
    this.navigate(route);
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore();
      if (!this.window.isVisible() || !this.window.isFocused()) this.window.show();
      this.publish();
      return;
    }
    const window = new BrowserWindow({
      width: 1220, height: 830, minWidth: 820, minHeight: 600, show: false,
      title: 'VibeMon', backgroundColor: '#f6f8fb',
      autoHideMenuBar: process.platform !== 'darwin',
      ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 16 } } : {}),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    this.window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.once('ready-to-show', () => {
      if (window.isDestroyed() || this.disposed) return;
      centerOnCursorDisplay(window); window.show(); this.publish();
    });
    window.on('close', event => {
      if (!this.disposed) { event.preventDefault(); window.hide(); }
    });
    window.on('hide', () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      window.webContents.send('workspace:visibility', false);
    });
    window.on('show', () => {
      this.dirty.add('usage'); this.dirty.add('activity');
      window.webContents.send('workspace:visibility', true);
      this.publish();
    });
    window.on('closed', () => { if (this.window === window) this.window = null; });
    window.loadFile(path.join(__dirname, 'index.html')).catch(error => {
      if (this.disposed) return;
      if (!window.isDestroyed()) window.destroy();
      this.reportError(error);
    });
  }

  cleanup() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.monitoring.off('change', this.onCloudChange);
    autoUpdater.off('before-quit-for-update', this.onBeforeUpdate);
    ipcMain.removeHandler(CHANNEL);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
module.exports = { WorkspaceWindow, ROUTES };
