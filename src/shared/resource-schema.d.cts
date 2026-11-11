export interface MetricDefinition { label: string; unit: string; display: 'number' | 'gauge'; min?: number; max?: number }
export type MetricDefinitions = Record<string, MetricDefinition>;
export interface ResourceDisplay { sourceId: string; kind: string; displayName: string; memoryType?: string | null; metricDefinitions?: MetricDefinitions; metricOrder?: string[]; agent?: { usageWeekModel?: number } | null; metrics?: Record<string, number | null> }
export const MAX_METRICS: number;
export const MAX_VALUE: number;
export const AGENT_TEXT_LIMITS: Readonly<Record<'state' | 'character' | 'project' | 'tool' | 'model' | 'usageWeekModelLabel', number>>;
export function validPercentage(value: unknown): value is number;
export const BUILTIN_METRICS: MetricDefinitions;
export const AGENT_DISPLAY_METRICS: readonly ['contextPercent', 'usageSessionPercent', 'usageWeekPercent', 'usageWeekModel'];
export type AgentDisplayMetric = typeof AGENT_DISPLAY_METRICS[number];
export const WEEKLY_MODEL_METRIC: MetricDefinition;
export function agentMetricOrder(value: unknown): AgentDisplayMetric[];
export function displayDefinitions(source: ResourceDisplay): MetricDefinitions;
export function displayValue(source: ResourceDisplay, key: string): number | null;
export function validText(value: unknown, limit: number, empty?: boolean): value is string;
export function validMetricKey(key: string): boolean;
export function validateDefinitions(value: unknown): MetricDefinitions;
export function validateValues(value: unknown, definitions: MetricDefinitions, enforceBounds?: boolean): Record<string, number | null>;
export function validateOrder(value: unknown, definitions: MetricDefinitions): string[];
export function sameMeaning(a?: MetricDefinition, b?: MetricDefinition): boolean;
export function canExtendDefinitions(before: MetricDefinitions, after: MetricDefinitions): boolean;
export function definitionsFor(source: ResourceDisplay): MetricDefinitions;
export function selectionKey(source: ResourceDisplay, metric: string): string;
export function metricCatalog(sources: ResourceDisplay[]): MetricDefinitions;
export function mergeMean(previous: number, previousCount: number, value: number, count?: number): number;
