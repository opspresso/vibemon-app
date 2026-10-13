const { snapshotClock } = require('../src/shared/monitoring/clock.cjs');
const { sourceState } = require('../src/shared/monitoring/state.cjs');

test.each([86400000, -86400000])('reader wall-clock skew of %i ms does not change freshness', skew => {
  const server = Date.parse('2026-10-13T08:00:00.000Z');
  const wallClock = jest.spyOn(Date, 'now').mockReturnValue(server + skew);
  let elapsed = 500;
  const clock = snapshotClock(new Date(server).toISOString(), () => elapsed);
  const source = { kind: 'cluster', receivedAt: new Date(server).toISOString(), health: 'ok' };
  try {
    expect(sourceState(source, clock())).toBe('ok');
    wallClock.mockReturnValue(server - skew);
    elapsed += 119999;
    expect(sourceState(source, clock())).toBe('ok');
    elapsed++;
    expect(sourceState(source, clock())).toBe('stale');
    expect(sourceState({ ...source, kind: 'agent' }, clock())).toBe('inactive');
  } finally { wallClock.mockRestore(); }
});

test.each([undefined, null, 0, '', '0', '2026-02-30T08:00:00.000Z', '2026-10-13T08:00:00+00:00'])('invalid snapshot timestamp is rejected: %p', value => {
  expect(() => snapshotClock(value)).toThrow('Invalid snapshot server time');
});

test('UTC timestamps with and without milliseconds anchor the same clock', () => {
  expect(snapshotClock('2026-10-13T08:00:00Z', () => 0)()).toBe(snapshotClock('2026-10-13T08:00:00.000Z', () => 0)());
});
