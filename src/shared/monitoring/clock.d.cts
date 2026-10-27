export function snapshotClock(serverTime: unknown, monotonicNow?: () => number): () => number;
export function remainingResetMinutes(minutes: number | undefined, observedAt?: string, now?: number): number | undefined;
export const USAGE_RESET_FIELDS: Readonly<Record<'usageSessionPercent' | 'usageWeekPercent' | 'usageWeekModel', 'usage5hResetsIn' | 'usageWeekResetsIn' | 'usageWeekModelResetsIn'>>;
export function usageResetAt(key: string, fields: { readonly usage5hResetsIn?: unknown; readonly usageWeekResetsIn?: unknown; readonly usageWeekModelResetsIn?: unknown } | null | undefined, observedAt?: string, now?: number): number | null;
