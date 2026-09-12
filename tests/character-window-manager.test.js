jest.mock('../src/modules/window-pointer.cjs', () => ({ trackWindowPointer: jest.fn() }));

describe('Dock corner geometry', () => {
  let manager;
  let monitor;
  let window;
  let bounds;
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 30, width: 1440, height: 814 } };
  const { screen } = require('electron');

  beforeEach(() => {
    jest.useFakeTimers();
    screen.getAllDisplays.mockReturnValue([display]);
    screen.getDisplayMatching.mockReturnValue(display);
    monitor = { bounds: [{ x: 400, y: 844, width: 640, height: 52 }], refresh: jest.fn(() => Promise.resolve()) };
    manager = new CharacterWindowManager({ dockMonitor: monitor });
    manager.setDockAutoScale(true);
    const { EventEmitter } = require('events');
    window = new EventEmitter();
    bounds = { x: 0, y: 706, width: 134, height: 138 };
    Object.assign(window, {
      getBounds: () => ({ ...bounds }),
      getPosition: () => [bounds.x, bounds.y],
      setBounds: jest.fn(value => { bounds = { ...value }; }),
      setResizable: jest.fn(),
      isDestroyed: () => false,
      webContents: { send: jest.fn(), isDestroyed: () => false }
    });
    manager.entry = { window, projectId: 'dock', state: null };
    manager.onWindowMoved = jest.fn();
  });
  afterEach(() => {
    manager.cleanup();
    jest.useRealTimers();
    screen.getAllDisplays.mockReturnValue([{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]);
    screen.getDisplayMatching.mockReturnValue({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
  });

  test('snaps after release and keeps the configured size separate from the fitted scale', () => {
    manager.handleWindowMove();
    jest.advanceTimersByTime(150);
    expect(bounds.y + bounds.height).toBe(900);
    expect(bounds.x).toBe(0);
    expect(manager.getCharacterScale()).toBe(100);
    expect(manager.getDisplayOptions().characterScale).toBeLessThan(100);
    expect(manager.windowPosition).toEqual({ x: bounds.x, y: bounds.y });
    manager.setBubbleSize({ width: 220, height: 185 });
    expect(manager.dockLayout.bubble.y + manager.dockLayout.bubble.height).toBe(900);
    expect(bounds.width).toBeLessThan(50);
  });

  test('refits on content and settings changes without overwriting the preferred scale', () => {
    manager.refreshDockLayout();
    manager.setBubbleSize({ width: 220, height: 185 });
    manager.setCharacterScale(80);
    manager.setEdgeMargin(8);
    expect(manager.getCharacterScale()).toBe(80);
    expect(manager.store.get('characterScale')).toBe(80);
    expect(bounds.x).toBe(8);
    expect(bounds.y + bounds.height).toBe(892);
    manager.setBubbleSize(null);
    expect(manager.dockLayout.bubble).toBeNull();
  });

  test('restores both the window and renderer scale when dragged away', () => {
    manager.refreshDockLayout();
    screen.getCursorScreenPoint.mockReturnValue({ x: 20, y: 870 });
    manager.beginUserDrag();
    expect(manager.dockLayout).not.toBeNull();
    screen.getCursorScreenPoint.mockReturnValue({ x: 400, y: 400 });
    manager.moveUserDrag();
    expect(manager.dockLayout).toBeNull();
    expect(bounds.width).toBe(134);
    expect(bounds.height).toBe(138);
    expect(manager.getDisplayOptions().characterScale).toBe(100);
    manager.endUserDrag();
    jest.advanceTimersByTime(150);
    expect(manager.dockLayout).toBeNull();
  });

  test('losing or hiding the Dock returns the character to the work area', () => {
    manager.refreshDockLayout();
    monitor.bounds = [];
    manager.refreshDockLayout();
    expect(manager.dockLayout).toBeNull();
    expect(bounds).toMatchObject({ x: 0, y: 706, width: 134, height: 138 });
  });

  test('ignores monitor updates while dragging or position tracking is suspended', () => {
    manager.dragOrigin = { winX: 0, winY: 706, cursorX: 20, cursorY: 800 };
    manager.refreshDockLayout();
    expect(manager.dockLayout).toBeNull();
    manager.clearUserDrag();
    manager.suspendPositionTracking();
    manager.refreshDockLayout();
    expect(manager.dockLayout).toBeNull();
  });

  test('restores a Dock position after macOS moves the window during sleep', () => {
    manager.refreshDockLayout();
    const saved = { ...bounds };
    manager.suspendPositionTracking();
    bounds = { x: 200, y: 200, width: saved.width, height: saved.height };
    manager.restoreWindowPosition();
    jest.advanceTimersByTime(1000);
    expect(bounds).toEqual(saved);
  });

  test('does not mistake a saved small right-corner window for the next monitor', () => {
    const adjacent = { id: 2, bounds: { x: 1440, y: 0, width: 1440, height: 900 }, workArea: { x: 1440, y: 0, width: 1440, height: 900 } };
    screen.getAllDisplays.mockReturnValue([display, adjacent]);
    screen.getDisplayMatching.mockReturnValue(adjacent);
    const layout = manager.layoutForBounds({ x: 1400, y: 860, width: 134, height: 138 });
    expect(layout.displayId).toBe(1);
    expect(layout.character.x + layout.character.width).toBe(1440);
  });

  test('switching to keep size restores both overlays while keeping the physical corner', () => {
    manager.setBubbleSize({ width: 280, height: 185 });
    expect(manager.dockLayout.scale).toBeLessThan(1);
    manager.setDockAutoScale(false);
    expect(manager.store.get('dockAutoScale')).toBe(false);
    expect(bounds).toEqual({ x: 0, y: 762, width: 134, height: 138 });
    expect(manager.dockLayout.bubble).toMatchObject({ width: 280, height: 185 });
    expect(manager.dockLayout.bubble.y + manager.dockLayout.bubble.height).toBeLessThan(bounds.y);
    expect(manager.getDisplayOptions().characterScale).toBe(100);
    manager.setDockAutoScale(true);
    expect(manager.store.get('dockAutoScale')).toBe(true);
    expect(manager.dockLayout.scale).toBeLessThan(1);
    expect(bounds.y + bounds.height).toBe(900);
  });
});

/**
 * Tests for character-window-manager.cjs
 * Scoped to plain state/bookkeeping logic that doesn't require real windows.
 */

jest.mock('electron', () => ({
  BrowserWindow: jest.fn(),
  screen: {
    getDisplayMatching: jest.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
    getAllDisplays: jest.fn(() => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]),
    getPrimaryDisplay: jest.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
    getCursorScreenPoint: jest.fn(() => ({ x: 0, y: 0 }))
  }
}));

jest.mock('electron-store', () => {
  let presetData = null;
  const MockStore = jest.fn().mockImplementation(function mockStore(opts) {
    const data = { ...(opts && opts.defaults), ...(presetData || {}) };
    presetData = null;
    this.get = (key) => data[key];
    this.set = (key, value) => { data[key] = value; };
  });
  // Lets a test seed keys (e.g. the legacy windowPositions map) that exist
  // on disk before the next `new Store(...)` call, without touching the
  // `defaults` CharacterWindowManager itself passes in.
  MockStore.__presetNextStore = (preset) => { presetData = preset; };
  return MockStore;
});

const { CharacterWindowManager } = require('../src/modules/character-window-manager.cjs');
const { MAX_STATE_REGISTRY_SIZE, FOCUS_HYSTERESIS_MS } = require('../src/shared/config.cjs');
const Store = require('electron-store');

describe('taskbar visibility', () => {
  test.each(['win32', 'darwin', 'linux'])('window creation on %s', (platform) => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const { BrowserWindow } = require('electron');
    const window = {
      setBounds: jest.fn(),
      webContents: {},
      setIgnoreMouseEvents: jest.fn(),
      loadFile: jest.fn(),
      setVisibleOnAllWorkspaces: jest.fn(),
      once: jest.fn(),
      on: jest.fn()
    };
    BrowserWindow.mockImplementationOnce(() => window);

    try {
      Object.defineProperty(process, 'platform', { value: platform });
      const manager = new CharacterWindowManager();
      manager.ensureWindow('test');

      expect(BrowserWindow).toHaveBeenLastCalledWith(expect.objectContaining({
        skipTaskbar: platform === 'win32',
        enableLargerThanScreen: platform === 'darwin'
      }));
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });
});

describe('default settings', () => {
  test.each([undefined, false, 'true', 1, null])('Dock auto scaling is off for missing or invalid stored values: %s', value => {
    Store.__presetNextStore(value === undefined ? {} : { dockAutoScale: value });
    expect(new CharacterWindowManager().getDockAutoScale()).toBe(false);
  });

  test('restores an explicitly enabled Dock auto scale setting and rejects invalid changes', () => {
    Store.__presetNextStore({ dockAutoScale: true });
    const manager = new CharacterWindowManager();
    expect(manager.getDockAutoScale()).toBe(true);
    manager.setDockAutoScale('false');
    expect(manager.getDockAutoScale()).toBe(true);
    manager.setDockAutoScale(false);
    expect(manager.store.get('dockAutoScale')).toBe(false);
  });
  test('a fresh install defaults to all always-on-top, auto character lock, no saved position', () => {
    const manager = new CharacterWindowManager();

    expect(manager.getAlwaysOnTopMode()).toBe('all');
    expect(manager.getCharacterLock()).toBe('auto');
    expect(manager.windowPosition).toBeNull();
  });

  test('a stored character lock naming an unknown character falls back to auto', () => {
    Store.__presetNextStore({ characterLock: 'removed-character' });
    const manager = new CharacterWindowManager();

    expect(manager.getCharacterLock()).toBe('auto');
  });

  test('a stored character lock naming a registry character is kept', () => {
    Store.__presetNextStore({ characterLock: 'clawd' });
    const manager = new CharacterWindowManager();

    expect(manager.getCharacterLock()).toBe('clawd');
  });

  test('render mode defaults to 2d and only accepts 2d/3d', () => {
    const manager = new CharacterWindowManager();

    expect(manager.getRenderMode()).toBe('2d');
    manager.setRenderMode('3d');
    expect(manager.getRenderMode()).toBe('3d');
    manager.setRenderMode('nope');
    expect(manager.getRenderMode()).toBe('3d');
  });

  test('a stored render mode with an unknown value falls back to 2d', () => {
    Store.__presetNextStore({ renderMode: 'weird' });
    const manager = new CharacterWindowManager();

    expect(manager.getRenderMode()).toBe('2d');
  });

  test('character size, edge margin and dev mode default to the previous behaviour', () => {
    const manager = new CharacterWindowManager();

    expect(manager.getCharacterScale()).toBe(100);
    expect(manager.getEdgeMargin()).toBe(0);
    expect(manager.getDevMode()).toBe(false);
    expect(manager.getDisplayOptions()).toEqual({ characterScale: 100, devMode: false });
  });

  test('stored character size and edge margin outside the offered lists fall back', () => {
    Store.__presetNextStore({ characterScale: 25, edgeMargin: 999 });
    const manager = new CharacterWindowManager();

    expect(manager.getCharacterScale()).toBe(100);
    expect(manager.getEdgeMargin()).toBe(0);
  });

  test('character size and edge margin setters reject values outside the offered lists', () => {
    const manager = new CharacterWindowManager();

    manager.setCharacterScale(50);
    manager.setEdgeMargin(16);
    expect(manager.getCharacterScale()).toBe(50);
    expect(manager.getEdgeMargin()).toBe(16);

    manager.setCharacterScale(25);
    manager.setEdgeMargin(999);
    expect(manager.getCharacterScale()).toBe(50);
    expect(manager.getEdgeMargin()).toBe(16);
  });

  test('migrates the legacy per-key window position map', () => {
    Store.__presetNextStore({ windowPositions: { __character__: { x: 11, y: 22 } } });
    const manager = new CharacterWindowManager();

    expect(manager.windowPosition).toEqual({ x: 11, y: 22 });
  });

  test('speech bubble fields missing from a persisted store default to enabled', () => {
    Store.__presetNextStore({ speechBubbleFields: { status: false } });
    const manager = new CharacterWindowManager();

    const fields = manager.getSpeechBubbleFields();
    expect(fields.status).toBe(false);
    expect(fields.project).toBe(true);
    expect(fields.usageWeek).toBe(true);
  });
});

describe('pruneStateRegistry', () => {
  test('evicts least-recently-updated entries beyond the cap, skipping the followed project', () => {
    const manager = new CharacterWindowManager();

    for (let i = 0; i < MAX_STATE_REGISTRY_SIZE + 5; i++) {
      manager.stateRegistry.set(`proj-${i}`, { state: 'idle' });
    }
    // proj-0 is the oldest entry but the window follows it, so it must survive.
    manager.entry = { window: {}, state: { state: 'idle' }, projectId: 'proj-0' };

    manager.pruneStateRegistry();

    expect(manager.stateRegistry.size).toBe(MAX_STATE_REGISTRY_SIZE);
    expect(manager.stateRegistry.has('proj-0')).toBe(true);
    expect(manager.stateRegistry.has('proj-1')).toBe(false);
  });

  test('does not evict below the cap', () => {
    const manager = new CharacterWindowManager();
    manager.stateRegistry.set('proj-a', { state: 'idle' });

    manager.pruneStateRegistry();

    expect(manager.stateRegistry.size).toBe(1);
  });
});

describe('selectFocus', () => {
  let now;

  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    Date.now.mockRestore();
  });

  test('an active project takes focus immediately when nothing is focused yet', () => {
    const manager = new CharacterWindowManager();
    manager.stateRegistry.set('a', { state: 'working' });

    expect(manager.selectFocus('a', 'working')).toBe('a');
  });

  test('a different active project cannot steal focus within the hysteresis window', () => {
    const manager = new CharacterWindowManager();
    manager.stateRegistry.set('a', { state: 'working' });
    manager.selectFocus('a', 'working');

    now += FOCUS_HYSTERESIS_MS - 1;
    manager.stateRegistry.set('b', { state: 'thinking' });

    expect(manager.selectFocus('b', 'thinking')).toBe('a');
  });

  test('a still-active focused project keeps focus even after the hysteresis window', () => {
    const manager = new CharacterWindowManager();
    manager.stateRegistry.set('a', { state: 'working' });
    manager.selectFocus('a', 'working');

    now += FOCUS_HYSTERESIS_MS;
    manager.stateRegistry.set('b', { state: 'thinking' });

    expect(manager.selectFocus('b', 'thinking')).toBe('a');
  });

  test('a momentary done between tools does not let another project steal focus', () => {
    const manager = new CharacterWindowManager();
    manager.stateRegistry.set('a', { state: 'working' });
    manager.selectFocus('a', 'working');

    now += 500;
    manager.stateRegistry.set('a', { state: 'done' });
    manager.selectFocus('a', 'done');

    now += 200;
    manager.stateRegistry.set('b', { state: 'working' });

    expect(manager.selectFocus('b', 'working')).toBe('a');
  });

  test('an active project takes focus once the focused one has settled past the window', () => {
    const manager = new CharacterWindowManager();
    manager.stateRegistry.set('a', { state: 'working' });
    manager.selectFocus('a', 'working');

    now += 500;
    manager.stateRegistry.set('a', { state: 'done' });
    manager.selectFocus('a', 'done');

    now += FOCUS_HYSTERESIS_MS;
    manager.stateRegistry.set('b', { state: 'working' });

    expect(manager.selectFocus('b', 'working')).toBe('b');
  });

  test('an alert bypasses the hysteresis window and takes focus immediately', () => {
    const manager = new CharacterWindowManager();
    manager.stateRegistry.set('a', { state: 'working' });
    manager.selectFocus('a', 'working');

    now += 1;
    manager.stateRegistry.set('b', { state: 'alert' });

    expect(manager.selectFocus('b', 'alert')).toBe('b');
  });

  test('a non-active project does not steal focus from a still-active one', () => {
    const manager = new CharacterWindowManager();
    manager.stateRegistry.set('a', { state: 'working' });
    manager.selectFocus('a', 'working');

    now += FOCUS_HYSTERESIS_MS;
    manager.stateRegistry.set('b', { state: 'idle' });

    expect(manager.selectFocus('b', 'idle')).toBe('a');
  });

  test('a non-active project takes focus from a no-longer-active one', () => {
    const manager = new CharacterWindowManager();
    manager.stateRegistry.set('a', { state: 'done' });
    manager.selectFocus('a', 'done');

    now += 1;
    manager.stateRegistry.set('b', { state: 'idle' });

    expect(manager.selectFocus('b', 'idle')).toBe('b');
  });
});

describe('routeStatusUpdate', () => {
  function stubWindow(manager, projectId) {
    manager.entry = {
      window: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: jest.fn() } },
      state: null,
      projectId
    };
  }

  test('records state for an unfocused project without touching the window', () => {
    const manager = new CharacterWindowManager();
    stubWindow(manager, 'a');
    manager.stateRegistry.set('a', { state: 'working' });
    manager.selectFocus('a', 'working');

    const result = manager.routeStatusUpdate('b', { state: 'thinking', project: 'b' });

    expect(result.updateResult.updated).toBe(false);
    expect(manager.getRegisteredState('b')).toEqual({ state: 'thinking', project: 'b' });
    expect(manager.entry.projectId).toBe('a');
  });

  test('drops the internal .vibemon project (usage-refresh session) at ingestion', () => {
    const manager = new CharacterWindowManager();
    stubWindow(manager, 'a');
    manager.stateRegistry.set('a', { state: 'idle' });
    manager.focusedProjectId = 'a';

    const result = manager.routeStatusUpdate('.vibemon', { state: 'working', project: '.vibemon' });

    expect(result.switchedProject).toBeNull();
    expect(result.updateResult.updated).toBe(false);
    expect(manager.getRegisteredState('.vibemon')).toBeFalsy();
    expect(manager.stateRegistry.has('.vibemon')).toBe(false);
    expect(manager.getFocusedProjectId()).toBe('a');
    expect(manager.entry.projectId).toBe('a');
  });

  test('retargets the window when focus moves to another project', () => {
    jest.spyOn(Date, 'now').mockImplementation(() => 1_000_000);
    const manager = new CharacterWindowManager();
    stubWindow(manager, 'a');
    manager.routeStatusUpdate('a', { state: 'done', project: 'a' });

    Date.now.mockImplementation(() => 1_000_000 + FOCUS_HYSTERESIS_MS + 1);
    const result = manager.routeStatusUpdate('b', { state: 'working', project: 'b' });
    Date.now.mockRestore();

    expect(result.switchedProject).toBe('a');
    expect(manager.entry.projectId).toBe('b');
    expect(result.updateResult.updated).toBe(true);
  });

  test('a background state timeout records state without moving focus', () => {
    const manager = new CharacterWindowManager();
    stubWindow(manager, 'a');
    manager.stateRegistry.set('a', { state: 'idle' });
    manager.focusedProjectId = 'a';
    manager.stateRegistry.set('b', { state: 'idle', project: 'b' });

    const result = manager.routeStatusUpdate('b', { state: 'sleep', project: 'b' }, { preserveFocus: true });

    expect(manager.getFocusedProjectId()).toBe('a');
    expect(manager.entry.projectId).toBe('a');
    expect(result.updateResult.updated).toBe(false);
    expect(manager.getRegisteredState('b').state).toBe('sleep');
  });

  test('character lock overrides the incoming character everywhere downstream', () => {
    const manager = new CharacterWindowManager();
    stubWindow(manager, 'a');
    manager.setCharacterLock('kiro');

    const result = manager.routeStatusUpdate('a', { state: 'working', project: 'a', character: 'clawd' });

    expect(result.stateData.character).toBe('kiro');
    expect(manager.getRegisteredState('a').character).toBe('kiro');
    expect(manager.getState('a').character).toBe('kiro');
  });
});

describe('removeProject', () => {
  test('removes registry state and clears focus for the removed project', () => {
    const manager = new CharacterWindowManager();
    manager.stateRegistry.set('a', { state: 'working' });
    manager.focusedProjectId = 'a';

    expect(manager.removeProject('a')).toBe(true);
    expect(manager.getRegisteredState('a')).toBeNull();
    expect(manager.getFocusedProjectId()).toBeNull();
  });

  test('keeps focus when removing a background project', () => {
    const manager = new CharacterWindowManager();
    manager.stateRegistry.set('a', { state: 'working' });
    manager.stateRegistry.set('b', { state: 'idle' });
    manager.focusedProjectId = 'a';

    manager.removeProject('b');

    expect(manager.getFocusedProjectId()).toBe('a');
  });
});

describe('restoreLastWindow', () => {
  function makeMockWindow() {
    return {
      setBounds: jest.fn(),
      isDestroyed: () => false,
      setIgnoreMouseEvents: jest.fn(),
      setWindowOpenHandler: jest.fn(),
      loadFile: jest.fn(),
      setVisibleOnAllWorkspaces: jest.fn(),
      showInactive: jest.fn(),
      setAlwaysOnTop: jest.fn(),
      once: jest.fn(),
      on: jest.fn(),
      webContents: { isDestroyed: () => false, once: jest.fn(), on: jest.fn(), send: jest.fn() }
    };
  }

  test('recreates the closed window from the last displayed state', () => {
    const manager = new CharacterWindowManager();
    manager.lastWindowState = { state: 'sleep', character: 'clawd', project: 'proj-a' };
    manager.onStateUpdated = jest.fn();
    const { BrowserWindow } = require('electron');
    BrowserWindow.mockImplementationOnce(() => makeMockWindow());

    const result = manager.restoreLastWindow();

    expect(result.recreated).toBe(true);
    expect(result.projectId).toBe('proj-a');
    expect(result.stateData).toEqual({ state: 'sleep', character: 'clawd', project: 'proj-a' });
    // The recreated window follows the remembered project, its state is
    // re-recorded, and the speech bubble is refreshed via onStateUpdated.
    expect(manager.getFocusedProjectId()).toBe('proj-a');
    expect(manager.getRegisteredState('proj-a')).toEqual(result.stateData);
    expect(manager.getState('proj-a')).toEqual(result.stateData);
    expect(manager.onStateUpdated).toHaveBeenCalledWith('proj-a');
  });

  test('falls back to a default idle character when nothing was shown yet', () => {
    const manager = new CharacterWindowManager();
    const { BrowserWindow } = require('electron');
    BrowserWindow.mockImplementationOnce(() => makeMockWindow());

    const result = manager.restoreLastWindow();

    expect(result.recreated).toBe(true);
    expect(result.stateData).toEqual({ state: 'idle', character: 'vibemon', project: null });
    expect(result.projectId).toBeNull();
  });

  test('the fallback honours the character lock', () => {
    const manager = new CharacterWindowManager();
    manager.setCharacterLock('kiro');
    const { BrowserWindow } = require('electron');
    BrowserWindow.mockImplementationOnce(() => makeMockWindow());

    const result = manager.restoreLastWindow();

    expect(result.stateData.character).toBe('kiro');
  });

  test('an open window is merely shown, not recreated', () => {
    const manager = new CharacterWindowManager();
    const window = { isDestroyed: () => false, showInactive: jest.fn() };
    manager.entry = { window, state: { state: 'working', project: 'proj-b' }, projectId: 'proj-b' };

    const result = manager.restoreLastWindow();

    expect(result.recreated).toBe(false);
    expect(result.projectId).toBe('proj-b');
    expect(result.stateData).toEqual({ state: 'working', project: 'proj-b' });
    expect(window.showInactive).toHaveBeenCalled();
  });
});

describe('updateState change detection', () => {
  function managerWithWindow(projectId, state) {
    const manager = new CharacterWindowManager();
    manager.entry = { window: {}, state, projectId };
    return manager;
  }

  test('detects a state change', () => {
    const manager = managerWithWindow('a', { state: 'idle' });
    expect(manager.updateState('a', { state: 'working' })).toEqual({ updated: true, stateChanged: true, infoChanged: false });
  });

  test('detects an info-only change', () => {
    const manager = managerWithWindow('a', { state: 'working', memory: 10 });
    expect(manager.updateState('a', { state: 'working', memory: 20 })).toEqual({ updated: true, stateChanged: false, infoChanged: true });
  });

  test('skips identical updates', () => {
    const manager = managerWithWindow('a', { state: 'working', memory: 10 });
    expect(manager.updateState('a', { state: 'working', memory: 10 }).updated).toBe(false);
  });

  test('keeps last known terminalId when an update omits it (cloud WS echo)', () => {
    const manager = managerWithWindow('a', null);
    manager.routeStatusUpdate('a', { state: 'working', project: 'a', terminalId: 'ghostty:100' });
    manager.routeStatusUpdate('a', { state: 'working', project: 'a' });
    expect(manager.getRegisteredState('a').terminalId).toBe('ghostty:100');
    expect(manager.getTerminalId('a')).toBe('ghostty:100');
  });

  test('detects a terminalId-only change (keeps click-to-focus current)', () => {
    const manager = managerWithWindow('a', { state: 'working', terminalId: 'ghostty:100' });
    const result = manager.updateState('a', { state: 'working', terminalId: 'ghostty:200' });
    expect(result).toEqual({ updated: true, stateChanged: false, infoChanged: true });
    expect(manager.entry.state.terminalId).toBe('ghostty:200');
  });

  test('ignores updates for a project the window does not follow', () => {
    const manager = managerWithWindow('a', { state: 'idle' });
    expect(manager.updateState('b', { state: 'working' }).updated).toBe(false);
  });
});

describe('shouldBeAlwaysOnTop', () => {
  test('all mode keeps every state on top', () => {
    const manager = new CharacterWindowManager();
    manager.alwaysOnTopMode = 'all';
    expect(manager.shouldBeAlwaysOnTop('sleep')).toBe(true);
  });

  test('active-only mode keeps only active states on top', () => {
    const manager = new CharacterWindowManager();
    manager.alwaysOnTopMode = 'active-only';
    expect(manager.shouldBeAlwaysOnTop('working')).toBe(true);
    expect(manager.shouldBeAlwaysOnTop('idle')).toBe(false);
    expect(manager.shouldBeAlwaysOnTop(null)).toBe(false);
  });

  test('disabled mode never keeps the window on top', () => {
    const manager = new CharacterWindowManager();
    manager.alwaysOnTopMode = 'disabled';
    expect(manager.shouldBeAlwaysOnTop('working')).toBe(false);
  });
});

describe('window geometry (character size + edge margin)', () => {
  const { WINDOW_WIDTH, SNAP_DEBOUNCE_MS } = require('../src/shared/config.cjs');
  const { screen } = require('electron');
  const WORK_AREA_WIDTH = 1920;
  const WORK_AREA_HEIGHT = 1080;
  // Matches CHAR_Y_BASE + CHAR_SIZE + 5 in character-window-manager.cjs
  const WINDOW_HEIGHT = 138;

  beforeEach(() => {
    screen.getDisplayMatching.mockImplementation(() => ({
      workArea: { x: 0, y: 0, width: WORK_AREA_WIDTH, height: WORK_AREA_HEIGHT }
    }));
  });

  test('the window size scales with the character size setting', () => {
    const manager = new CharacterWindowManager();
    expect(manager.windowSize()).toEqual({ width: WINDOW_WIDTH, height: WINDOW_HEIGHT });

    manager.setCharacterScale(50);
    expect(manager.windowSize()).toEqual({ width: WINDOW_WIDTH / 2, height: WINDOW_HEIGHT / 2 });
  });

  test('the default position keeps the edge margin from the top-right corner', () => {
    const manager = new CharacterWindowManager();
    expect(manager.defaultPosition()).toEqual({ x: WORK_AREA_WIDTH - WINDOW_WIDTH, y: 0 });

    manager.setEdgeMargin(16);
    expect(manager.defaultPosition()).toEqual({ x: WORK_AREA_WIDTH - 16 - WINDOW_WIDTH, y: 16 });
  });

  test('a smaller character spawns closer to the corner it is anchored at', () => {
    const manager = new CharacterWindowManager();
    manager.setCharacterScale(50);

    expect(manager.defaultPosition()).toEqual({ x: WORK_AREA_WIDTH - WINDOW_WIDTH / 2, y: 0 });
  });

  test('clamping keeps the window inside the work area inset by the edge margin', () => {
    const manager = new CharacterWindowManager();
    manager.setEdgeMargin(16);

    expect(manager.clampPositionToScreen({ x: -50, y: -50 })).toEqual({ x: 16, y: 16 });
    expect(manager.clampPositionToScreen({ x: 5000, y: 5000 })).toEqual({
      x: WORK_AREA_WIDTH - 16 - WINDOW_WIDTH,
      y: WORK_AREA_HEIGHT - 16 - WINDOW_HEIGHT
    });
  });

  test('an edge margin with no room for the window falls back to the bare work area', () => {
    const manager = new CharacterWindowManager();
    manager.setEdgeMargin(32);
    screen.getDisplayMatching.mockImplementation(() => ({
      workArea: { x: 0, y: 0, width: 200, height: 200 }
    }));

    expect(manager.clampPositionToScreen({ x: -50, y: -50 })).toEqual({ x: 0, y: 0 });
  });

  test('a settled drag snaps flush to the margin, not to the screen edge', () => {
    jest.useFakeTimers();
    try {
      const manager = new CharacterWindowManager();
      manager.setEdgeMargin(16);

      const window = {
        getBounds: jest.fn(() => ({ x: 2, y: 3, width: WINDOW_WIDTH, height: WINDOW_HEIGHT })),
        getPosition: jest.fn(() => [2, 3]),
        setBounds: jest.fn(),
        isDestroyed: () => false
      };
      manager.entry = { window, state: null, projectId: 'a' };

      manager.handleWindowMove();
      jest.advanceTimersByTime(SNAP_DEBOUNCE_MS);

      expect(window.setBounds).toHaveBeenCalledWith({ x: 16, y: 16, ...manager.windowSize() });
      expect(manager.windowPosition).toEqual({ x: 16, y: 16 });
    } finally {
      jest.useRealTimers();
    }
  });

  function makeGeometryWindow(bounds) {
    return {
      getPosition: jest.fn(() => [bounds.x, bounds.y]),
      getBounds: jest.fn(() => ({ ...bounds })),
      setResizable: jest.fn(),
      setBounds: jest.fn(),
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: jest.fn() }
    };
  }

  test('resizing keeps a corner-parked character in its corner', () => {
    const manager = new CharacterWindowManager();
    const window = makeGeometryWindow({ x: WORK_AREA_WIDTH - WINDOW_WIDTH, y: 0, width: WINDOW_WIDTH, height: WINDOW_HEIGHT });
    manager.entry = { window, state: null, projectId: 'a' };
    manager.onWindowMoved = jest.fn();

    manager.setCharacterScale(50);

    expect(window.setBounds).toHaveBeenCalledWith({
      x: WORK_AREA_WIDTH - WINDOW_WIDTH / 2,
      y: 0,
      width: WINDOW_WIDTH / 2,
      height: WINDOW_HEIGHT / 2
    });
    // Programmatic resizes need the window temporarily resizable
    expect(window.setResizable).toHaveBeenNthCalledWith(1, true);
    expect(window.setResizable).toHaveBeenNthCalledWith(2, false);
    // A resize fires no 'move' event, so the bubble is told to follow
    expect(manager.onWindowMoved).toHaveBeenCalledWith('a');
    expect(window.webContents.send).toHaveBeenCalledWith('display-options', { characterScale: 50, devMode: false });
  });

  test('resizing leaves a character parked away from every edge where it is', () => {
    const manager = new CharacterWindowManager();
    const window = makeGeometryWindow({ x: 600, y: 400, width: WINDOW_WIDTH, height: WINDOW_HEIGHT });
    manager.entry = { window, state: null, projectId: 'a' };

    manager.setCharacterScale(50);

    expect(window.setBounds).toHaveBeenCalledWith(expect.objectContaining({ x: 600, y: 400 }));
  });

  test('lowering the edge margin brings a pinned window back out to the edge', () => {
    const manager = new CharacterWindowManager();
    manager.setEdgeMargin(32);
    // Where a 32px margin pins the window in the top-right corner
    const window = makeGeometryWindow({ x: WORK_AREA_WIDTH - 32 - WINDOW_WIDTH, y: 32, width: WINDOW_WIDTH, height: WINDOW_HEIGHT });
    manager.entry = { window, state: null, projectId: 'a' };

    manager.setEdgeMargin(0);

    expect(window.setBounds).toHaveBeenCalledWith({
      x: WORK_AREA_WIDTH - WINDOW_WIDTH,
      y: 0,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT
    });
    expect(manager.windowPosition).toEqual({ x: WORK_AREA_WIDTH - WINDOW_WIDTH, y: 0 });
  });

  test('raising the edge margin pushes a flush window inward', () => {
    const manager = new CharacterWindowManager();
    const window = makeGeometryWindow({ x: WORK_AREA_WIDTH - WINDOW_WIDTH, y: 0, width: WINDOW_WIDTH, height: WINDOW_HEIGHT });
    manager.entry = { window, state: null, projectId: 'a' };

    manager.setEdgeMargin(16);

    expect(window.setBounds).toHaveBeenCalledWith(expect.objectContaining({
      x: WORK_AREA_WIDTH - 16 - WINDOW_WIDTH,
      y: 16
    }));
  });

  test('the saved spawn position follows the margin even with no window open', () => {
    const manager = new CharacterWindowManager();
    manager.setEdgeMargin(32);
    manager.saveWindowPosition({ x: WORK_AREA_WIDTH - 32 - WINDOW_WIDTH, y: 32 });

    manager.setEdgeMargin(0);

    expect(manager.windowPosition).toEqual({ x: WORK_AREA_WIDTH - WINDOW_WIDTH, y: 0 });
  });

  test('dev mode pushes the new display options to the open window', () => {
    const manager = new CharacterWindowManager();
    const window = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: jest.fn() }
    };
    manager.entry = { window, state: null, projectId: 'a' };

    manager.setDevMode(true);

    expect(manager.getDevMode()).toBe(true);
    expect(window.webContents.send).toHaveBeenCalledWith('display-options', { characterScale: 100, devMode: true });
  });
});

describe('position tracking across lock/sleep/display changes', () => {
  const { SNAP_DEBOUNCE_MS, POSITION_RESTORE_DELAY_MS } = require('../src/shared/config.cjs');
  const { screen } = require('electron');

  function makeWindow(position = [0, 0]) {
    const { EventEmitter } = require('node:events');
    return Object.assign(new EventEmitter(), {
      getBounds: jest.fn(() => ({ x: position[0], y: position[1], width: 172, height: 160 })),
      getPosition: jest.fn(() => position),
      setBounds: jest.fn(),
      isDestroyed: () => false
    });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    screen.getDisplayMatching.mockImplementation(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('a manual drag moves the window along with the cursor from its anchored origin', () => {
    const manager = new CharacterWindowManager();
    const window = makeWindow([500, 300]);
    manager.entry = { window, state: null, projectId: 'a' };

    screen.getCursorScreenPoint.mockReturnValueOnce({ x: 600, y: 400 });
    manager.beginUserDrag();
    screen.getCursorScreenPoint.mockReturnValueOnce({ x: 650, y: 430 });
    manager.moveUserDrag();

    expect(window.setBounds).toHaveBeenCalledWith({ x: 550, y: 330, ...manager.windowSize() });
  });

  test('a new drag cancels pending snapping and snaps only after release', () => {
    const manager = new CharacterWindowManager();
    const window = makeWindow([2, 2]);
    manager.entry = { window, state: null, projectId: 'a' };
    manager.handleWindowMove();
    manager.beginUserDrag();
    jest.advanceTimersByTime(SNAP_DEBOUNCE_MS + 1);
    manager.handleWindowMove();
    jest.advanceTimersByTime(SNAP_DEBOUNCE_MS + 1);
    expect(window.setBounds).not.toHaveBeenCalled();
    manager.endUserDrag();
    jest.advanceTimersByTime(SNAP_DEBOUNCE_MS + 1);
    expect(window.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, ...manager.windowSize() });
    window.setBounds.mockClear();
    manager.moveUserDrag();
    expect(window.setBounds).not.toHaveBeenCalled();
  });

  test('drag moves without an anchored origin are ignored', () => {
    const manager = new CharacterWindowManager();
    const window = makeWindow([500, 300]);
    manager.entry = { window, state: null, projectId: 'a' };

    manager.moveUserDrag();

    expect(window.setBounds).not.toHaveBeenCalled();
  });

  test('drag moves while position tracking is suspended are ignored', () => {
    const manager = new CharacterWindowManager();
    const window = makeWindow([500, 300]);
    manager.entry = { window, state: null, projectId: 'a' };

    manager.beginUserDrag();
    manager.suspendPositionTracking();
    manager.moveUserDrag();

    expect(window.setBounds).not.toHaveBeenCalled();
  });

  test('suspendPositionTracking cancels a pending snap so an OS move is not persisted', () => {
    const manager = new CharacterWindowManager();
    manager.entry = { window: makeWindow([500, 300]), state: null, projectId: 'a' };
    manager.saveWindowPosition({ x: 2000, y: 100 });

    manager.handleWindowMove();
    manager.suspendPositionTracking();
    jest.advanceTimersByTime(SNAP_DEBOUNCE_MS + POSITION_RESTORE_DELAY_MS);

    expect(manager.windowPosition).toEqual({ x: 2000, y: 100 });
    expect(manager.entry.window.setBounds).not.toHaveBeenCalled();
  });

  test('moves that arrive while tracking is suspended are ignored', () => {
    const manager = new CharacterWindowManager();
    manager.entry = { window: makeWindow([500, 300]), state: null, projectId: 'a' };
    manager.saveWindowPosition({ x: 2000, y: 100 });

    manager.suspendPositionTracking();
    manager.handleWindowMove();
    jest.advanceTimersByTime(SNAP_DEBOUNCE_MS * 2);

    expect(manager.windowPosition).toEqual({ x: 2000, y: 100 });
  });

  test('restoreWindowPosition puts the window back at the saved position and resumes tracking', () => {
    const manager = new CharacterWindowManager();
    const window = makeWindow([1748, 0]);
    manager.entry = { window, state: null, projectId: 'a' };
    manager.saveWindowPosition({ x: 100, y: 200 });

    manager.suspendPositionTracking();
    manager.restoreWindowPosition();
    jest.advanceTimersByTime(POSITION_RESTORE_DELAY_MS);

    expect(window.setBounds).toHaveBeenCalledWith({ x: 100, y: 200, ...manager.windowSize() });
    expect(manager.positionTrackingSuspended).toBe(false);
  });

  test('does not move the window while the saved position\'s display is unavailable', () => {
    const manager = new CharacterWindowManager();
    const window = makeWindow([1748, 0]);
    manager.entry = { window, state: null, projectId: 'a' };
    // Saved on a display that is no longer attached: clamping lands elsewhere.
    manager.saveWindowPosition({ x: 2500, y: 100 });

    manager.suspendPositionTracking();
    manager.restoreWindowPosition();
    jest.advanceTimersByTime(POSITION_RESTORE_DELAY_MS);

    expect(window.setBounds).not.toHaveBeenCalled();
    expect(manager.positionTrackingSuspended).toBe(false);
    expect(manager.windowPosition).toEqual({ x: 2500, y: 100 });
  });

  test('a later display-added retry restores once the display is back', () => {
    const manager = new CharacterWindowManager();
    const window = makeWindow([1748, 0]);
    manager.entry = { window, state: null, projectId: 'a' };
    manager.saveWindowPosition({ x: 2500, y: 100 });

    manager.suspendPositionTracking();
    manager.restoreWindowPosition();
    jest.advanceTimersByTime(POSITION_RESTORE_DELAY_MS);
    expect(window.setBounds).not.toHaveBeenCalled();

    // The second display re-enumerates: its work area now contains the
    // saved position, so the retry moves the window back.
    screen.getDisplayMatching.mockImplementation(() => ({ workArea: { x: 1920, y: 0, width: 1920, height: 1080 } }));
    manager.suspendPositionTracking();
    manager.restoreWindowPosition();
    jest.advanceTimersByTime(POSITION_RESTORE_DELAY_MS);

    expect(window.setBounds).toHaveBeenCalledWith({ x: 2500, y: 100, ...manager.windowSize() });
  });
});

// Emulate a native getBounds result rounded up from the requested DIP size.
test.each([50, 75, 100])('movement never feeds rounded native size back at character scale %s', scale => {
  const manager = new CharacterWindowManager();
  manager.characterScale = scale;
  let bounds = { x: 0, y: 0, width: 200, height: 200 };
  const window = {
    getBounds: () => bounds,
    setBounds: next => { bounds = { ...next, width: next.width + 1, height: next.height + 1 }; }
  };
  for (let i = 0; i < 100; i++) manager.positionWindow(window, -1000 + i, 200 + i);
  const size = manager.windowSize();
  expect(bounds).toEqual({ x: -901, y: 299, width: size.width + 1, height: size.height + 1 });
});


describe('drag source lifecycle', () => {
  const { EventEmitter } = require('node:events');
  function makeSource() {
    return Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      getPosition: () => [500, 300],
      getBounds: () => ({ x: 500, y: 300, width: 134, height: 138 }),
      setBounds: jest.fn()
    });
  }
  beforeEach(() => {
    jest.useFakeTimers();
    require('electron').screen.getDisplayMatching.mockReturnValue({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
  });
  afterEach(() => jest.useRealTimers());

  test.each(['hide', 'closed'])('a bubble %s ends the drag without renderer IPC', event => {
    const manager = new CharacterWindowManager();
    const character = makeSource();
    const bubble = makeSource();
    manager.entry = { window: character, state: null, projectId: 'a' };
    manager.beginUserDrag(bubble);
    expect(manager.dragOrigin).not.toBeNull();
    bubble.emit(event);
    expect(manager.dragOrigin).toBeNull();
    jest.runOnlyPendingTimers();
    expect(manager.windowPosition).toEqual({ x: 500, y: 300 });
    expect(bubble.listenerCount('hide')).toBe(0);
    expect(bubble.listenerCount('closed')).toBe(0);
  });

  test('events from another overlay cannot move or end the active drag', () => {
    const manager = new CharacterWindowManager();
    const character = makeSource();
    const bubble = makeSource();
    manager.entry = { window: character, state: null, projectId: 'a' };
    manager.beginUserDrag(bubble);
    manager.moveUserDrag(character);
    manager.endUserDrag(character);
    expect(character.setBounds).not.toHaveBeenCalled();
    expect(manager.dragOrigin).not.toBeNull();
    manager.endUserDrag(bubble);
    expect(manager.dragOrigin).toBeNull();
    manager.cleanup();
  });

  test('switching drag sources and suspending remove obsolete listeners', () => {
    const manager = new CharacterWindowManager();
    const character = makeSource();
    const bubble = makeSource();
    manager.entry = { window: character, state: null, projectId: 'a' };
    manager.beginUserDrag(bubble);
    manager.beginUserDrag(character);
    bubble.emit('closed');
    expect(manager.dragOrigin).not.toBeNull();
    expect(bubble.listenerCount('closed')).toBe(0);
    manager.suspendPositionTracking();
    expect(manager.dragOrigin).toBeNull();
    expect(character.listenerCount('hide')).toBe(0);
    expect(character.listenerCount('closed')).toBe(0);
  });
});
