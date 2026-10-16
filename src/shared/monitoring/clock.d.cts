export function snapshotClock(serverTime: unknown, monotonicNow?: () => number): () => number;
export function remainingResetMinutes(minutes: number | undefined, observedAt?: string, now?: number): number | undefined;
export const USAGE_RESET_FIELDS: Readonly<Record<'usageSessionPercent' | 'usageWeekPercent', 'usage5hResetsIn' | 'usageWeekResetsIn'>>;
export function usageResetAt(key: string, fields: Readonly<Record<string, unknown>> | null | undefined, observedAt?: string, now?: number): number | null;
