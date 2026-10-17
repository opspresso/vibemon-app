/** Settings use cases depend on application ports, never on window or IPC state. */
const {
  ALWAYS_ON_TOP_MODES, CHARACTER_NAMES, CHARACTER_CONFIG, SPEECH_BUBBLE_FIELDS,
  CHARACTER_SCALES, EDGE_MARGINS
} = require('../shared/config.cjs');
const { describeFailure } = require('../shared/install-result.cjs');
const { t } = require('../shared/i18n/locale.cjs');

// ~/.vibemon/config.json fields the workspace shows and edits. Credentials stay out.
const HOOK_SETTINGS = ['debug', 'auto_launch', 'http_urls', 'serial_port'];

// Fixed navigation targets — the renderer picks by key, so no URL ever
// crosses the IPC boundary.
const EXTERNAL_LINKS = {
  docs: 'https://vibemon.io/docs',
  releases: 'https://github.com/opspresso/vibemon-app/releases'
};

class WorkspaceSettings {
  constructor({ windowManager, app, hookInstaller, vibemonConfigManager, updateChecker, openExternal, cloudDelivery }) {
    this.windowManager = windowManager;
    this.app = app;
    this.hookInstaller = hookInstaller;
    this.vibemonConfigManager = vibemonConfigManager;
    this.updateChecker = updateChecker;
    this.openExternal = openExternal;
    this.cloudDelivery = cloudDelivery;
    // The composition root subscribes without coupling settings to a window.
    this.onSettingsChanged = null;

    this.setupActions();
  }

  notifyChanged() {
    if (this.onSettingsChanged) {
      this.onSettingsChanged();
    }
  }

  /**
   * Expose installation state and repair diagnostics without credentials.
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
   * the local integrations section renders it.
   * @returns {object}
   */
  getVibemonConfigView() {
    const config = this.vibemonConfigManager.read();
    const display = Object.fromEntries(HOOK_SETTINGS.map(key => [key, config[key]]));
    return { ...display, status: this.vibemonConfigManager.getStatus() };
  }

  /**
   * Snapshot of preferences, integration health, and update availability.
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
      hooks: this.toHookView(this.hookInstaller.getCachedStatuses()),
      installing: Boolean(this.hookInstaller.isRunning),
      vibemonConfig: this.getVibemonConfigView(),
      update: this.updateChecker.getState(),
      cloudDelivery: this.cloudDelivery.snapshot(),
      options: {
        alwaysOnTopModes: ALWAYS_ON_TOP_MODES,
        characters: CHARACTER_NAMES.map(name => ({ name, displayName: CHARACTER_CONFIG[name].displayName, image: CHARACTER_CONFIG[name].image })),
        speechBubbleFields: SPEECH_BUBBLE_FIELDS,
        characterScales: CHARACTER_SCALES,
        edgeMargins: EDGE_MARGINS
      }
    };
  }

  invoke(action, ...args) {
    if (!this.actions.has(action)) throw new Error('Unknown settings action');
    return this.actions.get(action)(...args);
  }

  setupActions() {
    this.actions = new Map();
    const handle = (action, handler) => this.actions.set(action, handler);
    handle('get-all', () => this.getSnapshot());

    const preference = (action, valid, apply) => handle(action, value => {
      if (!valid(value)) throw new Error(t('error.invalidSetting'));
      apply(value);
      this.notifyChanged();
      return true;
    });
    const choice = values => value => values.includes(value);
    const boolean = value => typeof value === 'boolean';
    preference('set-character-lock', choice(['auto', ...CHARACTER_NAMES]), value => this.windowManager.setCharacterLock(value));
    preference('set-render-mode', choice(['2d', '3d']), value => this.windowManager.setRenderMode(value));
    preference('set-always-on-top-mode', choice(Object.keys(ALWAYS_ON_TOP_MODES)), value => this.windowManager.setAlwaysOnTopMode(value));
    preference('set-character-scale', choice(CHARACTER_SCALES), value => this.windowManager.setCharacterScale(value));
    preference('set-edge-margin', choice(EDGE_MARGINS), value => this.windowManager.setEdgeMargin(value));
    preference('set-dock-auto-scale', boolean, value => this.windowManager.setDockAutoScale(value));
    preference('set-dev-mode', boolean, value => this.windowManager.setDevMode(value));
    preference('set-open-at-login', boolean, value => this.app.setLoginItemSettings({ openAtLogin: value }));

    handle('set-speech-bubble-field', (field, enabled) => {
      if (typeof enabled !== 'boolean') throw new Error(t('error.chooseFieldVisible'));
      if (!SPEECH_BUBBLE_FIELDS.includes(field)) throw new Error(t('error.invalidSetting'));
      this.windowManager.setSpeechBubbleField(field, enabled);
      this.notifyChanged();
      return true;
    });

    handle('reset-hook-prompts', () => {
      this.hookInstaller.clearDismissed();
      this.notifyChanged();
      return this.toHookView(this.hookInstaller.getCachedStatuses());
    });

    handle('refresh-hook-statuses', async () => {
      // Re-fetches the manifest too, so Refresh re-verifies file hashes and
      // not just existence.
      await this.hookInstaller.checkForChanges();
      this.notifyChanged();
      return this.toHookView(this.hookInstaller.getCachedStatuses());
    });

    handle('install-hook', async (flag) => {
      // No result dialog — the workspace already shows the outcome
      // inline via the row's badge/button state.
      const results = await this.hookInstaller.installByFlag(flag, null, { showSummary: false });
      this.notifyChanged();
      const failure = results.find(r => !r.result.ok);
      if (failure || results.length === 0) {
        // The reason travels with the rejection: this path shows no dialog, so
        // without it the renderer can only say "Failed".
        throw new Error(failure ? describeFailure(failure.result) : t('install.failed'));
      }
      return this.toHookView(this.hookInstaller.getCachedStatuses());
    });

    handle('repair-vibemon-config', () => {
      this.vibemonConfigManager.ensureDesktopUrl(null);
      const result = this.getVibemonConfigView();
      if (!result.status.hasDesktopUrl) throw new Error(t('error.repairConfig'));
      this.notifyChanged();
      return result;
    });

    handle('set-vibemon-config', (partial) => {
      if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw new Error(t('error.configObject'));
      if (Object.keys(partial).some(key => !HOOK_SETTINGS.includes(key))) throw new Error(t('error.hookSettingLocked'));
      this.vibemonConfigManager.write(partial);
      this.notifyChanged();
      return this.getVibemonConfigView();
    });

    handle('configure-cloud-delivery', value => this.cloudDelivery.configure(value));
    handle('check-cloud-delivery', () => this.cloudDelivery.check());
    handle('disconnect-cloud-delivery', () => this.cloudDelivery.disconnect());

    handle('add-http-url', (url) => {
      if (typeof url !== 'string') throw new Error(t('error.httpUrl'));
      this.vibemonConfigManager.addHttpUrl(url);
      this.notifyChanged();
      return this.getVibemonConfigView();
    });

    handle('remove-http-url', (url) => {
      if (typeof url !== 'string') throw new Error(t('error.httpUrl'));
      this.vibemonConfigManager.removeHttpUrl(url);
      this.notifyChanged();
      return this.getVibemonConfigView();
    });

    handle('check-for-updates', async () => {
      await this.updateChecker.checkForUpdates();
      return this.updateChecker.getState();
    });

    handle('download-update', async () => {
      const { status } = this.updateChecker.getState();
      if (status !== 'available') return this.updateChecker.getState();
      await this.updateChecker.downloadUpdate();
      return this.updateChecker.getState();
    });

    handle('install-downloaded', () => {
      const { status } = this.updateChecker.getState();
      if (status !== 'downloaded') throw new Error(t('error.downloadFirst'));
      this.updateChecker.installDownloaded();
      return true;
    });

    handle('open-external', async (key) => {
      if (!Object.hasOwn(EXTERNAL_LINKS, key)) throw new Error(t('error.invalidSetting'));
      const url = EXTERNAL_LINKS[key];
      await this.openExternal(url);
      return true;
    });
  }
}

module.exports = { WorkspaceSettings };
