export function snapshotClock(serverTime: unknown, monotonicNow?: () => number): () => number;
export function remainingResetMinutes(minutes: number | undefined, observedAt?: string, now?: number): number | undefined;
