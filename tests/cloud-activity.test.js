const { CloudActivity } = require('../src/monitoring/activity.cjs');
const { companionState } = require('../src/shared/monitoring/state.cjs');
const { sources } = require('./fixtures/workspace.cjs');
const start = Date.parse('2026-10-13T08:00:00Z');
const source = sources(start).find(source => source.kind === 'agent');

test('cloud usage values keep their source precision on the local status path', () => {
  const update = jest.fn();
  const tracker = new CloudActivity(update, jest.fn(), () => start);
  tracker.accept([{ ...source, metrics: { contextPercent: 1.005, usageSessionPercent: 12.3456, usageWeekPercent: 0.125 }, agent: { ...source.agent, usageWeekModel: 22.875 } }]);
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ memory: 1.005, usage5h: 12.3456, usageWeek: 0.125, usageWeekModel: 22.875 }), source.sourceId, { activity: true });
});

test('cloud activity ages with unchanged timestamps, without repeatedly resetting local timers', () => {
  let now = start;
  const update = jest.fn(), remove = jest.fn();
  const tracker = new CloudActivity(update, remove, () => now);
  tracker.accept([source]);
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'working' }), source.sourceId, { activity: true });
  now += 120000;
  tracker.accept([source]);
  expect(update).toHaveBeenCalledTimes(1);
  now += 180000;
  tracker.accept([source]);
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'idle' }), source.sourceId, { activity: false });
  now += 300000;
  tracker.accept([source]);
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'sleep' }), source.sourceId, { activity: false });
  tracker.accept([source]);
  expect(update).toHaveBeenCalledTimes(3);
  const fresh = { ...source, observedAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString() };
  tracker.accept([fresh]);
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'working' }), source.sourceId, { activity: true });
  tracker.accept([]);
  expect(remove).toHaveBeenCalledWith(`cloud:${source.sourceId}`);
});

test('opening or reconnecting a workspace never creates companions for expired projects', () => {
  const update = jest.fn();
  const tracker = new CloudActivity(update, jest.fn(), () => start + 600000);
  tracker.accept([source, { ...source, sourceId: 'other', agent: { ...source.agent, state: 'sleep' } }]);
  expect(update).not.toHaveBeenCalled();
});

test('sources delivered locally are left to local delivery, dropping an earlier cloud copy', () => {
  const update = jest.fn(), remove = jest.fn();
  const local = new Set();
  const tracker = new CloudActivity(update, remove, () => start, id => local.has(id));
  tracker.accept([source]);
  expect(update).toHaveBeenCalledTimes(1);
  local.add(source.sourceId);
  tracker.accept([{ ...source, observedAt: new Date(start + 1000).toISOString() }]);
  expect(update).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledWith(`cloud:${source.sourceId}`);
  tracker.accept([source]);
  expect(remove).toHaveBeenCalledTimes(1);
});

test('cloud characters and cards share current errors and event age', () => {
  expect(companionState({ ...source, health: 'error' }, start)).toBe('alert');
  expect(companionState({ ...source, health: 'warning' }, start)).toBe('notification');
  expect(companionState({ ...source, stale: true }, start + 120000)).toBe('working');
  expect(companionState({ ...source, agent: { ...source.agent, state: 'done' }, observedAt: new Date(start - 60000).toISOString() }, start)).toBe('idle');
  expect(companionState({ ...source, observedAt: new Date(start - 600000).toISOString() }, start)).toBe('sleep');
  expect(companionState({ ...source, agent: { ...source.agent, state: 'constructor' } }, start)).toBe('constructor');
});
