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

module.exports = { snapshotClock, remainingResetMinutes };
