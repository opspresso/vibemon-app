export interface MetricDefinition { label: string; unit: string; display: 'number' | 'gauge'; min?: number; max?: number }
export type MetricDefinitions = Record<string, MetricDefinition>;
export interface ResourceDisplay { sourceId: string; kind: string; displayName: string; memoryType?: string | null; metricDefinitions?: MetricDefinitions; metricOrder?: string[] }
export const MAX_METRICS: number;
export const MAX_VALUE: number;
export const BUILTIN_METRICS: MetricDefinitions;
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
