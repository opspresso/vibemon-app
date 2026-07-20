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

describe('default settings', () => {
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

describe('position tracking across lock/sleep/display changes', () => {
  const { SNAP_DEBOUNCE_MS, POSITION_RESTORE_DELAY_MS } = require('../src/shared/config.cjs');
  const { screen } = require('electron');

  function makeWindow(position = [0, 0]) {
    return {
      getBounds: jest.fn(() => ({ x: position[0], y: position[1], width: 172, height: 160 })),
      getPosition: jest.fn(() => position),
      setPosition: jest.fn(),
      isDestroyed: () => false
    };
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

    expect(window.setPosition).toHaveBeenCalledWith(550, 330);
  });

  test('drag moves without an anchored origin are ignored', () => {
    const manager = new CharacterWindowManager();
    const window = makeWindow([500, 300]);
    manager.entry = { window, state: null, projectId: 'a' };

    manager.moveUserDrag();

    expect(window.setPosition).not.toHaveBeenCalled();
  });

  test('drag moves while position tracking is suspended are ignored', () => {
    const manager = new CharacterWindowManager();
    const window = makeWindow([500, 300]);
    manager.entry = { window, state: null, projectId: 'a' };

    manager.beginUserDrag();
    manager.suspendPositionTracking();
    manager.moveUserDrag();

    expect(window.setPosition).not.toHaveBeenCalled();
  });

  test('suspendPositionTracking cancels a pending snap so an OS move is not persisted', () => {
    const manager = new CharacterWindowManager();
    manager.entry = { window: makeWindow([500, 300]), state: null, projectId: 'a' };
    manager.saveWindowPosition({ x: 2000, y: 100 });

    manager.handleWindowMove();
    manager.suspendPositionTracking();
    jest.advanceTimersByTime(SNAP_DEBOUNCE_MS + POSITION_RESTORE_DELAY_MS);

    expect(manager.windowPosition).toEqual({ x: 2000, y: 100 });
    expect(manager.entry.window.setPosition).not.toHaveBeenCalled();
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

    expect(window.setPosition).toHaveBeenCalledWith(100, 200);
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

    expect(window.setPosition).not.toHaveBeenCalled();
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
    expect(window.setPosition).not.toHaveBeenCalled();

    // The second display re-enumerates: its work area now contains the
    // saved position, so the retry moves the window back.
    screen.getDisplayMatching.mockImplementation(() => ({ workArea: { x: 1920, y: 0, width: 1920, height: 1080 } }));
    manager.suspendPositionTracking();
    manager.restoreWindowPosition();
    jest.advanceTimersByTime(POSITION_RESTORE_DELAY_MS);

    expect(window.setPosition).toHaveBeenCalledWith(2500, 100);
  });
});
