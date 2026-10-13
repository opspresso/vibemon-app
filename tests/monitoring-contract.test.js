const { cases } = require('../src/shared/monitoring/cases.json');
const { sourceState, groupAccounts, accountState } = require('../src/shared/monitoring/state.cjs');
const now = Date.parse('2026-10-13T08:00:00Z');

test.each(cases)('shared monitoring contract: $name', fixture => {
  const sources = fixture.sources.map(source => ({
    ...source,
    receivedAt: new Date(now - (source.receiptAgeMs ?? 0)).toISOString(),
    observedAt: new Date(now - (source.eventAgeMs ?? 0)).toISOString(),
    health: source.health ?? 'ok',
    ...(source.kind === 'agent' ? {
      agent: { state: source.state },
      account: { id: source.accountId ?? 'work', provider: source.provider ?? 'codex', displayName: 'Account' }
    } : {})
  }));
  const clock = now + fixture.elapsedMs;
  const accounts = groupAccounts(sources);
  if (fixture.expected.resources) expect(Object.fromEntries(sources.filter(source => source.kind !== 'agent').map(source => [source.sourceId, sourceState(source, clock)]))).toEqual(fixture.expected.resources);
  if (fixture.expected.accounts) expect(Object.fromEntries(accounts.map(account => [account.accountId, accountState(account, clock)]))).toEqual(fixture.expected.accounts);
  if (fixture.expected.latest) expect(Object.fromEntries(accounts.map(account => [account.accountId, account.latest.sourceId]))).toEqual(fixture.expected.latest);
});
