/**
 * Settings window for Vibe Monitor
 *
 * Hosts settings.html (VibeMon / AI Tools / About sections) and bridges its
 * renderer to the existing managers over IPC. Every mutation goes through the
 * same manager methods the tray menu uses, and onSettingsChanged lets main.js
 * refresh the tray after a change made from this window.
 */

const { BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { centerOnCursorDisplay } = require('./window-position.cjs');
const {
  ALWAYS_ON_TOP_MODES, CHARACTER_NAMES, CHARACTER_CONFIG, SPEECH_BUBBLE_FIELDS,
  CHARACTER_SCALES, EDGE_MARGINS
} = require('../shared/config.cjs');
const { describeFailure } = require('./hook-installer.cjs');

// Fixed navigation targets — the renderer picks by key, so no URL ever
// crosses the IPC boundary.
const EXTERNAL_LINKS = {
  docs: 'https://vibemon.io/docs',
  releases: 'https://github.com/opspresso/vibemon-app/releases'
};

class SettingsWindowManager {
  constructor({ windowManager, app, hookInstaller, vibemonConfigManager, updateChecker }) {
    this.windowManager = windowManager;
    this.app = app;
    this.hookInstaller = hookInstaller;
    this.vibemonConfigManager = vibemonConfigManager;
    this.updateChecker = updateChecker;
    this.monitoringClient = null;
    // Set by main.js to refresh the tray icon/menu after a settings change.
    this.onSettingsChanged = null;
    this.window = null;

    this.setupIpc();
  }

  /**
   * Set HTTPS monitoring client reference (created after app ready, like the tray's)
   * @param {MonitoringClient} monitoringClient
   */
  setMonitoringClient(monitoringClient, openMonitoring) {
    this.openMonitoring = openMonitoring;
    this.monitoringClient = monitoringClient;
  }

  notifyCloudStateChanged() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('settings:cloud-state', {
        status: this.monitoringClient?.getStatus() || 'not-configured',
        tokenConfigured: Boolean(this.monitoringClient?.hasToken())
      });
    }
  }

  notifyChanged() {
    if (this.onSettingsChanged) {
      this.onSettingsChanged();
    }
  }

  /**
   * Strip filesystem paths etc. from hook statuses before they cross IPC.
   * @param {Array} statuses - hookInstaller status entries
   * @returns {Array<{name: string, flag: string, present: boolean, hasHook: boolean, changed: boolean}>}
   */
  toHookView(statuses) {
    return statuses.map(({ name, flag, present, hasHook, changed, broken, brokenPath, dismissed }) => ({
      name,
      flag,
      present,
      hasHook,
      changed: Boolean(changed),
      broken: Boolean(broken),
      brokenPath: brokenPath || null,
      dismissed: Boolean(dismissed)
    }));
  }

  /**
   * ~/.vibemon/config.json fields plus its exists/hasDesktopUrl status, as
   * settings.html's "VibeMon Config" section renders it.
   * @returns {object}
   */
  getVibemonConfigView() {
    const config = this.vibemonConfigManager.read();
    const display = Object.fromEntries(['debug', 'auto_launch', 'http_urls', 'serial_port', 'vibemon_url'].map(key => [key, config[key]]));
    return { ...display, status: this.vibemonConfigManager.getStatus() };
  }

  /**
   * Snapshot of everything settings.html renders.
   */
  getSnapshot() {
    return {
      version: this.app.getVersion(),
      isPackaged: this.app.isPackaged,
      characterLock: this.windowManager.getCharacterLock(),
      renderMode: this.windowManager.getRenderMode(),
      alwaysOnTopMode: this.windowManager.getAlwaysOnTopMode(),
      speechBubbleFields: this.windowManager.getSpeechBubbleFields(),
      characterScale: this.windowManager.getCharacterScale(),
      dockAutoScale: this.windowManager.getDockAutoScale(),
      supportsDockCorners: process.platform === 'darwin',
      edgeMargin: this.windowManager.getEdgeMargin(),
      devMode: this.windowManager.getDevMode(),
      openAtLogin: this.app.getLoginItemSettings().openAtLogin,
      cloud: {
        status: this.monitoringClient ? this.monitoringClient.getStatus() : 'not-configured',
        tokenConfigured: Boolean(this.monitoringClient && this.monitoringClient.hasToken())
      },
      hooks: this.toHookView(this.hookInstaller.getCachedStatuses()),
      vibemonConfig: this.getVibemonConfigView(),
      update: this.updateChecker.getState(),
      options: {
        alwaysOnTopModes: ALWAYS_ON_TOP_MODES,
        characters: CHARACTER_NAMES.map(name => ({ name, displayName: CHARACTER_CONFIG[name].displayName })),
        speechBubbleFields: SPEECH_BUBBLE_FIELDS,
        characterScales: CHARACTER_SCALES,
        edgeMargins: EDGE_MARGINS
      }
    };
  }

  setupIpc() {
    const handle = (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
      if (!this.window || this.window.isDestroyed() || event?.sender !== this.window.webContents || event.senderFrame !== this.window.webContents.mainFrame) throw new Error('Untrusted settings request');
      return handler(event, ...args);
    });
    handle('settings:get-all', () => this.getSnapshot());

    handle('settings:set-character-lock', (_event, character) => {
      if (character !== 'auto' && !CHARACTER_NAMES.includes(character)) return false;
      this.windowManager.setCharacterLock(character);
      this.notifyChanged();
      return true;
    });

    handle('settings:set-render-mode', (_event, mode) => {
      if (mode !== '2d' && mode !== '3d') return false;
      this.windowManager.setRenderMode(mode);
      this.notifyChanged();
      return true;
    });

    handle('settings:set-always-on-top-mode', (_event, mode) => {
      if (!Object.prototype.hasOwnProperty.call(ALWAYS_ON_TOP_MODES, mode)) return false;
      this.windowManager.setAlwaysOnTopMode(mode);
      this.notifyChanged();
      return true;
    });

    handle('settings:set-speech-bubble-field', (_event, field, enabled) => {
      if (!SPEECH_BUBBLE_FIELDS.includes(field)) return false;
      this.windowManager.setSpeechBubbleField(field, Boolean(enabled));
      this.notifyChanged();
      return true;
    });

    handle('settings:set-character-scale', (_event, scale) => {
      if (!CHARACTER_SCALES.includes(scale)) return false;
      this.windowManager.setCharacterScale(scale);
      this.notifyChanged();
      return true;
    });

    handle('settings:set-edge-margin', (_event, margin) => {
      if (!EDGE_MARGINS.includes(margin)) return false;
      this.windowManager.setEdgeMargin(margin);
      this.notifyChanged();
      return true;
    });

    handle('settings:set-dock-auto-scale', (_event, enabled) => {
      if (typeof enabled !== 'boolean') return false;
      this.windowManager.setDockAutoScale(enabled);
      this.notifyChanged();
      return true;
    });

    handle('settings:set-dev-mode', (_event, enabled) => {
      this.windowManager.setDevMode(Boolean(enabled));
      this.notifyChanged();
      return true;
    });

    handle('settings:set-open-at-login', (_event, enabled) => {
      this.app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
      this.notifyChanged();
      return true;
    });

    handle('settings:open-monitoring', () => { this.openMonitoring?.(); return true; });

    handle('settings:reset-hook-prompts', () => {
      this.hookInstaller.clearDismissed();
      this.notifyChanged();
      return this.toHookView(this.hookInstaller.getCachedStatuses());
    });

    handle('settings:refresh-hook-statuses', async () => {
      // Re-fetches the manifest too, so Refresh re-verifies file hashes and
      // not just existence.
      await this.hookInstaller.checkForChanges();
      this.notifyChanged();
      return this.toHookView(this.hookInstaller.getCachedStatuses());
    });

    handle('settings:install-hook', async (_event, flag) => {
      // No result dialog — the Settings window already shows the outcome
      // inline via the row's badge/button state.
      const results = await this.hookInstaller.installByFlag(flag, null, { showSummary: false });
      this.notifyChanged();
      const failure = results.find(r => !r.result.ok);
      if (failure || results.length === 0) {
        // The reason travels with the rejection: this path shows no dialog, so
        // without it the renderer can only say "Failed".
        throw new Error(failure ? describeFailure(failure.result) : 'Hook install failed');
      }
      return this.toHookView(this.hookInstaller.getCachedStatuses());
    });

    handle('settings:repair-vibemon-config', () => {
      this.vibemonConfigManager.ensureDesktopUrl(null);
      const result = this.getVibemonConfigView();
      if (!result.status.hasDesktopUrl) throw new Error('Unable to repair hook config. Check its JSON format and file permissions.');
      this.notifyChanged();
      return result;
    });

    handle('settings:set-vibemon-config', (_event, partial) => {
      if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw new Error('Config changes must be a JSON object');
      if (Object.hasOwn(partial, 'vibemon_token')) throw new Error('Configure hook write tokens with the installer or hook config');
      this.vibemonConfigManager.write(partial);
      this.notifyChanged();
      return this.getVibemonConfigView();
    });

    handle('settings:add-http-url', (_event, url) => {
      if (typeof url !== 'string') return this.getVibemonConfigView();
      this.vibemonConfigManager.addHttpUrl(url);
      this.notifyChanged();
      return this.getVibemonConfigView();
    });

    handle('settings:remove-http-url', (_event, url) => {
      if (typeof url !== 'string') return this.getVibemonConfigView();
      this.vibemonConfigManager.removeHttpUrl(url);
      this.notifyChanged();
      return this.getVibemonConfigView();
    });

    handle('settings:check-for-updates', async () => {
      await this.updateChecker.checkForUpdates({ notifyOnError: true });
      return this.updateChecker.getState();
    });

    handle('settings:download-update', (_event) => {
      const { status, version } = this.updateChecker.getState();
      if (status !== 'available') return this.updateChecker.getState();
      this.updateChecker.downloadAndInstall(version);
      return this.updateChecker.getState();
    });

    handle('settings:install-downloaded', () => {
      const { status } = this.updateChecker.getState();
      if (status !== 'downloaded') return false;
      this.updateChecker.installDownloaded();
      return true;
    });

    handle('settings:open-external', (_event, key) => {
      if (!Object.hasOwn(EXTERNAL_LINKS, key)) return false;
      const url = EXTERNAL_LINKS[key];
      shell.openExternal(url);
      return true;
    });
  }

  /**
   * Push the latest update-checker state to an open settings window, so the
   * About section reflects download progress without polling.
   */
  notifyUpdateStateChanged() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('settings:update-state', this.updateChecker.getState());
    }
  }

  /**
   * Push the latest hook statuses to an open settings window, so the AI
   * Tools tab (rows + tab badge) reflects the periodic change check without
   * polling.
   */
  notifyHookStatusChanged() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('settings:hook-statuses', this.toHookView(this.hookInstaller.getCachedStatuses()));
    }
  }

  /**
   * @param {string} [tab] - Sidebar tab to select once the window is shown
   *                         (e.g. 'about'); omitted keeps the current tab.
   */
  open(tab) {
    if (this.window && !this.window.isDestroyed()) {
      centerOnCursorDisplay(this.window);
      this.window.show();
      this.window.focus();
      if (tab) {
        this.window.webContents.send('settings:select-tab', tab);
      }
      return;
    }

    this.window = new BrowserWindow({
      width: 750,
      height: 620,
      minWidth: 560,
      minHeight: 480,
      show: false,
      skipTaskbar: process.platform === 'win32',
      title: 'VibeMon Settings',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, '..', 'settings-preload.js')
      }
    });

    if (typeof this.window.webContents.setWindowOpenHandler === 'function') {
      this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    }
    if (typeof this.window.webContents.on === 'function') {
      this.window.webContents.on('will-navigate', (event) => event.preventDefault());
    }

    this.window.loadFile(path.join(__dirname, '..', 'settings.html'));

    if (tab) {
      this.window.webContents.once('did-finish-load', () => {
        if (this.window && !this.window.isDestroyed()) {
          this.window.webContents.send('settings:select-tab', tab);
        }
      });
    }

    this.window.once('ready-to-show', () => {
      if (this.window && !this.window.isDestroyed()) {
        centerOnCursorDisplay(this.window);
        this.window.show();
      }
    });

    this.window.on('closed', () => {
      this.window = null;
    });
  }

  cleanup() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    this.window = null;
  }
}

module.exports = { SettingsWindowManager };
