const { sourceState, sourceStale, accountState, groupAccounts, needsAttention, attentionCount } = require('../src/shared/monitoring/state.cjs');
const { MonitoringClient } = require('../src/monitoring/client.cjs');
const { memoryStore, sources } = require('./fixtures/workspace.cjs');
const now = Date.parse('2026-10-13T08:00:00Z');
const agent = { ...sources(now).find(source => source.kind === 'agent') };

test.each(['working', 'thinking', 'notification', 'alert', 'done', 'idle', 'sleep'])('silent %s coding hooks become inactive without attention', state => {
  const source = { ...agent, agent: { ...agent.agent, state } };
  expect(sourceStale(source, now + 119999)).toBe(false);
  expect(sourceState(source, now + 120000)).toBe('inactive');
  expect(needsAttention(sourceState(source, now + 120000))).toBe(false);
  expect(sourceState({ ...source, stale: true, health: 'error' }, now)).toBe('inactive');
});

test.each(['host', 'cluster', 'resource'])('%s silence still requires attention', kind => {
  const source = { ...agent, kind, agent: null, account: null };
  expect(sourceState(source, now + 119999)).toBe('ok');
  expect(sourceState(source, now + 120000)).toBe('stale');
  expect(needsAttention(sourceState(source, now + 120000))).toBe(true);
});

test('fresh errors and input requests are visible, and recovery clears the account once', () => {
  const old = { ...agent, sourceId: 'old', stale: true, health: 'error', agent: { ...agent.agent, state: 'alert' } };
  const waiting = { ...agent, sourceId: 'waiting', agent: { ...agent.agent, state: 'notification' } };
  const failed = { ...agent, sourceId: 'failed', health: 'error' };
  expect(attentionCount([agent, old], now)).toBe(0);
  expect(accountState({ sources: [agent, old] }, now)).toBe('working');
  expect(accountState({ sources: [old] }, now)).toBe('inactive');
  expect(accountState({ sources: [agent, waiting, failed] }, now)).toBe('error');
  expect(attentionCount([agent, waiting, failed], now)).toBe(1);
  expect(accountState({ sources: [agent, waiting] }, now)).toBe('notification');
  expect(attentionCount([agent, old, { ...waiting, stale: true }], now)).toBe(0);
});

test('receipt freshness and event-age transitions are independent', () => {
  const source = { ...agent, observedAt: new Date(now - 60000).toISOString(), agent: { ...agent.agent, state: 'done' } };
  expect(sourceState(source, now - 1)).toBe('done');
  expect(sourceState(source, now)).toBe('idle');
  expect(sourceState({ ...source, observedAt: new Date(now - 360000).toISOString() }, now)).toBe('sleep');
});

test.each(['notification', 'alert'])('fresh receipts preserve an old %s until resolution or silence', state => {
  const source = { ...agent, observedAt: new Date(now - 3600000).toISOString(), agent: { ...agent.agent, state } };
  expect(sourceState(source, now)).toBe(state);
  expect(attentionCount([source], now)).toBe(1);
  expect(sourceState({ ...source, agent: { ...source.agent, state: 'done' }, observedAt: source.receivedAt }, now)).toBe('done');
  expect(sourceState(source, now + 120000)).toBe('inactive');
});

test('accounts use timestamp order and stable ties without mutating input or blending providers', () => {
  const first = { ...agent, sourceId: 'z', observedAt: '2026-10-13T08:00:00Z' };
  const second = { ...agent, sourceId: 'a', observedAt: '2026-10-13T08:00:00.000Z' };
  const other = { ...agent, sourceId: 'other', account: { ...agent.account, provider: 'claude' } };
  const input = [first, second, other];
  const groups = groupAccounts(input);
  expect(groups).toHaveLength(2);
  expect(groups[0].latest.sourceId).toBe('a');
  expect(groups[0].sourceIds).toEqual(['a', 'z']);
  expect(input).toEqual([first, second, other]);
});

test('desktop cards, account counts and tray snapshot share the same selected-source decision', () => {
  let clock = now;
  const preferences = memoryStore();
  const client = new MonitoringClient({ preferences, credentials: { has: () => true }, now: () => clock });
  client.sources = [agent, { ...agent, sourceId: 'stopped', stale: true, health: 'error' }];
  let snapshot = client.snapshot();
  expect(snapshot.attentionCount).toBe(0);
  expect(snapshot.accounts[0]).toMatchObject({ displayState: 'working', needsAttention: false });
  expect(snapshot.sources[1]).toMatchObject({ displayState: 'inactive', needsAttention: false });
  clock += 120000;
  snapshot = client.snapshot();
  expect(snapshot.attentionCount).toBe(0);
  expect(snapshot.accounts[0]).toMatchObject({ displayState: 'inactive', needsAttention: false });
  client.sources.push({ ...sources(clock)[0], health: 'warning' });
  expect(client.snapshot().attentionCount).toBe(1);
  preferences.set('selectedSources', []);
  expect(client.snapshot().attentionCount).toBe(0);
});
