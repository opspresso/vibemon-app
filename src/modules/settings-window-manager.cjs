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
  ALWAYS_ON_TOP_MODES, CHARACTER_NAMES, CHARACTER_CONFIG, SPEECH_BUBBLE_FIELDS
} = require('../shared/config.cjs');

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
    this.wsClient = null;
    // Set by main.js to refresh the tray icon/menu after a settings change.
    this.onSettingsChanged = null;
    this.window = null;

    this.setupIpc();
  }

  /**
   * Set WebSocket client reference (created after app ready, like the tray's)
   * @param {WsClient} wsClient
   */
  setWsClient(wsClient) {
    this.wsClient = wsClient;
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
    return statuses.map(({ name, flag, present, hasHook, changed }) => ({ name, flag, present, hasHook, changed: Boolean(changed) }));
  }

  /**
   * ~/.vibemon/config.json fields plus its exists/hasDesktopUrl status, as
   * settings.html's "VibeMon Config" section renders it.
   * @returns {object}
   */
  getVibemonConfigView() {
    return { ...this.vibemonConfigManager.read(), status: this.vibemonConfigManager.getStatus() };
  }

  /**
   * Snapshot of everything settings.html renders.
   */
  getSnapshot() {
    return {
      version: this.app.getVersion(),
      isPackaged: this.app.isPackaged,
      characterLock: this.windowManager.getCharacterLock(),
      alwaysOnTopMode: this.windowManager.getAlwaysOnTopMode(),
      speechBubbleFields: this.windowManager.getSpeechBubbleFields(),
      openAtLogin: this.app.getLoginItemSettings().openAtLogin,
      ws: {
        status: this.wsClient ? this.wsClient.getStatus() : 'not-configured',
        tokenConfigured: Boolean(this.wsClient && this.wsClient.getToken())
      },
      hooks: this.toHookView(this.hookInstaller.getCachedStatuses()),
      vibemonConfig: this.getVibemonConfigView(),
      update: this.updateChecker.getState(),
      options: {
        alwaysOnTopModes: ALWAYS_ON_TOP_MODES,
        characters: CHARACTER_NAMES.map(name => ({ name, displayName: CHARACTER_CONFIG[name].displayName })),
        speechBubbleFields: SPEECH_BUBBLE_FIELDS
      }
    };
  }

  setupIpc() {
    ipcMain.handle('settings:get-all', () => this.getSnapshot());

    ipcMain.handle('settings:set-character-lock', (_event, character) => {
      if (character !== 'auto' && !CHARACTER_NAMES.includes(character)) return false;
      this.windowManager.setCharacterLock(character);
      this.notifyChanged();
      return true;
    });

    ipcMain.handle('settings:set-always-on-top-mode', (_event, mode) => {
      if (!Object.prototype.hasOwnProperty.call(ALWAYS_ON_TOP_MODES, mode)) return false;
      this.windowManager.setAlwaysOnTopMode(mode);
      this.notifyChanged();
      return true;
    });

    ipcMain.handle('settings:set-speech-bubble-field', (_event, field, enabled) => {
      if (!SPEECH_BUBBLE_FIELDS.includes(field)) return false;
      this.windowManager.setSpeechBubbleField(field, Boolean(enabled));
      this.notifyChanged();
      return true;
    });

    ipcMain.handle('settings:set-open-at-login', (_event, enabled) => {
      this.app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
      this.notifyChanged();
      return true;
    });

    ipcMain.handle('settings:set-token', (_event, token) => {
      if (typeof token !== 'string' || !this.wsClient) return false;
      const trimmed = token.trim();
      this.wsClient.setToken(trimmed);
      this.vibemonConfigManager.write({ vibemon_token: trimmed });
      this.notifyChanged();
      return true;
    });

    ipcMain.handle('settings:refresh-hook-statuses', async () => {
      // Re-fetches the manifest too, so Refresh re-verifies file hashes and
      // not just existence.
      await this.hookInstaller.checkForChanges();
      this.notifyChanged();
      return this.toHookView(this.hookInstaller.getCachedStatuses());
    });

    ipcMain.handle('settings:install-hook', async (_event, flag) => {
      const token = this.wsClient ? this.wsClient.getToken() : null;
      // No result dialog — the Settings window already shows the outcome
      // inline via the row's badge/button state.
      const results = await this.hookInstaller.installByFlag(flag, token, { showSummary: false });
      this.notifyChanged();
      if (results.length === 0 || results.some(r => !r.result.ok)) {
        throw new Error('Hook install failed');
      }
      return this.toHookView(this.hookInstaller.getCachedStatuses());
    });

    ipcMain.handle('settings:repair-vibemon-config', () => {
      const token = this.wsClient ? this.wsClient.getToken() : null;
      this.vibemonConfigManager.ensureDesktopUrl(token);
      this.notifyChanged();
      return this.getVibemonConfigView();
    });

    ipcMain.handle('settings:set-vibemon-config', (_event, partial) => {
      if (!partial || typeof partial !== 'object') return this.getVibemonConfigView();
      this.vibemonConfigManager.write(partial);
      this.notifyChanged();
      return this.getVibemonConfigView();
    });

    ipcMain.handle('settings:add-http-url', (_event, url) => {
      if (typeof url !== 'string') return this.getVibemonConfigView();
      this.vibemonConfigManager.addHttpUrl(url);
      this.notifyChanged();
      return this.getVibemonConfigView();
    });

    ipcMain.handle('settings:remove-http-url', (_event, url) => {
      if (typeof url !== 'string') return this.getVibemonConfigView();
      this.vibemonConfigManager.removeHttpUrl(url);
      this.notifyChanged();
      return this.getVibemonConfigView();
    });

    ipcMain.handle('settings:check-for-updates', async () => {
      await this.updateChecker.checkForUpdates({ notifyOnError: true });
      return this.updateChecker.getState();
    });

    ipcMain.handle('settings:download-update', (_event) => {
      const { status, version } = this.updateChecker.getState();
      if (status !== 'available') return this.updateChecker.getState();
      this.updateChecker.downloadAndInstall(version);
      return this.updateChecker.getState();
    });

    ipcMain.handle('settings:install-downloaded', () => {
      const { status } = this.updateChecker.getState();
      if (status !== 'downloaded') return false;
      this.updateChecker.installDownloaded();
      return true;
    });

    ipcMain.handle('settings:open-external', (_event, key) => {
      const url = EXTERNAL_LINKS[key];
      if (!url) return false;
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
      width: 680,
      height: 620,
      minWidth: 560,
      minHeight: 480,
      show: false,
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
