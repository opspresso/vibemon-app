const { StatusIngress } = require('../src/application/status-ingress.cjs');
const { StateManager } = require('../src/modules/state-manager.cjs');

function fixture() {
  const normalizer = new StateManager();
  const timers = { validateStateData: data => normalizer.validateStateData(data), setupStateTimeout: jest.fn() };
  const windows = {
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
