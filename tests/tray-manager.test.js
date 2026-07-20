/**
 * Tests for tray-manager.cjs
 */

jest.mock('electron', () => ({
  Tray: jest.fn(),
  Menu: { buildFromTemplate: jest.fn() },
  nativeImage: { createFromBuffer: jest.fn(() => ({ isNativeImage: true })) },
  BrowserWindow: jest.fn(),
  ipcMain: { on: jest.fn(), handle: jest.fn() },
  shell: {}
}));

jest.mock('canvas', () => ({
  createCanvas: jest.fn(() => ({
    getContext: () => ({
      beginPath: jest.fn(),
      roundRect: jest.fn(),
      fill: jest.fn(),
      fillRect: jest.fn(),
      save: jest.fn(),
      clip: jest.fn(),
      restore: jest.fn()
    }),
    toBuffer: () => Buffer.alloc(0)
  })),
  loadImage: jest.fn(() => Promise.resolve(null))
}));

jest.mock('../src/modules/usage-cache-reader.cjs', () => ({
  getUsageSnapshot: jest.fn(),
  formatResetIn: jest.fn()
}));

const { TrayManager } = require('../src/modules/tray-manager.cjs');
const { getUsageSnapshot, formatResetIn } = require('../src/modules/usage-cache-reader.cjs');

const EMPTY_USAGE_SNAPSHOT = {
  claude: { session: null, week: null },
  codex: { session: null, week: null }
};

beforeEach(() => {
  getUsageSnapshot.mockReset().mockReturnValue(EMPTY_USAGE_SNAPSHOT);
  formatResetIn.mockReset();
});

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

  test('marks Settings... with an attention dot when hook scripts drifted', () => {
    const windowManager = makeWindowManager({ state: 'idle', character: 'clawd', project: 'proj-a' });
    const tray = new TrayManager(windowManager, makeApp(), { setupStateTimeout: jest.fn() });
    const settingsWindowManager = { open: jest.fn() };
    tray.setSettingsWindowManager(settingsWindowManager);
    tray.setHookInstaller({ hasChanges: () => true, getCachedStatuses: () => [] });

    const template = tray.buildMenuTemplate();
    const settingsItem = template.find(i => i.label === 'Settings... ●');

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

describe('TrayManager usage menu', () => {
  function makeTray() {
    const windowManager = makeWindowManager({ state: 'idle', character: 'clawd', project: 'proj-a' });
    return new TrayManager(windowManager, makeApp(), { setupStateTimeout: jest.fn() });
  }

  test('groups fresh buckets under a provider header, each row with a bar icon', () => {
    getUsageSnapshot.mockReturnValue({
      claude: { session: { pct: 32, resetsAt: 5000 }, week: { pct: 67, resetsAt: 900000 } },
      codex: { session: null, week: null }
    });
    formatResetIn.mockImplementation((resetsAt) => (resetsAt === 5000 ? '3h18m' : '3d21h'));

    const items = makeTray().buildUsageMenuItems();

    expect(items.map(i => i.label)).toEqual([
      'Claude',
      '⏱️ 5h  32% · 3h18m',
      '📅 Week  67% · 3d21h'
    ]);
    expect(items.every(i => i.enabled === false)).toBe(true);
    expect(items[0].icon).toBeUndefined();
    expect(items[1].icon).toEqual({ isNativeImage: true });
    expect(items[2].icon).toEqual({ isNativeImage: true });
  });

  test('shows both providers as separate groups when both have fresh data', () => {
    getUsageSnapshot.mockReturnValue({
      claude: { session: { pct: 0, resetsAt: null }, week: null },
      codex: { session: null, week: { pct: 100, resetsAt: null } }
    });

    const items = makeTray().buildUsageMenuItems();

    expect(items.map(i => i.label)).toEqual([
      'Claude',
      '⏱️ 5h  0%',
      'Codex',
      '📅 Week  100%'
    ]);
  });

  test('shows the model-scoped weekly row labeled, without a reset suffix', () => {
    getUsageSnapshot.mockReturnValue({
      claude: {
        session: { pct: 7, resetsAt: null },
        week: { pct: 7, resetsAt: 900000 },
        modelWeek: { pct: 12, resetsAt: 900000, label: 'Fable' }
      },
      codex: { session: null, week: null, modelWeek: null }
    });
    formatResetIn.mockReturnValue('4d11h');

    const items = makeTray().buildUsageMenuItems();

    // The model row omits the reset time even though resetsAt is present —
    // its window resets together with the Week row.
    expect(items.map(i => i.label)).toEqual([
      'Claude',
      '⏱️ 5h  7%',
      '📅 Week  7% · 4d11h',
      '🎯 Fable  12%'
    ]);
    expect(items[3].icon).toEqual({ isNativeImage: true });
  });

  test('omits the reset suffix when resetsAt is unavailable', () => {
    getUsageSnapshot.mockReturnValue({
      claude: { session: { pct: 32, resetsAt: null }, week: null },
      codex: { session: null, week: null }
    });

    const items = makeTray().buildUsageMenuItems();

    expect(items.map(i => i.label)).toEqual(['Claude', '⏱️ 5h  32%']);
  });

  test('returns no rows when no fresh data is available', () => {
    getUsageSnapshot.mockReturnValue(EMPTY_USAGE_SNAPSHOT);

    expect(makeTray().buildUsageMenuItems()).toEqual([]);
  });

  test('omits the usage section (and its separator) from the menu when there is no data', () => {
    getUsageSnapshot.mockReturnValue(EMPTY_USAGE_SNAPSHOT);

    const template = makeTray().buildMenuTemplate();
    const hooksIndex = template.findIndex(i => i.label === 'AI Tool Hooks');

    expect(hooksIndex).toBeGreaterThan(-1);
    expect(template[hooksIndex + 1]).toEqual({ type: 'separator' });
    expect(template[hooksIndex + 2].type).not.toBe('separator');
    expect(template.find(i => i.label === 'Claude')).toBeUndefined();
  });

  test('inserts usage rows right below AI Tool Hooks', () => {
    getUsageSnapshot.mockReturnValue({
      claude: { session: { pct: 32, resetsAt: 5000 }, week: null },
      codex: { session: null, week: null }
    });
    formatResetIn.mockReturnValue('3h18m');

    const template = makeTray().buildMenuTemplate();
    const hooksIndex = template.findIndex(i => i.label === 'AI Tool Hooks');

    expect(template[hooksIndex + 1]).toEqual({ type: 'separator' });
    expect(template[hooksIndex + 2]).toEqual({ label: 'Claude', enabled: false });
    expect(template[hooksIndex + 3].label).toBe('⏱️ 5h  32% · 3h18m');
    expect(template[hooksIndex + 4]).toEqual({ type: 'separator' });
  });
});
