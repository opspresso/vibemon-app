const { setImmediate } = require('node:timers');

jest.mock('electron', () => ({
  Tray: jest.fn(), Menu: { buildFromTemplate: jest.fn() },
  nativeImage: {
    createFromBuffer: jest.fn(() => ({ isEmpty: () => false, getSize: () => ({ width: 2, height: 2 }), toBitmap: () => Buffer.alloc(16, 255) })),
    createFromBitmap: jest.fn(() => ({ image: true }))
  },
  BrowserWindow: { fromWebContents: jest.fn() }
}));
jest.mock('fs', () => ({ promises: { readFile: jest.fn(() => Promise.resolve(Buffer.alloc(0))) } }));
const { TrayManager, createTrayIcon } = require('../src/modules/tray-manager.cjs');
const { Tray, Menu, BrowserWindow } = require('electron');
const fs = require('fs');
const { DEFAULT_CHARACTER } = require('../src/shared/config.cjs');
let manager, native, events, companion, app, focused, shown;
const flush = () => new Promise(setImmediate);
beforeEach(() => {
  jest.clearAllMocks();
  focused = { project: 'one', state: 'working', character: 'codex' };
  shown = false;
  companion = { getProjectIds: () => focused ? ['one'] : [], getState: () => focused, isCompanionShown: () => shown };
  app = { quit: jest.fn(), getVersion: () => '9.8.7' };
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

test.each(['win32'])('%s tray clicks open only the menu; Dashboard opens the workspace', async platform => {
  await onPlatform(platform, async () => {
    manager.createTray(); await flush();
    for (let i = 0; i < 250; i++) manager.updateMenu();
    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(native.setContextMenu).not.toHaveBeenCalled();
    for (const event of ['click', 'right-click']) {
      events.get(event)();
      expect(manager.openDashboard).not.toHaveBeenCalled();
      expect(manager.openSettings).not.toHaveBeenCalled();
      const menu = native.popUpContextMenu.mock.calls.at(-1)[0];
      expect(menu.template.map(item => item.label)).toContain('Dashboard');
    }
    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(native.popUpContextMenu).toHaveBeenCalledTimes(2);
    native.popUpContextMenu.mock.calls[0][0].template.find(item => item.label === 'Dashboard').click();
    expect(manager.openDashboard).toHaveBeenCalledTimes(1);
  });
});

test.each(['darwin', 'linux'])('%s installs its static native menu once', async platform => {
  await onPlatform(platform, async () => {
    manager.createTray(); await flush();
    for (let i = 0; i < 250; i++) manager.updateMenu();
    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(native.setContextMenu).toHaveBeenCalledTimes(1);
    expect(events.has('click')).toBe(false);
    expect(events.has('right-click')).toBe(false);
    expect(manager.openDashboard).not.toHaveBeenCalled();
    native.setContextMenu.mock.calls[0][0].template.find(item => item.label === 'Dashboard').click();
    expect(manager.openDashboard).toHaveBeenCalledTimes(1);
  });
});

test('tray creation requires the dashboard action to be wired', () => {
  manager.openDashboard = null;
  expect(() => manager.createTray()).toThrow('dashboard action is required');
  expect(Tray).not.toHaveBeenCalled();
});

test('the menu exposes navigation and companion visibility without duplicating preferences', () => {
  const show = jest.fn(); manager.setCompanionVisibleHandler(show);
  const template = manager.buildMenuTemplate();
  expect(template.map(item => item.label ?? '—')).toEqual(['VibeMon 9.8.7', '—', 'Dashboard', 'Show companion', '—', 'Settings…', 'Integrations…', '—', 'About VibeMon', 'Quit VibeMon']);
  expect(template[0].enabled).toBe(false);
  const menu = template.filter(item => item.click);
  for (const item of menu) item.click();
  expect(manager.openDashboard).toHaveBeenCalledTimes(1);
  expect(manager.openSettings.mock.calls).toEqual([['companion'], ['integrations'], ['about']]);
  expect(show.mock.calls).toEqual([[true]]); expect(app.quit).toHaveBeenCalledTimes(1);
});

test('a shown companion offers Hide companion, and the change reaches the application menu', () => {
  const setVisible = jest.fn(); manager.setCompanionVisibleHandler(setVisible);
  const changed = jest.fn(); manager.onCompanionShownChanged = changed;
  manager.createTray();
  shown = true; manager.updateMenu();
  const hide = manager.buildMenuTemplate().find(item => item.label === 'Hide companion');
  hide.click();
  expect(setVisible.mock.calls).toEqual([[false]]);
  shown = false; manager.updateMenu();
  expect(changed.mock.calls).toEqual([[false], [true], [false]]);
  expect(native.setContextMenu.mock.calls.at(-1)[0].template.some(item => item.label === 'Show companion')).toBe(true);
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
  fs.promises.readFile.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  focused = { ...focused, character: 'clawd' };
  manager.createTray(); await flush();
  focused = { ...focused, character: 'codex' }; manager.updateIcon(); await flush();
  expect(native.setImage).toHaveBeenCalledTimes(1);
  finish(Buffer.alloc(0)); await flush();
  expect(native.setImage).toHaveBeenCalledTimes(1);
});

test('focus defaults to the registry character when no project exists', () => {
  focused = null;
  expect(manager.getFocusedState()).toEqual({ state: 'idle', character: DEFAULT_CHARACTER, project: null });
});

const quiet = { dashboard: null, connection: null, integrations: null, update: null };
const notices = {
  dashboard: '1 resource · 2 coding accounts need attention',
  connection: 'Read token rejected',
  integrations: 'Claude Code needs repair',
  update: 'Version 9.9.9 is available'
};

test('each notice lights the badge and names its page in the tooltip', async () => {
  manager.createTray(); await flush();
  expect(manager.hasAttentionBadge()).toBe(false);
  for (const [area, text] of Object.entries(notices)) {
    manager.setAttention({ ...quiet, [area]: text });
    expect(manager.hasAttentionBadge()).toBe(true);
    expect(native.setToolTip.mock.calls.at(-1)[0]).toContain(text);
  }
  manager.setAttention(notices);
  expect(native.setToolTip).toHaveBeenLastCalledWith('VibeMon\nRead token rejected — open Settings\n1 resource · 2 coding accounts need attention — open Dashboard\nClaude Code needs repair — open Integrations\nVersion 9.9.9 is available — open About VibeMon');
  manager.setAttention(quiet);
  expect(manager.hasAttentionBadge()).toBe(false);
});

test('macOS menu items that open an affected page carry a dot and the reason', async () => onPlatform('darwin', async () => {
  manager.createTray(); await flush();
  manager.setAttention({ ...quiet, dashboard: notices.dashboard, integrations: notices.integrations });
  const items = Object.fromEntries(manager.buildMenuTemplate().filter(item => item.label).map(item => [item.label, item]));
  expect(items.Dashboard).toMatchObject({ sublabel: notices.dashboard, icon: { image: true } });
  expect(items['Integrations…']).toMatchObject({ sublabel: notices.integrations });
  for (const label of ['Settings…', 'Show companion', 'About VibeMon', 'Quit VibeMon']) {
    expect(items[label].sublabel).toBeUndefined();
    expect(items[label].icon).toBeUndefined();
  }
}));

test.each(['win32', 'linux'])('%s menus name the reason in the label, which they draw', async platform => {
  await onPlatform(platform, async () => {
    manager.setAttention({ ...quiet, integrations: notices.integrations });
    const item = manager.buildMenuTemplate().find(entry => entry.label?.startsWith('Integrations…'));
    expect(item).toMatchObject({ label: `Integrations… — ${notices.integrations}`, icon: { image: true } });
    expect(item.sublabel).toBeUndefined();
  });
});

test('a connection issue sends Settings to Connections', () => {
  manager.setAttention({ ...quiet, connection: notices.connection });
  manager.buildMenuTemplate().find(item => item.label?.startsWith('Settings…')).click();
  manager.setAttention(quiet);
  manager.buildMenuTemplate().find(item => item.label === 'Settings…').click();
  expect(manager.openSettings.mock.calls).toEqual([['connections'], ['companion']]);
});

test('the native menu is rebuilt only when its notices change', async () => {
  await onPlatform('darwin', async () => {
    manager.createTray(); await flush();
    for (let i = 0; i < 50; i++) manager.setAttention(quiet);
    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    manager.setAttention({ ...quiet, update: notices.update });
    for (let i = 0; i < 50; i++) manager.setAttention({ ...quiet, update: notices.update });
    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(2);
    expect(native.setContextMenu).toHaveBeenCalledTimes(2);
  });
});

test('250 unchanged notices do not redraw the icon or tooltip', async () => {
  manager.setAttention(notices);
  manager.createTray(); await flush();
  native.setToolTip.mockClear(); native.setImage.mockClear();
  for (let i = 0; i < 250; i++) { manager.updateIcon(); manager.setAttention(notices); }
  await flush();
  expect(native.setToolTip).not.toHaveBeenCalled();
  expect(native.setImage).not.toHaveBeenCalled();
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

test('cleanup prevents delayed icon work from touching a destroyed tray', async () => {
  manager.createTray(); manager.cleanup(); await flush();
  manager.setAttention(notices);
  expect(native.destroy).toHaveBeenCalledTimes(1);
  expect(native.setImage).not.toHaveBeenCalled();
});

test('sprite and native icon caches reuse the same result', async () => {
  const first = await createTrayIcon('idle', 'codex', true);
  expect(await createTrayIcon('idle', 'codex', true)).toBe(first);
  expect(fs.promises.readFile).toHaveBeenCalledTimes(1);
});
