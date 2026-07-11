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
  return jest.fn().mockImplementation(function mockStore(opts) {
    const data = { ...(opts && opts.defaults) };
    this.get = (key) => data[key];
    this.set = (key, value) => { data[key] = value; };
  });
});

const { MultiWindowManager } = require('../modules/multi-window-manager.cjs');
const { MAX_PROJECT_LIST, MAX_STATE_REGISTRY_SIZE } = require('../shared/config.cjs');

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

describe('arrangeWindowsByName', () => {
  function fakeWindowEntry() {
    return {
      window: { isDestroyed: () => false, setPosition: jest.fn() },
      state: { state: 'idle' }
    };
  }

  test('does not reposition the window in Single-Window Mode', () => {
    const manager = new MultiWindowManager();
    manager.windowMode = 'single';
    const entry = fakeWindowEntry();
    manager.windows.set('proj-a', entry);

    manager.arrangeWindowsByName();

    expect(entry.window.setPosition).not.toHaveBeenCalled();
  });

  test('repositions windows in Multi-Window Mode', () => {
    const manager = new MultiWindowManager();
    manager.windowMode = 'multi';
    const entry = fakeWindowEntry();
    manager.windows.set('proj-a', entry);

    manager.arrangeWindowsByName();

    expect(entry.window.setPosition).toHaveBeenCalled();
  });
});
