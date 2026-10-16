const { snapshotClock, remainingResetMinutes, usageResetAt } = require('../src/shared/monitoring/clock.cjs');
const { sourceState } = require('../src/shared/monitoring/state.cjs');

test.each([86400000, -86400000])('reader wall-clock skew of %i ms does not change freshness or event age', skew => {
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
    const agent = { ...source, kind: 'agent', observedAt: source.receivedAt, agent: { state: 'working' } };
    expect(sourceState(agent, clock())).toBe('working');
    elapsed += 180000;
    expect(sourceState(agent, clock())).toBe('idle');
  } finally { wallClock.mockRestore(); }
});

test.each([undefined, null, 0, '', '0', '2026-02-30T08:00:00.000Z', '2026-10-13T08:00:00+00:00'])('invalid snapshot timestamp is rejected: %p', value => {
  expect(() => snapshotClock(value)).toThrow('Invalid snapshot server time');
});

test('UTC timestamps with and without milliseconds anchor the same clock', () => {
  expect(snapshotClock('2026-10-13T08:00:00Z', () => 0)()).toBe(snapshotClock('2026-10-13T08:00:00.000Z', () => 0)());
});

test('reset countdown boundaries preserve the observation and never increase it', () => {
  const observedAt = '2026-10-13T08:00:00Z';
  const start = Date.parse(observedAt);
  for (const [elapsed, expected] of [[-30000, 65], [59999, 65], [60000, 64], [300000, 60], [86400000, 0]]) {
    expect(remainingResetMinutes(65, observedAt, start + elapsed)).toBe(expected);
  }
  expect(remainingResetMinutes(65, undefined, start)).toBe(65);
  expect(remainingResetMinutes(65, 'invalid', start)).toBe(65);
  expect(remainingResetMinutes(65, observedAt, NaN)).toBe(65);
  expect(remainingResetMinutes(Number.MAX_SAFE_INTEGER, observedAt, start + 60000)).toBe(Number.MAX_SAFE_INTEGER - 1);
  for (const value of [undefined, null, '', '65', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(remainingResetMinutes(value, observedAt, start)).toBeUndefined();
  }
});

test('usage reset time anchors plan usage countdowns at the observation', () => {
  const observedAt = '2026-10-13T08:00:00Z';
  const start = Date.parse(observedAt);
  const fields = { usage5hResetsIn: 65, usageWeekResetsIn: 4381 };
  expect(usageResetAt('usageSessionPercent', fields, observedAt, start + 90000)).toBe(start + 65 * 60000);
  expect(usageResetAt('usageWeekPercent', fields, observedAt, start)).toBe(start + 4381 * 60000);
  // A future observation cannot increase the countdown.
  expect(usageResetAt('usageSessionPercent', fields, observedAt, start - 30000)).toBe(start - 30000 + 65 * 60000);
  expect(usageResetAt('usageSessionPercent', fields, 'invalid', start + 5)).toBe(start + 5 + 65 * 60000);
  for (const key of ['contextPercent', 'usageWeekModel', 'constructor', '__proto__']) expect(usageResetAt(key, fields, observedAt, start)).toBeNull();
  for (const value of [undefined, null, '', '65', -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    expect(usageResetAt('usageSessionPercent', { usage5hResetsIn: value }, observedAt, start)).toBeNull();
  }
  expect(usageResetAt('usageSessionPercent', null, observedAt, start)).toBeNull();
  expect(usageResetAt('usageSessionPercent', fields, observedAt, NaN)).toBeNull();
});
