/**
 * Tests for tray-manager.cjs
 */

jest.mock('electron', () => ({
  Tray: jest.fn(),
  Menu: { buildFromTemplate: jest.fn() },
  nativeImage: { createFromBuffer: jest.fn() },
  BrowserWindow: jest.fn(),
  ipcMain: { on: jest.fn(), handle: jest.fn() },
  shell: {}
}));

jest.mock('canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(() => Promise.resolve(null))
}));

const { TrayManager } = require('../src/modules/tray-manager.cjs');

function makeWindowManager(state) {
  return {
    getProjectIds: () => (state ? ['proj-a'] : []),
    getState: () => state,
    getCharacterLock: () => 'auto',
    setCharacterLock: jest.fn(),
    getAlwaysOnTopMode: () => 'active-only',
    setAlwaysOnTopMode: jest.fn(),
    getSpeechBubbleFields: () => ({ status: true, project: false }),
    setSpeechBubbleField: jest.fn()
  };
}

function makeApp() {
  return {
    getVersion: () => '0.0.0',
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: jest.fn()
  };
}

describe('TrayManager settings menu item', () => {
  test('shows Settings... that opens the settings window when a manager is set', () => {
    const windowManager = makeWindowManager({ state: 'idle', character: 'clawd', project: 'proj-a' });
    const tray = new TrayManager(windowManager, makeApp(), { setupStateTimeout: jest.fn() });
    const settingsWindowManager = { open: jest.fn() };
    tray.setSettingsWindowManager(settingsWindowManager);

    const template = tray.buildMenuTemplate();
    const settingsItem = template.find(i => i.label === 'Settings...');

    expect(settingsItem).toBeDefined();
    settingsItem.click();
    expect(settingsWindowManager.open).toHaveBeenCalled();
  });

  test('omits Settings... when no settings window manager is set', () => {
    const windowManager = makeWindowManager({ state: 'idle', character: 'clawd', project: 'proj-a' });
    const tray = new TrayManager(windowManager, makeApp(), { setupStateTimeout: jest.fn() });

    const template = tray.buildMenuTemplate();
    expect(template.find(i => i.label === 'Settings...')).toBeUndefined();
  });
});

describe('TrayManager status label', () => {
  test('shows the followed project and its state', () => {
    const windowManager = makeWindowManager({ state: 'working', character: 'clawd', project: 'proj-a' });
    const tray = new TrayManager(windowManager, makeApp(), { setupStateTimeout: jest.fn() });

    const template = tray.buildMenuTemplate();
    expect(template[0].label).toBe('proj-a: working');
  });

  test('shows a waiting label when no window exists yet', () => {
    const windowManager = makeWindowManager(null);
    const tray = new TrayManager(windowManager, makeApp(), { setupStateTimeout: jest.fn() });

    const template = tray.buildMenuTemplate();
    expect(template[0].label).toBe('Waiting for status');
  });
});

describe('TrayManager character lock submenu', () => {
  test('clicking a character forwards it to the window manager', () => {
    const windowManager = makeWindowManager({ state: 'idle', character: 'clawd', project: 'proj-a' });
    const tray = new TrayManager(windowManager, makeApp(), { setupStateTimeout: jest.fn() });

    const items = tray.buildCharacterLockSubmenu();
    const kiroItem = items.find(i => i.label === 'Kiro');
    kiroItem.click();

    expect(windowManager.setCharacterLock).toHaveBeenCalledWith('kiro');
  });
});

describe('TrayManager always on top submenu', () => {
  test('lists Always / While Active / Never with the current mode checked', () => {
    const windowManager = makeWindowManager({ state: 'idle', character: 'clawd', project: 'proj-a' });
    const tray = new TrayManager(windowManager, makeApp(), { setupStateTimeout: jest.fn() });

    const items = tray.buildAlwaysOnTopSubmenu();

    expect(items.map(i => i.label)).toEqual(['Always', 'While Active', 'Never']);
    expect(items.find(i => i.label === 'While Active').checked).toBe(true);

    items.find(i => i.label === 'Never').click();
    expect(windowManager.setAlwaysOnTopMode).toHaveBeenCalledWith('disabled');
  });
});

describe('TrayManager speech bubble submenu', () => {
  test('clicking a field toggles its current value', () => {
    const windowManager = makeWindowManager({ state: 'idle', character: 'clawd', project: 'proj-a' });
    const tray = new TrayManager(windowManager, makeApp(), { setupStateTimeout: jest.fn() });

    const items = tray.buildSpeechBubbleSubmenu();
    const projectItem = items.find(i => i.label === 'Project');
    projectItem.click();

    expect(windowManager.setSpeechBubbleField).toHaveBeenCalledWith('project', true);
  });
});
