// Server timestamps establish report age; elapsed time must not depend on the
// reader's wall clock or a later manual/NTP clock adjustment.
function snapshotClock(serverTime, monotonicNow = () => globalThis.performance.now()) {
  const timestamp = typeof serverTime === 'string' ? Date.parse(serverTime) : NaN;
  const canonical = typeof serverTime === 'string' && serverTime.length === 20 ? serverTime.replace('Z', '.000Z') : serverTime;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== canonical) throw new Error('Invalid snapshot server time');
  const received = monotonicNow();
  return () => timestamp + Math.max(0, monotonicNow() - received);
}

module.exports = { snapshotClock };
