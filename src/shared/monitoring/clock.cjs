// Server timestamps establish report age; elapsed time must not depend on the
// reader's wall clock or a later manual/NTP clock adjustment.
function snapshotClock(serverTime, monotonicNow = () => globalThis.performance.now()) {
  const timestamp = typeof serverTime === 'string' ? Date.parse(serverTime) : NaN;
  const canonical = typeof serverTime === 'string' && serverTime.length === 20 ? serverTime.replace('Z', '.000Z') : serverTime;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== canonical) throw new Error('Invalid snapshot server time');
  const received = monotonicNow();
  return () => timestamp + Math.max(0, monotonicNow() - received);
}

// Reset durations describe the observation, not the time a reader opened it.
// Keep the supplied duration when its timestamp is unknown; future timestamps
// cannot increase it. Subtract minutes without multiplying a safe integer.
function remainingResetMinutes(minutes, observedAt, now = Date.now()) {
  if (!Number.isSafeInteger(minutes) || minutes < 0) return undefined;
  const observed = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN;
  if (!Number.isFinite(observed) || !Number.isFinite(now)) return minutes;
  return Math.max(0, minutes - Math.max(0, Math.floor((now - observed) / 60000)));
}

// Plan usage values that reset on a rolling window, and the agent field that
// reports the minutes until that reset, measured at the observation time.
// `usageWeekModel` is the agent's weekly usage of one model family, not a metric.
const USAGE_RESET_FIELDS = Object.freeze({
  usageSessionPercent: 'usage5hResetsIn', usageWeekPercent: 'usageWeekResetsIn', usageWeekModel: 'usageWeekModelResetsIn'
});

// The time in milliseconds at which a plan usage metric resets, or null when
// `fields` does not report it or the time is outside the Date range. A
// countdown from this time matches remainingResetMinutes: a future
// observation does not increase it.
function usageResetAt(key, fields, observedAt, now = Date.now()) {
  const minutes = Object.hasOwn(USAGE_RESET_FIELDS, key) ? fields?.[USAGE_RESET_FIELDS[key]] : undefined;
  if (!Number.isSafeInteger(minutes) || minutes < 0 || !Number.isFinite(now)) return null;
  const observed = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN;
  const resetAt = (Number.isFinite(observed) ? Math.min(observed, now) : now) + minutes * 60000;
  return Number.isNaN(new Date(resetAt).getTime()) ? null : resetAt;
}

module.exports = { snapshotClock, remainingResetMinutes, USAGE_RESET_FIELDS, usageResetAt };
