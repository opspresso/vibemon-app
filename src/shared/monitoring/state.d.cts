export interface MonitoringSource {
  sourceId: string;
  kind: string;
  receivedAt: string;
  observedAt: string;
  health: string;
  stale?: boolean;
  agent?: { state: string } | null;
  account?: { id: string; provider: string; displayName: string } | null;
}
export interface MonitoringAccount<T extends MonitoringSource> {
  accountId: string; id: string; provider: string; displayName: string;
  latest: T; sources: T[]; sourceIds: string[];
}
export function needsAttention(state: string): boolean;
export function dominantState(states: Array<string | undefined>, fallback?: string): string;
export function sourceStale(source: Pick<MonitoringSource, 'receivedAt' | 'stale'>, now?: number): boolean;
export function idleAgentState(state: string, observedAt: string, now?: number): string;
export function sourceState(source: MonitoringSource, now?: number): string;
export function codingAccountState(states: string[]): string;
export function accountState<T extends { sources: MonitoringSource[] }>(account: T, now?: number): string;
export function accountKey(account: { id: string; provider: string }): string;
export function groupAccounts<T extends MonitoringSource>(sources: T[]): MonitoringAccount<T>[];
export function attentionCount(sources: MonitoringSource[], now?: number): number;
