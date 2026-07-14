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
  createCanvas: jest.fn()
}));

const { TrayManager } = require('../src/modules/tray-manager.cjs');

function makeWindowManager(state) {
  return {
    getProjectIds: () => ['proj-a'],
    getState: () => state,
    showWindow: jest.fn(),
    closeWindow: jest.fn(),
    updateState: jest.fn(),
    sendToWindow: jest.fn(),
    updateAlwaysOnTopByState: jest.fn()
  };
}

describe('TrayManager settings menu item', () => {
  function makeFullWindowManager(state) {
    return {
      ...makeWindowManager(state),
      getAppMode: () => 'window',
      getRegisteredStates: () => ({}),
      getCharacterLock: () => 'auto',
      getAlwaysOnTopMode: () => 'active-only',
      getSpeechBubbleFields: () => ({}),
      isMultiMode: () => true,
      setAppMode: jest.fn(),
      arrangeWindowsByName: jest.fn(),
      showAllWindows: jest.fn(),
      closeAllWindows: jest.fn()
    };
  }

  function makeApp() {
    return {
      getVersion: () => '0.0.0',
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings: jest.fn()
    };
  }

  test('shows Settings... that opens the settings window when a manager is set', () => {
    const windowManager = makeFullWindowManager({ state: 'idle', character: 'clawd' });
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
    const windowManager = makeFullWindowManager({ state: 'idle', character: 'clawd' });
    const tray = new TrayManager(windowManager, makeApp(), { setupStateTimeout: jest.fn() });

    const template = tray.buildMenuTemplate();
    expect(template.find(i => i.label === 'Settings...')).toBeUndefined();
  });
});

describe('TrayManager state submenu', () => {
  test('manually changing a project state refreshes its state timeout', () => {
    const state = { state: 'working', character: 'clawd' };
    const windowManager = makeWindowManager(state);
    const stateManager = { setupStateTimeout: jest.fn() };
    const tray = new TrayManager(windowManager, {}, stateManager);

    const items = tray.buildWindowsSubmenu();
    const stateSubmenu = items[0].submenu.find(i => i.label === 'State').submenu;
    const idleItem = stateSubmenu.find(i => i.label === 'idle');

    idleItem.click();

    expect(stateManager.setupStateTimeout).toHaveBeenCalledWith('proj-a', 'idle');
    expect(windowManager.updateState).toHaveBeenCalledWith(
      'proj-a',
      expect.objectContaining({ state: 'idle' })
    );
  });

  test('changing character does not touch the state timeout', () => {
    const state = { state: 'working', character: 'clawd' };
    const windowManager = makeWindowManager(state);
    const stateManager = { setupStateTimeout: jest.fn() };
    const tray = new TrayManager(windowManager, {}, stateManager);

    const items = tray.buildWindowsSubmenu();
    const characterSubmenu = items[0].submenu.find(i => i.label === 'Character').submenu;
    const codexItem = characterSubmenu.find(i => i.label === 'codex');

    codexItem.click();

    expect(stateManager.setupStateTimeout).not.toHaveBeenCalled();
  });
});
