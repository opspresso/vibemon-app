const { StatusIngress } = require('../src/application/status-ingress.cjs');
const { StateManager } = require('../src/modules/state-manager.cjs');

function fixture() {
  const normalizer = new StateManager();
  const timers = { validateStateData: data => normalizer.validateStateData(data), setupStateTimeout: jest.fn(), cleanupProject: jest.fn() };
  const windows = {
    getRegisteredState: jest.fn(() => null), removeProject: jest.fn(),
    getFocusedProjectId: () => 'focused', routeStatusUpdate: jest.fn((_id, state) => ({
      switchedProject: 'old', updateResult: { updated: true, stateChanged: true }, stateData: { ...state, character: 'codex' }
    })), updateAlwaysOnTopByState: jest.fn(), sendToWindow: jest.fn()
  };
  const effects = { onProjectSwitched: jest.fn(), onStateUpdate: jest.fn() };
  return { ingress: new StatusIngress(timers, windows, effects), timers, windows, effects };
}
test.each([{}, { sourceId: 'agent:work', preserveFocus: true }])('uses the same validated routing and display effects for %j', options => {
  const { ingress, windows, effects, timers } = fixture();
  const data = { state: 'notification', project: 'Project', character: 'clawd', unexpected: 'drop' };
  const result = ingress.accept(data, options);
  const id = options.sourceId ? 'cloud:agent:work' : 'Project';
  expect(result).toEqual({ valid: true, response: { success: true, project: id, state: 'notification', focusedProject: 'focused' } });
  expect(windows.routeStatusUpdate.mock.calls[0].slice(0, 2)).toEqual([id, { state: 'notification', project: 'Project', character: 'clawd' }]);
  expect(windows.sendToWindow).toHaveBeenCalledWith(id, 'state-update', { state: 'notification', project: 'Project', character: 'codex' });
  expect(effects.onProjectSwitched).toHaveBeenCalledWith('old');
  expect(effects.onStateUpdate).toHaveBeenCalledWith(false);
  if (options.sourceId) {
    expect(timers.setupStateTimeout).toHaveBeenCalledWith(id, 'notification', { remote: true });
    expect(windows.routeStatusUpdate.mock.calls[0][2]).toEqual({ preserveFocus: true });
  } else expect(timers.setupStateTimeout).toHaveBeenCalledWith(id, 'notification');
});
test('a heartbeat refreshes the state timer without competing for focus', () => {
  const { ingress, windows, timers } = fixture();
  expect(ingress.accept({ state: 'working', project: 'Long build', heartbeat: true }).valid).toBe(true);
  expect(windows.routeStatusUpdate.mock.calls[0]).toEqual(['Long build', { state: 'working', project: 'Long build' }, { preserveFocus: true }]);
  expect(timers.setupStateTimeout).toHaveBeenCalledWith('Long build', 'working');
  expect(ingress.accept({ state: 'working', project: 'Long build', heartbeat: 'yes' }).valid).toBe(false);
});
test('records background activity without updating another project window', () => {
  const { ingress, windows, timers, effects } = fixture();
  windows.routeStatusUpdate.mockReturnValue({ switchedProject: null, updateResult: { updated: false }, stateData: {} });
  expect(ingress.accept({ state: 'working', project: 'background' }).response.skipped).toBe(true);
  expect(timers.setupStateTimeout).toHaveBeenCalledWith('background', 'working');
  expect(windows.sendToWindow).not.toHaveBeenCalled();
  expect(effects.onStateUpdate).not.toHaveBeenCalled();
});
test.each([{ state: { toString: 'invalid' } }, { state: 'working', usage5hResetsIn: 1e20 }])('rejects malformed inputs before effects: %j', data => {
  const { ingress, windows, timers } = fixture();
  expect(ingress.accept({ project: 'Project', ...data }).valid).toBe(false);
  expect(windows.routeStatusUpdate).not.toHaveBeenCalled();
  expect(timers.setupStateTimeout).not.toHaveBeenCalled();
});
test('empty project labels never enter either activity path', () => {
  const { ingress, windows } = fixture();
  expect(ingress.accept({ state: 'idle', project: '-' }, { sourceId: 'agent:work' }).response).toMatchObject({ project: null, skipped: true });
  expect(windows.routeStatusUpdate).not.toHaveBeenCalled();
});

test('same project names retain independent account/workspace state and reject replay', () => {
  const { ingress, windows, timers } = fixture();
  const registry = new Map();
  windows.getRegisteredState.mockImplementation(id => registry.get(id));
  windows.routeStatusUpdate.mockImplementation((id, state) => {
    registry.set(id, state);
    return { switchedProject: null, updateResult: { updated: true, stateChanged: true }, stateData: state };
  });
  const observedAt = new Date(Date.now() - 1000).toISOString();
  const event = { project: 'same-project', character: 'codex', state: 'working', observedAt };
  for (const [sourceId, provider, id] of [['one', 'codex', 'work'], ['two', 'codex', 'personal'], ['three', 'claude', 'work'], ['four', 'codex', 'work']]) {
    expect(ingress.accept({ ...event, sourceId, account: { provider, id, displayName: id } }).valid).toBe(true);
  }
  expect(registry.size).toBe(4);
  expect([...registry.values()].map(state => state.project)).toEqual(Array(4).fill('same-project'));
  const original = registry.get('local:one');
  timers.setupStateTimeout.mockClear();
  expect(ingress.accept({ ...original, state: 'done' }).response.reason).toBe('duplicate_or_older');
  expect(ingress.accept({ ...original, state: 'done', observedAt: new Date(Date.parse(observedAt) - 1000).toISOString() }).response.skipped).toBe(true);
  expect(timers.setupStateTimeout).not.toHaveBeenCalled();
  expect(registry.get('local:one').state).toBe('working');
  expect(ingress.accept({ ...original, account: { ...original.account, id: 'other' } }).valid).toBe(false);
});
test.each([{ sourceId: '../bad' }, { account: { provider: 'Codex', id: 'work', displayName: 'Work' } }, { observedAt: '2020-01-01T00:00:00Z' }])('rejects invalid identity metadata: %j', extra => {
  const { ingress, windows } = fixture();
  expect(ingress.accept({ project: 'Project', state: 'working', ...extra }).valid).toBe(false);
  expect(windows.routeStatusUpdate).not.toHaveBeenCalled();
});
test('internal usage-refresh events cannot enter the registry under a source ID', () => {
  const { ingress, windows, timers } = fixture();
  expect(ingress.accept({ project: '.vibemon', state: 'working', sourceId: 'internal' }).response.skipped).toBe(true);
  expect(windows.routeStatusUpdate).not.toHaveBeenCalled();
  expect(timers.setupStateTimeout).not.toHaveBeenCalled();
});
