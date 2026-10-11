const { EventEmitter } = require('node:events');
const { setImmediate } = require('node:timers');

jest.mock('electron', () => ({
  Tray: jest.fn(), Menu: { buildFromTemplate: jest.fn() },
  nativeImage: { createFromBuffer: jest.fn(() => ({ image: true })) },
  BrowserWindow: { fromWebContents: jest.fn() }
}));
jest.mock('canvas', () => ({
  createCanvas: jest.fn(() => ({
    getContext: () => ({ clearRect() {}, beginPath() {}, roundRect() {}, fill() {}, arc() {}, drawImage() {} }),
    toBuffer: () => Buffer.alloc(0)
  })),
  loadImage: jest.fn(() => Promise.resolve({ image: true }))
}));
jest.mock('fs', () => ({ promises: { readFile: jest.fn(() => Promise.resolve(Buffer.alloc(0))) } }));
const { TrayManager, createTrayIcon } = require('../src/modules/tray-manager.cjs');
const { Tray, Menu, BrowserWindow } = require('electron');
const { loadImage } = require('canvas');
const { DEFAULT_CHARACTER } = require('../src/shared/config.cjs');
let manager, native, events, companion, app, focused;
const flush = () => new Promise(setImmediate);
beforeEach(() => {
  jest.clearAllMocks();
  focused = { project: 'one', state: 'working', character: 'codex' };
  companion = { getProjectIds: () => focused ? ['one'] : [], getState: () => focused };
  app = { quit: jest.fn() };
  events = new Map();
  native = { on: jest.fn((name, callback) => events.set(name, callback)), setImage: jest.fn(), setToolTip: jest.fn(), setContextMenu: jest.fn(), popUpContextMenu: jest.fn(), destroy: jest.fn() };
  Tray.mockImplementation(() => native);
  Menu.buildFromTemplate.mockImplementation(template => ({ template, popup: jest.fn() }));
  manager = new TrayManager(companion, app);
  manager.openDashboard = jest.fn(); manager.openSettings = jest.fn();
});
afterEach(() => manager.cleanup());

async function onPlatform(platform, check) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try { await check(); } finally { Object.defineProperty(process, 'platform', descriptor); }
}

test.each(['darwin', 'win32'])('%s primary click opens the workspace; the secondary menu is built on demand', async platform => {
  await onPlatform(platform, async () => {
    manager.createTray(); await flush();
    events.get('click')();
    expect(manager.openDashboard).toHaveBeenCalledTimes(1);
    expect(native.popUpContextMenu).not.toHaveBeenCalled();
    for (let i = 0; i < 250; i++) manager.updateMenu();
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled();
    expect(native.setContextMenu).not.toHaveBeenCalled();
    events.get('right-click')();
    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(native.popUpContextMenu).toHaveBeenCalledTimes(1);
  });
});

test('Linux installs its static navigation menu once', async () => {
  await onPlatform('linux', async () => {
    manager.createTray(); await flush();
    for (let i = 0; i < 250; i++) manager.updateMenu();
    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(native.setContextMenu).toHaveBeenCalledTimes(1);
    expect(events.has('right-click')).toBe(false);
  });
});

test('tray creation requires the dashboard action to be wired', () => {
  manager.openDashboard = null;
  expect(() => manager.createTray()).toThrow('dashboard action is required');
  expect(Tray).not.toHaveBeenCalled();
});

test('the menu exposes navigation and companion visibility without duplicating preferences', () => {
  const show = jest.fn(); manager.setShowCharacterHandler(show);
  const menu = manager.buildMenuTemplate().filter(item => item.type !== 'separator');
  expect(menu.map(item => item.label)).toEqual(['Dashboard', 'Settings…', 'Show companion', 'Integrations…', 'About VibeMon', 'Quit VibeMon']);
  for (const item of menu) item.click();
  expect(manager.openDashboard).toHaveBeenCalledTimes(1);
  expect(manager.openSettings.mock.calls).toEqual([['companion'], ['integrations'], ['about']]);
  expect(show).toHaveBeenCalledTimes(1); expect(app.quit).toHaveBeenCalledTimes(1);
});

test('250 unchanged status events do not redraw the native tray icon', async () => {
  manager.createTray(); await flush(); native.setImage.mockClear();
  for (let i = 0; i < 250; i++) manager.updateIcon();
  await flush(); expect(native.setImage).not.toHaveBeenCalled();
  focused = { ...focused, state: 'alert' }; manager.updateIcon(); await flush();
  expect(native.setImage).toHaveBeenCalledTimes(1);
});

test('late sprite loading cannot overwrite a newer character icon', async () => {
  let finish;
  loadImage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  focused = { ...focused, character: 'clawd' };
  manager.createTray(); await flush();
  focused = { ...focused, character: 'codex' }; manager.updateIcon(); await flush();
  expect(native.setImage).toHaveBeenCalledTimes(1);
  finish({ image: true }); await flush();
  expect(native.setImage).toHaveBeenCalledTimes(1);
});

test('focus defaults to the registry character when no project exists', () => {
  focused = null;
  expect(manager.getFocusedState()).toEqual({ state: 'idle', character: DEFAULT_CHARACTER, project: null });
});

test.each([
  ['connected', [], false], ['connecting', [], false], ['not-configured', [], false],
  ['connection-error', [], true], ['token-expired', [], true],
  ['connected', [{ health: 'ok', stale: true }], true],
  ['connected', [{ health: 'warning' }], true], ['connected', [{ health: 'error' }], true],
  ['connected', [{ health: 'ok', agent: { state: 'notification' } }], true],
  ['connected', [{ health: 'ok', agent: { state: 'alert' } }], true],
  ['connected', [{ health: 'ok', agent: { state: 'working' } }], false]
])('cloud attention: %s %p → %s', (status, sources, attention) => {
  const client = Object.assign(new EventEmitter(), { snapshot: jest.fn(() => ({ status, sources })) });
  manager.setMonitoringClient(client);
  expect(manager.hasAttentionBadge()).toBe(attention);
  manager.updateIcon(); manager.updateIcon();
  expect(client.snapshot).toHaveBeenCalledTimes(1);
  manager.setMonitoringClient(null);
  expect(client.listenerCount('change')).toBe(0);
  expect(manager.hasAttentionBadge()).toBe(false);
});

test('integration repair and actionable updates produce attention badges', () => {
  manager.setHookInstaller({ hasChanges: () => true }); expect(manager.hasAttentionBadge()).toBe(true);
  manager.setHookInstaller(null);
  for (const status of [null, 'checking', 'downloading', 'available', 'downloaded']) {
    manager.setUpdateChecker({ getState: () => ({ status }) });
    expect(manager.hasAttentionBadge()).toBe(['available', 'downloaded'].includes(status));
  }
});

test('the companion context menu binds to its sender window when available', () => {
  const sender = {}, window = { isDestroyed: () => false };
  BrowserWindow.fromWebContents.mockReturnValue(window);
  manager.showContextMenu(sender);
  expect(BrowserWindow.fromWebContents).toHaveBeenCalledWith(sender);
  expect(Menu.buildFromTemplate.mock.results[0].value.popup).toHaveBeenCalledWith({ window });
  BrowserWindow.fromWebContents.mockReturnValue(null);
  manager.showContextMenu(sender);
  expect(Menu.buildFromTemplate.mock.results[1].value.popup).toHaveBeenCalledWith();
});

test('cleanup detaches monitoring and prevents delayed icon work from touching a destroyed tray', async () => {
  const client = Object.assign(new EventEmitter(), { snapshot: () => ({ status: 'connected', sources: [] }) });
  manager.setMonitoringClient(client); manager.createTray(); manager.cleanup(); await flush();
  expect(client.listenerCount('change')).toBe(0);
  expect(native.destroy).toHaveBeenCalledTimes(1);
  expect(native.setImage).not.toHaveBeenCalled();
});

test('sprite and native icon caches reuse the same result', async () => {
  const first = await createTrayIcon('idle', 'codex', true);
  expect(await createTrayIcon('idle', 'codex', true)).toBe(first);
  expect(loadImage).toHaveBeenCalledTimes(1);
});
