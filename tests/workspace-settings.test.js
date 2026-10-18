const { WorkspaceSettings } = require('../src/workspace/settings.cjs');

function fixture() {
  const values = {
    CharacterLock: 'auto', RenderMode: '2d', AlwaysOnTopMode: 'active-only',
    SpeechBubbleFields: { status: true }, CharacterScale: 100,
    DockAutoScale: false, EdgeMargin: 0, DevMode: false
  };
  const windowManager = {};
  for (const key of Object.keys(values)) {
    windowManager[`get${key}`] = () => values[key];
    windowManager[`set${key}`] = value => { values[key] = value; };
  }
  windowManager.setSpeechBubbleField = (field, enabled) => { values.SpeechBubbleFields[field] = enabled; };
  const hook = { name: 'Codex', flag: '--codex', present: true, hasHook: true, changed: true, privateData: 'never expose' };
  const configuration = { debug: false, auto_launch: true, http_urls: [], serial_port: null, vibemon_url: 'https://vibemon.io', vibemon_token: 'never expose' };
  let login = false;
  let update = { status: null, version: null };
  const dependencies = {
    windowManager,
    app: { getVersion: () => '3.0.1', isPackaged: true, getLoginItemSettings: () => ({ openAtLogin: login }), setLoginItemSettings: value => { login = value.openAtLogin; } },
    hookInstaller: {
      getCachedStatuses: () => [hook],
      clearDismissed: jest.fn(),
      checkForChanges: jest.fn(async () => { hook.changed = false; }),
      installByFlag: jest.fn(async () => [{ result: { ok: true } }])
    },
    vibemonConfigManager: {
      read: () => configuration,
      getStatus: () => ({ exists: true, hasDesktopUrl: true }),
      write: jest.fn(partial => Object.assign(configuration, partial)),
      ensureDesktopUrl: jest.fn(), addHttpUrl: jest.fn(), removeHttpUrl: jest.fn()
    },
    updateChecker: {
      getState: () => update,
      checkForUpdates: jest.fn(async () => { update = { status: 'available', version: '3.0.2' }; }),
      downloadUpdate: jest.fn(async () => { update = { ...update, status: 'downloaded' }; }),
      installDownloaded: jest.fn()
    },
    cloudDelivery: { snapshot: () => ({ status: 'not-verified', tokenConfigured: true }), configure: jest.fn(), check: jest.fn(), disconnect: jest.fn() },
    openExternal: jest.fn(async () => {})
  };
  const settings = new WorkspaceSettings(dependencies);
  settings.onSettingsChanged = jest.fn();
  return { settings, values, dependencies, setUpdate: value => { update = value; } };
}

test('preference actions apply through companion ports without owning a window', () => {
  const { settings, values } = fixture();
  settings.invoke('set-render-mode', '3d');
  settings.invoke('set-character-lock', 'codex');
  settings.invoke('set-always-on-top-mode', 'all');
  settings.invoke('set-character-scale', 60);
  settings.invoke('set-edge-margin', 8);
  settings.invoke('set-dock-auto-scale', true);
  settings.invoke('set-dev-mode', true);
  settings.invoke('set-open-at-login', true);
  settings.invoke('set-speech-bubble-field', 'project', false);
  expect(values).toMatchObject({ RenderMode: '3d', CharacterLock: 'codex', CharacterScale: 60, EdgeMargin: 8, DockAutoScale: true, DevMode: true });
  expect(settings.getSnapshot()).toMatchObject({ openAtLogin: true, speechBubbleFields: { project: false } });
  expect(settings.onSettingsChanged).toHaveBeenCalledTimes(9);
  expect(settings).not.toHaveProperty('window');
});

test.each([
  ['set-render-mode', '4d'], ['set-character-lock', '../other'], ['set-character-scale', 7],
  ['set-edge-margin', -1], ['set-always-on-top-mode', '__proto__'], ['set-dock-auto-scale', 1],
  ['set-dev-mode', 'false'], ['set-open-at-login', 'false'], ['set-speech-bubble-field', 'project', 'false'],
  ['set-speech-bubble-field', 'unknown', true], ['__proto__'], ['constructor']
])('invalid %s input leaves the existing preferences unchanged', (...action) => {
  const { settings } = fixture();
  const before = settings.getSnapshot();
  expect(() => settings.invoke(...action)).toThrow();
  expect(settings.getSnapshot()).toEqual(before);
  expect(settings.onSettingsChanged).not.toHaveBeenCalled();
});

test('snapshots expose safe installation fields, never credentials', () => {
  const { settings } = fixture();
  const snapshot = settings.invoke('get-all');
  expect(snapshot.hooks[0]).toMatchObject({ flag: '--codex', changed: true });
  expect(JSON.stringify(snapshot)).not.toContain('never expose');
  expect(snapshot.vibemonConfig).not.toHaveProperty('vibemon_token');
});

test('hook writes are limited to the settings surface and preserve write credentials', () => {
  const { settings, dependencies } = fixture();
  settings.invoke('set-vibemon-config', { debug: true });
  expect(dependencies.vibemonConfigManager.read()).toMatchObject({ debug: true, vibemon_token: 'never expose' });
  for (const payload of [null, [], { vibemon_token: 'replace' }, { cache_path: '/other' }, { vibemon_url: 'https://other.example' }]) {
    expect(() => settings.invoke('set-vibemon-config', payload)).toThrow();
  }
  expect(dependencies.vibemonConfigManager.write).toHaveBeenCalledTimes(1);
  expect(settings.invoke('repair-vibemon-config').status.hasDesktopUrl).toBe(true);
});

test('installation failure keeps its actionable reason and does not open a second dialog', async () => {
  const { settings, dependencies } = fixture();
  dependencies.hookInstaller.installByFlag.mockResolvedValue([{ result: { ok: false, reason: 'integrity-check-failed' } }]);
  await expect(settings.invoke('install-hook', '--codex')).rejects.toThrow('integrity check failed');
  expect(dependencies.hookInstaller.installByFlag).toHaveBeenCalledWith('--codex', { showSummary: false });
  dependencies.hookInstaller.installByFlag.mockResolvedValue([]);
  await expect(settings.invoke('install-hook', '--codex')).rejects.toThrow('Hook install failed');
  dependencies.hookInstaller.installByFlag.mockResolvedValue([{ result: { ok: true } }]);
  expect(await settings.invoke('install-hook', '--codex')).toHaveLength(1);
  expect((await settings.invoke('refresh-hook-statuses'))[0].changed).toBe(false);
  settings.invoke('reset-hook-prompts');
  expect(dependencies.hookInstaller.clearDismissed).toHaveBeenCalledTimes(1);
});

test('external links use known destinations and propagate launch failures', async () => {
  const { settings, dependencies } = fixture();
  await expect(settings.invoke('open-external', 'file:///private')).rejects.toThrow();
  expect(dependencies.openExternal).not.toHaveBeenCalled();
  await settings.invoke('open-external', 'docs');
  expect(dependencies.openExternal).toHaveBeenCalledWith('https://vibemon.io/docs');
  dependencies.openExternal.mockRejectedValue(new Error('Browser unavailable'));
  await expect(settings.invoke('open-external', 'releases')).rejects.toThrow('Browser unavailable');
});

test('update actions follow the updater lifecycle', async () => {
  const { settings, dependencies, setUpdate } = fixture();
  expect(() => settings.invoke('install-downloaded')).toThrow('Download the update');
  await settings.invoke('download-update');
  expect(dependencies.updateChecker.downloadUpdate).not.toHaveBeenCalled();
  expect((await settings.invoke('check-for-updates')).status).toBe('available');
  expect((await settings.invoke('download-update')).status).toBe('downloaded');
  setUpdate({ status: 'downloaded', version: '3.0.2' });
  settings.invoke('install-downloaded');
  expect(dependencies.updateChecker.installDownloaded).toHaveBeenCalledTimes(1);
});
