// Local hooks and cloud polls reach one companion through the same ingress.
jest.mock('../src/modules/window-pointer.cjs', () => ({ trackWindowPointer: jest.fn() }));
jest.mock('electron', () => ({
  BrowserWindow: jest.fn(() => ({
    setBounds: jest.fn(), isDestroyed: () => false, setIgnoreMouseEvents: jest.fn(), setWindowOpenHandler: jest.fn(),
    loadFile: jest.fn(), setVisibleOnAllWorkspaces: jest.fn(), showInactive: jest.fn(), setAlwaysOnTop: jest.fn(),
    once: jest.fn(), on: jest.fn(), webContents: { isDestroyed: () => false, once: jest.fn(), on: jest.fn(), send: jest.fn() }
  })),
  screen: {
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 })
  }
}));
jest.mock('electron-store', () => jest.fn().mockImplementation(function store(options) {
  const data = { ...options?.defaults };
  this.get = key => data[key];
  this.set = (key, value) => { data[key] = value; };
}));

const { StatusIngress } = require('../src/application/status-ingress.cjs');
const { CharacterWindowManager } = require('../src/modules/character-window-manager.cjs');
const { StateManager } = require('../src/modules/state-manager.cjs');
const { sources } = require('./fixtures/workspace.cjs');

const start = Date.parse('2026-10-13T08:00:00Z');
const account = { provider: 'claude', id: 'work', displayName: 'Work' };

function companion() {
  const stateManager = new StateManager();
  const windowManager = new CharacterWindowManager();
  const ingress = new StatusIngress(stateManager, windowManager);
  const local = (sourceId, state, project = sourceId) => ingress.accept({ sourceId, account, observedAt: new Date(Date.now()).toISOString(), state, project, character: 'clawd' });
  const remote = (sourceId, state, project = sourceId) => {
    const at = new Date(Date.now()).toISOString();
    return { ...sources(start).find(source => source.kind === 'agent'), sourceId, account, observedAt: at, receivedAt: at, agent: { state, project, character: 'clawd' } };
  };
  return { stateManager, windowManager, ingress, local, remote, cloud: ingress.cloudActivity(() => Date.now()) };
}

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(start); });
afterEach(() => jest.useRealTimers());

test('a new cloud event takes the companion from a settled local project', () => {
  const { windowManager, local, remote, cloud, stateManager } = companion();
  local('agent:here', 'done');
  expect(windowManager.getFocusedProjectId()).toBe('local:agent:here');
  jest.advanceTimersByTime(5000);
  cloud.accept([remote('agent:elsewhere', 'working')]);
  expect(windowManager.getFocusedProjectId()).toBe('cloud:agent:elsewhere');
  expect(windowManager.getState('cloud:agent:elsewhere').state).toBe('working');
  stateManager.cleanup();
});

test('a long silent tool call keeps the cloud companion working', () => {
  const { windowManager, remote, cloud, stateManager } = companion();
  const working = remote('agent:elsewhere', 'working');
  cloud.accept([working]);
  jest.advanceTimersByTime(240000);
  cloud.accept([working]);
  expect(windowManager.getState('cloud:agent:elsewhere').state).toBe('working');
  jest.advanceTimersByTime(60000);
  cloud.accept([working]);
  expect(windowManager.getState('cloud:agent:elsewhere').state).toBe('idle');
  stateManager.cleanup();
});

test('local delivery replaces the cloud copy of the same source in the companion', () => {
  const { windowManager, local, remote, cloud, stateManager } = companion();
  const working = remote('agent:here', 'working');
  cloud.accept([working]);
  expect(windowManager.getFocusedProjectId()).toBe('cloud:agent:here');
  jest.advanceTimersByTime(1000);
  local('agent:here', 'thinking');
  expect(windowManager.getFocusedProjectId()).toBe('local:agent:here');
  expect(windowManager.getState('local:agent:here').state).toBe('thinking');
  expect(windowManager.getRegisteredState('cloud:agent:here')).toBeNull();
  jest.advanceTimersByTime(30000);
  cloud.accept([{ ...working, observedAt: new Date(Date.now()).toISOString() }]);
  expect(windowManager.getRegisteredState('cloud:agent:here')).toBeNull();
  expect(windowManager.getFocusedProjectId()).toBe('local:agent:here');
  stateManager.cleanup();
});
