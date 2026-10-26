const { BrowserWindow, ipcMain, shell, autoUpdater, nativeTheme, clipboard } = require('electron');
const path = require('node:path');
const { URL } = require('node:url');
const { centerOnCursorDisplay } = require('../modules/window-position.cjs');
const { webOrigin, validId } = require('../monitoring/domain.cjs');
const { UsageClient } = require('../monitoring/usage.cjs');
const { accountProfile } = require('../monitoring/account-profile.cjs');
const { WORKSPACE_UPDATE_MS } = require('../shared/constants.cjs');
const { attentionAreas, attentionNotices } = require('../shared/attention.cjs');
const { t, rendererLanguage } = require('../shared/i18n/locale.cjs');
const { redactApiTokens } = require('../shared/api-token.cjs');
const { colorPair, readTokens } = require('../shared/design/tokens.cjs');

const ROUTES = ['overview', 'agents', 'resources', 'connections', 'services', 'companion', 'integrations', 'about'];
const CHANNEL = 'workspace:request';
// The preload reads the App language synchronously, before the page renders text.
const LANGUAGE_CHANNEL = 'workspace:language';
// The native window paints this color before the page loads, so it follows the OS theme like the page.
const BACKGROUND = colorPair(readTokens(), 'background');
const backgroundColor = () => nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light;
const WEB_PATHS = { account: '/account', resources: '/resources/new', agents: '/coding-accounts/new', docs: '/docs' };

class WorkspaceWindow {
  constructor({ monitoring, settings, signIn, getActivity, getUsage, showCompanion, reportError, openExternal = url => shell.openExternal(url), writeClipboard = value => clipboard.writeText(value), services = new UsageClient({ monitoring }) }) {
    Object.assign(this, { monitoring, settings, signIn, getActivity, getUsage, showCompanion, reportError, openExternal, writeClipboard, services });
    this.window = null;
    this.route = 'overview';
    this.timer = null;
    // Orders frames: replies to requests and published changes travel on
    // separate IPC paths, so the page can receive an older frame last.
    this.sequence = 0;
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
    this.onThemeUpdated = () => { if (this.window && !this.window.isDestroyed()) this.window.setBackgroundColor(backgroundColor()); };
    nativeTheme.on('updated', this.onThemeUpdated);
    this.onLanguage = event => { event.returnValue = this.trusted(event) ? rendererLanguage() : null; };
    ipcMain.on(LANGUAGE_CHANNEL, this.onLanguage);
    ipcMain.handle(CHANNEL, async (event, command, args = []) => {
      if (!this.trusted(event)) throw new Error('Untrusted workspace request');
      if (!Array.isArray(args) || args.length > 3) throw new Error('Invalid workspace arguments');
      try { return { ok: true, value: await this.request(command, args) }; }
      catch (error) { return { ok: false, error: redactApiTokens(error.code || error.message || t('error.requestFailed')) }; }
    });
  }

  /** Only this window's main frame may call the workspace channels. */
  trusted(event) {
    return Boolean(this.window) && !this.window.isDestroyed() && event.sender === this.window.webContents && event.senderFrame === this.window.webContents.mainFrame;
  }

  /** The current frame. It supersedes a pending publish, which would resend the same frame. */
  snapshot() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const section of this.dirty) {
      if (section === 'settings') this.cache.settings = this.settings.getSnapshot();
      if (section === 'activity') this.cache.activity = this.getActivity();
      if (section === 'usage') this.cache.usage = this.getUsage();
    }
    this.dirty.clear();
    const areas = attentionAreas(this.cache.cloud, this.cache.settings);
    return { ...this.cache, attention: { ...areas, notices: attentionNotices(areas) }, route: this.route, sequence: ++this.sequence };
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
      case 'account-profile': return accountProfile(this.monitoring);
      case 'navigate': this.navigate(args[0]); return this.snapshot();
      case 'configure': this.signIn?.cancel(); return this.monitoring.configure(args[0]);
      // Sign in through Web; the browser returns to the local HTTP server.
      // `usage` lets the dashboard token connect and disconnect services.
      case 'sign-in': {
        const url = String(args[0] ?? '');
        return this.signIn.signIn(url, 'read usage', (token, signal) => this.monitoring.configure({ url, token }, { signal }));
      }
      case 'sign-in-cloud-delivery': {
        const url = String(args[0] ?? '');
        const result = await this.signIn.signIn(url, 'write', (token, signal) => this.settings.invoke('configure-cloud-delivery', { url, token }, { signal }));
        this.notify('settings');
        return result;
      }
      case 'cancel-sign-in': this.signIn.cancel(); return true;
      case 'disconnect': this.signIn?.cancel(); return this.monitoring.disconnect();
      case 'refresh': return this.monitoring.poll(true);
      case 'select': return this.monitoring.select(args[0]);
      case 'trend': return this.monitoring.trend(args[0]);
      case 'settings': {
        const [action, values = []] = args;
        if (!Array.isArray(values) || values.length > 2) throw new Error('Invalid settings arguments');
        if (['configure-cloud-delivery', 'disconnect-cloud-delivery'].includes(action)) this.signIn?.cancel();
        const result = await this.settings.invoke(action, ...values);
        this.notify('settings');
        return { result, frame: this.snapshot() };
      }
      // Connected services. The renderer names a started sign-in only by its ID.
      case 'usage': return this.services.list();
      case 'usage-start': return this.services.start(args[0]);
      case 'usage-complete': {
        const result = await this.services.complete(args[0], args[1]);
        if (result.status === 'connected') this.reloadSources();
        return result;
      }
      case 'usage-cancel': return this.services.cancel(args[0]);
      case 'usage-open': await this.openExternal(this.services.authorization(args[0]).prompt.url); return true;
      case 'usage-copy': {
        const { prompt } = this.services.authorization(args[0]);
        if (prompt.kind !== 'device') throw new Error('Nothing to copy');
        this.writeClipboard(prompt.userCode);
        return true;
      }
      case 'usage-refresh': {
        const connection = await this.services.refresh(args[0]);
        this.reloadSources();
        return connection;
      }
      case 'usage-disconnect': {
        await this.services.disconnect(args[0]);
        this.reloadSources();
        return true;
      }
      case 'show-companion': this.showCompanion(); return true;
      case 'open-write-token-account': {
        if (typeof args[0] !== 'string') throw new Error(t('error.webAddress'));
        const origin = webOrigin(args[0], this.monitoring.allowLocalHttp);
        await this.openExternal(new URL('/account?purpose=write', origin).href);
        return true;
      }
      case 'remove-monitor': {
        await this.openExternal(await this.monitoring.removalUrl(args[0]));
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

  /** Account cards follow a service change at once instead of at the next poll. */
  reloadSources() {
    this.monitoring.poll(true);
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
      title: 'VibeMon', backgroundColor: backgroundColor(),
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
      if (this.disposed) return;
      event.preventDefault();
      // Only closing the window ends what the page has in progress, such as a
      // service sign-in. Minimizing or hiding the App (Cmd+H) keeps it: the
      // person may be approving that sign-in in the browser.
      window.webContents.send('workspace:closed');
      window.hide();
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
    this.signIn?.cancel();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.monitoring.off('change', this.onCloudChange);
    autoUpdater.off('before-quit-for-update', this.onBeforeUpdate);
    nativeTheme.off('updated', this.onThemeUpdated);
    ipcMain.removeHandler(CHANNEL);
    ipcMain.off(LANGUAGE_CHANNEL, this.onLanguage);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
module.exports = { WorkspaceWindow };
