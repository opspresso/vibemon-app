/**
 * Tests for multi-window-manager.cjs
 * Scoped to plain state/bookkeeping logic that doesn't require real windows.
 */

jest.mock('electron', () => ({
  BrowserWindow: jest.fn(),
  screen: {
    getDisplayMatching: jest.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
    getAllDisplays: jest.fn(() => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]),
    getPrimaryDisplay: jest.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }))
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
  // Lets a test seed keys (e.g. the legacy characterOnlyMode flag) that
  // exist on disk before the next `new Store(...)` call, without touching
  // the `defaults` MultiWindowManager itself passes in.
  MockStore.__presetNextStore = (preset) => { presetData = preset; };
  return MockStore;
});

const { MultiWindowManager } = require('../src/modules/multi-window-manager.cjs');
const { MAX_PROJECT_LIST, MAX_STATE_REGISTRY_SIZE, FOCUS_HYSTERESIS_MS } = require('../src/shared/config.cjs');
const Store = require('electron-store');

describe('default settings', () => {
  test('a fresh install defaults to character app mode, single window mode, and all always-on-top', () => {
    const manager = new MultiWindowManager();

    expect(manager.getAppMode()).toBe('character');
    expect(manager.getWindowMode()).toBe('single');
    expect(manager.getAlwaysOnTopMode()).toBe('all');
  });

  test('honors an explicit legacy characterOnlyMode=false as window mode', () => {
    Store.__presetNextStore({ characterOnlyMode: false });
    const manager = new MultiWindowManager();

    expect(manager.getAppMode()).toBe('window');
  });

  test('honors an explicit legacy characterOnlyMode=true as character mode', () => {
    Store.__presetNextStore({ characterOnlyMode: true });
    const manager = new MultiWindowManager();

    expect(manager.getAppMode()).toBe('character');
  });
});

describe('pruneStateRegistry', () => {
  test('evicts least-recently-updated entries beyond the cap, skipping live windows', () => {
    const manager = new MultiWindowManager();

    for (let i = 0; i < MAX_STATE_REGISTRY_SIZE + 5; i++) {
      manager.stateRegistry.set(`proj-${i}`, { state: 'idle' });
    }
    // proj-0 is the oldest entry but has a live window, so it must survive.
    manager.windows.set('proj-0', { window: {}, state: { state: 'idle' } });

    manager.pruneStateRegistry();

    expect(manager.stateRegistry.size).toBe(MAX_STATE_REGISTRY_SIZE);
    expect(manager.stateRegistry.has('proj-0')).toBe(true);
    expect(manager.stateRegistry.has('proj-1')).toBe(false);
  });

  test('does not evict below the cap', () => {
    const manager = new MultiWindowManager();
    manager.stateRegistry.set('proj-a', { state: 'idle' });

    manager.pruneStateRegistry();

    expect(manager.stateRegistry.size).toBe(1);
  });
});

describe('addProjectToList', () => {
  test('evicts the oldest project and its saved window position beyond MAX_PROJECT_LIST', () => {
    const manager = new MultiWindowManager();

    for (let i = 0; i < MAX_PROJECT_LIST; i++) {
      manager.addProjectToList(`proj-${i}`);
      manager.saveWindowPosition(`proj-${i}`, { x: i, y: i });
    }
    expect(manager.getSavedWindowPosition('proj-0')).not.toBeNull();

    manager.addProjectToList('proj-new');

    expect(manager.getProjectList()).not.toContain('proj-0');
    expect(manager.getSavedWindowPosition('proj-0')).toBeNull();
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
    const manager = new MultiWindowManager();
    manager.stateRegistry.set('a', { state: 'working' });

    expect(manager.selectFocus('a', 'working')).toBe('a');
  });

  test('a different active project cannot steal focus within the hysteresis window', () => {
    const manager = new MultiWindowManager();
    manager.stateRegistry.set('a', { state: 'working' });
    manager.selectFocus('a', 'working');

    now += FOCUS_HYSTERESIS_MS - 1;
    manager.stateRegistry.set('b', { state: 'thinking' });

    expect(manager.selectFocus('b', 'thinking')).toBe('a');
  });

  test('a different active project takes focus once the hysteresis window elapses', () => {
    const manager = new MultiWindowManager();
    manager.stateRegistry.set('a', { state: 'working' });
    manager.selectFocus('a', 'working');

    now += FOCUS_HYSTERESIS_MS;
    manager.stateRegistry.set('b', { state: 'thinking' });

    expect(manager.selectFocus('b', 'thinking')).toBe('b');
  });

  test('an alert bypasses the hysteresis window and takes focus immediately', () => {
    const manager = new MultiWindowManager();
    manager.stateRegistry.set('a', { state: 'working' });
    manager.selectFocus('a', 'working');

    now += 1;
    manager.stateRegistry.set('b', { state: 'alert' });

    expect(manager.selectFocus('b', 'alert')).toBe('b');
  });

  test('a non-active project does not steal focus from a still-active one', () => {
    const manager = new MultiWindowManager();
    manager.stateRegistry.set('a', { state: 'working' });
    manager.selectFocus('a', 'working');

    now += FOCUS_HYSTERESIS_MS;
    manager.stateRegistry.set('b', { state: 'idle' });

    expect(manager.selectFocus('b', 'idle')).toBe('a');
  });
});

describe('arrangeWindowsByName', () => {
  function fakeWindowEntry() {
    return {
      window: { isDestroyed: () => false, setPosition: jest.fn() },
      state: { state: 'idle' }
    };
  }

  test('does not reposition the window in Single-Window Mode', () => {
    const manager = new MultiWindowManager();
    manager.appMode = 'window';
    manager.windowMode = 'single';
    const entry = fakeWindowEntry();
    manager.windows.set('proj-a', entry);

    manager.arrangeWindowsByName();

    expect(entry.window.setPosition).not.toHaveBeenCalled();
  });

  test('repositions windows in Multi-Window Mode', () => {
    const manager = new MultiWindowManager();
    manager.appMode = 'window';
    manager.windowMode = 'multi';
    const entry = fakeWindowEntry();
    manager.windows.set('proj-a', entry);

    manager.arrangeWindowsByName();

    expect(entry.window.setPosition).toHaveBeenCalled();
  });
});
