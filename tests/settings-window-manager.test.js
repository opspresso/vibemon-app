/**
 * Tests for settings-window-manager.cjs
 * Exercises the IPC handlers with mocked electron and manager dependencies.
 */

const mockIpcHandlers = new Map();

jest.mock('electron', () => {
  const { EventEmitter } = require('events');

  class MockBrowserWindow extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.webContents = { send: jest.fn() };
      this._destroyed = false;
      this.loadFile = jest.fn();
      this.show = jest.fn();
      this.focus = jest.fn();
      MockBrowserWindow.instances.push(this);
    }
    isDestroyed() { return this._destroyed; }
    close() {
      if (this._destroyed) return;
      this._destroyed = true;
      this.emit('closed');
    }
  }
  MockBrowserWindow.instances = [];

  return {
    BrowserWindow: MockBrowserWindow,
    ipcMain: {
      handle: jest.fn((channel, handler) => {
        mockIpcHandlers.set(channel, handler);
      })
    },
    shell: { openExternal: jest.fn() }
  };
});

const { BrowserWindow, shell } = require('electron');
const { SettingsWindowManager } = require('../src/modules/settings-window-manager.cjs');
const { APP_MODES, CHARACTER_NAMES } = require('../src/shared/config.cjs');

function makeDeps() {
  return {
    windowManager: {
      getAppMode: jest.fn(() => 'window'),
      setAppMode: jest.fn(),
      getWindowMode: jest.fn(() => 'multi'),
      setWindowMode: jest.fn(),
      getCharacterLock: jest.fn(() => 'auto'),
      setCharacterLock: jest.fn(),
      getAlwaysOnTopMode: jest.fn(() => 'active-only'),
      setAlwaysOnTopMode: jest.fn(),
      getSpeechBubbleFields: jest.fn(() => ({ status: true })),
      setSpeechBubbleField: jest.fn()
    },
    app: {
      getVersion: jest.fn(() => '9.9.9'),
      isPackaged: false,
      getLoginItemSettings: jest.fn(() => ({ openAtLogin: false })),
      setLoginItemSettings: jest.fn()
    },
    hookInstaller: {
      getCachedStatuses: jest.fn(() => [
        { name: 'Claude Code', flag: '--claude', present: true, hasHook: false, hookFile: '/secret/path' }
      ]),
      refreshStatuses: jest.fn(() => [
        { name: 'Claude Code', flag: '--claude', present: true, hasHook: true, hookFile: '/secret/path' }
      ]),
      installByFlag: jest.fn(() => Promise.resolve([
        { tool: { flag: '--claude' }, result: { ok: true } }
      ]))
    },
    vibemonConfigManager: {
      read: jest.fn(() => ({
        debug: false,
        auto_launch: true,
        http_urls: [],
        serial_port: null,
        vibemon_url: 'https://vibemon.io',
        vibemon_token: ''
      })),
      getStatus: jest.fn(() => ({ exists: false, hasDesktopUrl: false })),
      write: jest.fn(),
      ensureDesktopUrl: jest.fn(),
      addHttpUrl: jest.fn(),
      removeHttpUrl: jest.fn()
    },
    updateChecker: {
      getState: jest.fn(() => ({ status: null, version: null })),
      checkForUpdates: jest.fn(() => Promise.resolve(null)),
      downloadAndInstall: jest.fn(),
      installDownloaded: jest.fn()
    }
  };
}

function freshManager() {
  mockIpcHandlers.clear();
  BrowserWindow.instances.length = 0;
  const deps = makeDeps();
  const manager = new SettingsWindowManager(deps);
  manager.onSettingsChanged = jest.fn();
  return { manager, deps };
}

function invoke(channel, ...args) {
  const handler = mockIpcHandlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler({}, ...args);
}

describe('settings:get-all', () => {
  test('returns a full snapshot including options for the selects', async () => {
    const { manager } = freshManager();

    const before = await invoke('settings:get-all');
    expect(before.version).toBe('9.9.9');
    expect(before.appMode).toBe('window');
    expect(before.options.appModes).toEqual(APP_MODES);
    expect(before.options.characterNames).toEqual(CHARACTER_NAMES);
    // No wsClient yet: safe defaults
    expect(before.ws).toEqual({ status: 'not-configured', token: '' });

    manager.setWsClient({ getStatus: () => 'connected', getToken: () => 'tok' });
    const after = await invoke('settings:get-all');
    expect(after.ws).toEqual({ status: 'connected', token: 'tok' });
  });

  test('strips filesystem paths from hook statuses', async () => {
    freshManager();
    const snap = await invoke('settings:get-all');
    expect(snap.hooks).toEqual([
      { name: 'Claude Code', flag: '--claude', present: true, hasHook: false }
    ]);
  });

  test('includes the full vibemon config plus its status', async () => {
    const { deps } = freshManager();
    deps.vibemonConfigManager.getStatus.mockReturnValue({ exists: true, hasDesktopUrl: true });

    const snap = await invoke('settings:get-all');

    expect(snap.vibemonConfig).toEqual(expect.objectContaining({
      debug: false,
      vibemon_url: 'https://vibemon.io',
      status: { exists: true, hasDesktopUrl: true }
    }));
  });
});

describe('setting mutations', () => {
  test('set-app-mode applies valid modes and notifies', async () => {
    const { manager, deps } = freshManager();
    expect(await invoke('settings:set-app-mode', 'character')).toBe(true);
    expect(deps.windowManager.setAppMode).toHaveBeenCalledWith('character');
    expect(manager.onSettingsChanged).toHaveBeenCalled();
  });

  test('set-app-mode rejects unknown modes', async () => {
    const { manager, deps } = freshManager();
    expect(await invoke('settings:set-app-mode', 'bogus')).toBe(false);
    expect(deps.windowManager.setAppMode).not.toHaveBeenCalled();
    expect(manager.onSettingsChanged).not.toHaveBeenCalled();
  });

  test('set-window-mode accepts only multi/single', async () => {
    const { deps } = freshManager();
    expect(await invoke('settings:set-window-mode', 'single')).toBe(true);
    expect(deps.windowManager.setWindowMode).toHaveBeenCalledWith('single');
    expect(await invoke('settings:set-window-mode', 'triple')).toBe(false);
  });

  test('set-character-lock accepts auto and known characters only', async () => {
    const { deps } = freshManager();
    expect(await invoke('settings:set-character-lock', 'auto')).toBe(true);
    expect(await invoke('settings:set-character-lock', 'codex')).toBe(true);
    expect(await invoke('settings:set-character-lock', 'pikachu')).toBe(false);
    expect(deps.windowManager.setCharacterLock).toHaveBeenCalledTimes(2);
  });

  test('set-always-on-top-mode accepts only known modes', async () => {
    const { deps } = freshManager();
    expect(await invoke('settings:set-always-on-top-mode', 'all')).toBe(true);
    expect(deps.windowManager.setAlwaysOnTopMode).toHaveBeenCalledWith('all');
    expect(await invoke('settings:set-always-on-top-mode', 'bogus')).toBe(false);
  });

  test('set-speech-bubble-field validates the field name and coerces enabled', async () => {
    const { deps } = freshManager();
    expect(await invoke('settings:set-speech-bubble-field', 'memory', 1)).toBe(true);
    expect(deps.windowManager.setSpeechBubbleField).toHaveBeenCalledWith('memory', true);
    expect(await invoke('settings:set-speech-bubble-field', 'nope', true)).toBe(false);
  });

  test('set-token trims and forwards to wsClient and the vibemon config; rejects without one', async () => {
    const { manager, deps } = freshManager();
    expect(await invoke('settings:set-token', ' tok ')).toBe(false);

    const wsClient = { setToken: jest.fn(), getStatus: () => 'connected', getToken: () => '' };
    manager.setWsClient(wsClient);
    expect(await invoke('settings:set-token', ' tok ')).toBe(true);
    expect(wsClient.setToken).toHaveBeenCalledWith('tok');
    expect(deps.vibemonConfigManager.write).toHaveBeenCalledWith({ vibemon_token: 'tok' });
    expect(await invoke('settings:set-token', 123)).toBe(false);
  });

  test('set-open-at-login forwards a boolean to the app', async () => {
    const { deps } = freshManager();
    expect(await invoke('settings:set-open-at-login', true)).toBe(true);
    expect(deps.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
  });
});

describe('AI tool hooks', () => {
  test('install-hook passes the wsClient token and returns refreshed statuses', async () => {
    const { manager, deps } = freshManager();
    manager.setWsClient({ getToken: () => 'tok', getStatus: () => 'connected' });

    const result = await invoke('settings:install-hook', '--claude');

    expect(deps.hookInstaller.installByFlag).toHaveBeenCalledWith('--claude', 'tok', { showSummary: false });
    expect(result[0]).not.toHaveProperty('hookFile');
  });

  test('install-hook rejects when the install fails, so the renderer can show a failed state', async () => {
    const { deps } = freshManager();
    deps.hookInstaller.installByFlag.mockResolvedValueOnce([
      { tool: { flag: '--claude' }, result: { ok: false, reason: 'exit-code' } }
    ]);

    await expect(invoke('settings:install-hook', '--claude')).rejects.toThrow();
  });

  test('refresh-hook-statuses recomputes and strips paths', async () => {
    const { deps } = freshManager();
    const result = await invoke('settings:refresh-hook-statuses');
    expect(deps.hookInstaller.refreshStatuses).toHaveBeenCalled();
    expect(result).toEqual([
      { name: 'Claude Code', flag: '--claude', present: true, hasHook: true }
    ]);
  });
});

describe('VibeMon Config', () => {
  test('repair-vibemon-config passes the wsClient token and returns the refreshed config+status', async () => {
    const { manager, deps } = freshManager();
    manager.setWsClient({ getToken: () => 'tok', getStatus: () => 'connected' });
    deps.vibemonConfigManager.getStatus.mockReturnValue({ exists: true, hasDesktopUrl: true });

    const result = await invoke('settings:repair-vibemon-config');

    expect(deps.vibemonConfigManager.ensureDesktopUrl).toHaveBeenCalledWith('tok');
    expect(result.status).toEqual({ exists: true, hasDesktopUrl: true });
  });

  test('repair-vibemon-config works without a wsClient configured', async () => {
    const { deps } = freshManager();

    await invoke('settings:repair-vibemon-config');

    expect(deps.vibemonConfigManager.ensureDesktopUrl).toHaveBeenCalledWith(null);
  });

  test('set-vibemon-config writes the partial update and returns the refreshed config+status', async () => {
    const { deps } = freshManager();

    const result = await invoke('settings:set-vibemon-config', { debug: true });

    expect(deps.vibemonConfigManager.write).toHaveBeenCalledWith({ debug: true });
    expect(result).toEqual(expect.objectContaining({ debug: false })); // mocked read() is static
  });

  test('set-vibemon-config ignores a non-object payload without writing', async () => {
    const { deps } = freshManager();

    await invoke('settings:set-vibemon-config', null);

    expect(deps.vibemonConfigManager.write).not.toHaveBeenCalled();
  });

  test('add-http-url forwards the URL and returns the refreshed config+status', async () => {
    const { deps } = freshManager();

    await invoke('settings:add-http-url', 'http://x');

    expect(deps.vibemonConfigManager.addHttpUrl).toHaveBeenCalledWith('http://x');
  });

  test('add-http-url ignores a non-string payload without writing', async () => {
    const { deps } = freshManager();

    await invoke('settings:add-http-url', 123);

    expect(deps.vibemonConfigManager.addHttpUrl).not.toHaveBeenCalled();
  });

  test('remove-http-url forwards the URL and returns the refreshed config+status', async () => {
    const { deps } = freshManager();

    await invoke('settings:remove-http-url', 'http://x');

    expect(deps.vibemonConfigManager.removeHttpUrl).toHaveBeenCalledWith('http://x');
  });

  test('remove-http-url ignores a non-string payload without writing', async () => {
    const { deps } = freshManager();

    await invoke('settings:remove-http-url', null);

    expect(deps.vibemonConfigManager.removeHttpUrl).not.toHaveBeenCalled();
  });
});

describe('updates', () => {
  test('check-for-updates awaits the check and returns the latest state', async () => {
    const { deps } = freshManager();
    deps.updateChecker.getState.mockReturnValue({ status: 'available', version: '2.0.0' });
    const state = await invoke('settings:check-for-updates');
    expect(deps.updateChecker.checkForUpdates).toHaveBeenCalled();
    expect(state).toEqual({ status: 'available', version: '2.0.0' });
  });

  test('download-update only starts when an update is available', async () => {
    const { deps } = freshManager();
    await invoke('settings:download-update');
    expect(deps.updateChecker.downloadAndInstall).not.toHaveBeenCalled();

    deps.updateChecker.getState.mockReturnValue({ status: 'available', version: '2.0.0' });
    await invoke('settings:download-update');
    expect(deps.updateChecker.downloadAndInstall).toHaveBeenCalledWith('2.0.0');
  });

  test('install-downloaded only fires in the downloaded state', async () => {
    const { deps } = freshManager();
    expect(await invoke('settings:install-downloaded')).toBe(false);
    deps.updateChecker.getState.mockReturnValue({ status: 'downloaded', version: '2.0.0' });
    expect(await invoke('settings:install-downloaded')).toBe(true);
    expect(deps.updateChecker.installDownloaded).toHaveBeenCalled();
  });
});

describe('settings:open-external', () => {
  test('opens only known link keys', async () => {
    freshManager();
    expect(await invoke('settings:open-external', 'docs')).toBe(true);
    expect(shell.openExternal).toHaveBeenCalledWith('https://vibemon.io/docs');

    shell.openExternal.mockClear();
    expect(await invoke('settings:open-external', 'https://evil.example')).toBe(false);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});

describe('open', () => {
  test('creates a window, loads settings.html, and shows it once ready-to-show fires', () => {
    const { manager } = freshManager();
    manager.open();

    expect(BrowserWindow.instances).toHaveLength(1);
    const win = BrowserWindow.instances[0];
    expect(win.loadFile).toHaveBeenCalledWith(expect.stringContaining('settings.html'));
    expect(win.show).not.toHaveBeenCalled();

    win.emit('ready-to-show');
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  test('reuses an existing window instead of creating a new one', () => {
    const { manager } = freshManager();
    manager.open();
    const win = BrowserWindow.instances[0];

    manager.open();

    expect(BrowserWindow.instances).toHaveLength(1);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  test('creates a new window after the previous one closed', () => {
    const { manager } = freshManager();
    manager.open();
    const first = BrowserWindow.instances[0];
    first.close();
    expect(manager.window).toBeNull();

    manager.open();

    expect(BrowserWindow.instances).toHaveLength(2);
    expect(manager.window).toBe(BrowserWindow.instances[1]);
  });
});

describe('cleanup', () => {
  test('closes an open window and clears the reference', () => {
    const { manager } = freshManager();
    manager.open();
    const win = BrowserWindow.instances[0];

    manager.cleanup();

    expect(win.isDestroyed()).toBe(true);
    expect(manager.window).toBeNull();
  });

  test('is a no-op when no window is open', () => {
    const { manager } = freshManager();
    expect(() => manager.cleanup()).not.toThrow();
    expect(manager.window).toBeNull();
  });
});

describe('notifyUpdateStateChanged', () => {
  test('pushes the latest update state to an open window', () => {
    const { manager, deps } = freshManager();
    deps.updateChecker.getState.mockReturnValue({ status: 'downloaded', version: '2.0.0' });
    manager.open();
    const win = BrowserWindow.instances[0];

    manager.notifyUpdateStateChanged();

    expect(win.webContents.send).toHaveBeenCalledWith('settings:update-state', { status: 'downloaded', version: '2.0.0' });
  });

  test('does nothing when no window is open', () => {
    const { manager } = freshManager();
    expect(() => manager.notifyUpdateStateChanged()).not.toThrow();
  });
});
