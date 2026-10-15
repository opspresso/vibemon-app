const { sourceState, sourceStale, accountState, accountActivity, groupAccounts, needsAttention, attentionCount } = require('../src/shared/monitoring/state.cjs');
const { MonitoringClient } = require('../src/monitoring/client.cjs');
const { memoryStore, sources } = require('./fixtures/workspace.cjs');
const now = Date.parse('2026-10-13T08:00:00Z');
const agent = { ...sources(now).find(source => source.kind === 'agent') };

// Agent sources age on their report clock, never on receipt silence: a state stays live until it times out.
test.each(['working', 'thinking', 'planning', 'packing', 'notification', 'alert'])('a silent %s hook stays live until its event clock expires', state => {
  const source = { ...agent, agent: { ...agent.agent, state } };
  expect(sourceStale(source, now + 600000)).toBe(false);
  expect(sourceState(source, now + 299999)).toBe(state);
  expect(sourceState({ ...source, stale: true }, now)).toBe(state);
  expect(sourceState(source, now + 300000)).toBe('idle');
  expect(sourceState(source, now + 600000)).toBe('inactive');
  expect(needsAttention(sourceState(source, now + 600000))).toBe(false);
});

test.each(['host', 'cluster', 'resource'])('%s silence still requires attention', kind => {
  const source = { ...agent, kind, agent: null, account: null };
  expect(sourceState(source, now + 119999)).toBe('ok');
  expect(sourceState(source, now + 120000)).toBe('stale');
  expect(needsAttention(sourceState(source, now + 120000))).toBe(true);
});

test('fresh errors and input requests are visible, and recovery clears the account once', () => {
  const old = { ...agent, sourceId: 'old', health: 'error', observedAt: new Date(now - 600000).toISOString(), agent: { ...agent.agent, state: 'alert' } };
  const waiting = { ...agent, sourceId: 'waiting', agent: { ...agent.agent, state: 'notification' } };
  const failed = { ...agent, sourceId: 'failed', health: 'error' };
  expect(attentionCount([agent, old], now)).toBe(0);
  expect(accountState({ sources: [agent, old] }, now)).toBe('working');
  expect(accountState({ sources: [old] }, now)).toBe('inactive');
  expect(accountState({ sources: [agent, waiting, failed] }, now)).toBe('error');
  expect(attentionCount([agent, waiting, failed], now)).toBe(1);
  expect(accountState({ sources: [agent, waiting] }, now)).toBe('notification');
  expect(attentionCount([agent, old, { ...waiting, observedAt: old.observedAt }], now)).toBe(0);
});

test('event-age transitions ignore receipt freshness', () => {
  const source = { ...agent, observedAt: new Date(now - 60000).toISOString(), agent: { ...agent.agent, state: 'done' } };
  expect(sourceState(source, now - 1)).toBe('done');
  expect(sourceState(source, now)).toBe('idle');
  expect(sourceState({ ...source, observedAt: new Date(now - 360000).toISOString() }, now)).toBe('inactive');
});

test('an agent source without activity details falls back to its health', () => {
  expect(sourceState({ ...agent, agent: null, health: 'warning' }, now + 600000)).toBe('warning');
});

test('an aged alert drops the error health it was reported with', () => {
  const source = { ...agent, health: 'error', agent: { ...agent.agent, state: 'alert' } };
  expect(sourceState(source, now)).toBe('error');
  expect(sourceState(source, now + 300000)).toBe('idle');
  expect(attentionCount([source], now + 300000)).toBe(0);
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

test('the title follows the project driving the state and keeps the last project when inactive', () => {
  const waiting = { ...agent, sourceId: 'review', observedAt: new Date(now - 1000).toISOString(), agent: { ...agent.agent, project: 'release-review', state: 'notification' } };
  const account = groupAccounts([waiting, agent])[0];
  expect(accountActivity(account, now)).toEqual({ state: 'notification', source: waiting, project: 'release-review' });
  expect(accountActivity(account, now + 610000)).toEqual({ state: 'inactive', source: agent, project: agent.agent.project });
  expect(accountActivity({ ...account, sources: [] }, now)).toEqual({ state: 'inactive', source: undefined, project: account.displayName });
  expect(accountActivity({ ...account, sources: [{ ...agent, agent: { ...agent.agent, project: ' ' } }] }, now).project).toBe(agent.displayName);
});

test('desktop cards, account counts and tray snapshot share the same selected-source decision', () => {
  let clock = now;
  const preferences = memoryStore();
  const client = new MonitoringClient({ preferences, credentials: { has: () => true }, now: () => clock });
  client.sources = [agent, { ...agent, sourceId: 'stopped', health: 'error', observedAt: new Date(now - 600000).toISOString() }];
  let snapshot = client.snapshot();
  expect(snapshot.attentionCount).toBe(0);
  expect(snapshot.accounts[0]).toMatchObject({ displayState: 'working', displayProject: agent.agent.project, needsAttention: false });
  expect(snapshot.sources[1]).toMatchObject({ displayState: 'inactive', needsAttention: false });
  clock += 600000;
  snapshot = client.snapshot();
  expect(snapshot.attentionCount).toBe(0);
  expect(snapshot.accounts[0]).toMatchObject({ displayState: 'inactive', needsAttention: false });
  client.sources.push({ ...sources(clock)[0], health: 'warning' });
  expect(client.snapshot().attentionCount).toBe(1);
  preferences.set('selectedSources', []);
  expect(client.snapshot().attentionCount).toBe(0);
});
