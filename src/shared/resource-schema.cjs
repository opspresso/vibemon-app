/** Pure resource display/validation contract shared by Web and Desktop. */
const MAX_METRICS = 32;
const MAX_VALUE = Number.MAX_SAFE_INTEGER;
const AGENT_TEXT_LIMITS = Object.freeze({ state: 64, character: 64, project: 128, tool: 64, model: 64, usageWeekModelLabel: 64 });
const validPercentage = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const BUILTIN_METRICS = Object.freeze(Object.fromEntries(Object.entries({
  cpuPercent: { label: 'CPU', unit: '%', display: 'gauge', min: 0, max: 100 },
  memoryPercent: { label: 'Memory', unit: '%', display: 'gauge', min: 0, max: 100 },
  gpuPercent: { label: 'GPU', unit: '%', display: 'gauge', min: 0, max: 100 },
  gpuTemperatureC: { label: 'GPU temperature', unit: '°C', display: 'number', min: 0, max: 150 },
  nodesReady: { label: 'Ready nodes', unit: '', display: 'number', min: 0, max: 1000000 },
  nodesTotal: { label: 'Total nodes', unit: '', display: 'number', min: 0, max: 1000000 },
  podsUnhealthy: { label: 'Unhealthy pods', unit: '', display: 'number', min: 0, max: 1000000 },
  contextPercent: { label: 'Context', unit: '%', display: 'gauge', min: 0, max: 100 },
  usageSessionPercent: { label: 'Session usage', unit: '%', display: 'gauge', min: 0, max: 100 },
  usageWeekPercent: { label: 'Weekly usage', unit: '%', display: 'gauge', min: 0, max: 100 }
}).map(([key, value]) => [key, Object.freeze(value)])));
const PRESETS = {
  host: ['cpuPercent', 'memoryPercent', 'gpuPercent', 'gpuTemperatureC'],
  cluster: ['cpuPercent', 'memoryPercent', 'nodesReady', 'nodesTotal', 'podsUnhealthy'],
  agent: ['contextPercent', 'usageSessionPercent', 'usageWeekPercent']
};
// The metrics that an agent account shows, in their default order. Account
// cards, details, and widgets use this order; widgets show the first three.
// `usageWeekModel` is the weekly usage of one model family, such as Fable. It
// is not a reported metric: its value is `agent.usageWeekModel`, and it is
// shown only while the agent reports it. Web stores each account's order and
// sends it as the agent source's `metricOrder` (see agentMetricOrder).
const AGENT_DISPLAY_METRICS = Object.freeze(['contextPercent', 'usageSessionPercent', 'usageWeekPercent', 'usageWeekModel']);
const WEEKLY_MODEL_METRIC = Object.freeze({ label: 'Weekly model', unit: '%', display: 'gauge', min: 0, max: 100 });
const MAX_AGENT_METRIC_ORDER = 16;
const validText = (value, limit, empty = false) => typeof value === 'string' && (empty || value.trim().length > 0) && value.length <= limit && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value);
const validMetricKey = key => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) && !['constructor', 'prototype', '__proto__'].includes(key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validateDefinitions(raw) {
  if (!object(raw) || Object.keys(raw).length > MAX_METRICS) throw new Error(`Define at most ${MAX_METRICS} metrics`);
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => {
    if (!validMetricKey(key) || !object(value) || Object.keys(value).some(field => !['label', 'unit', 'display', 'min', 'max'].includes(field))) throw new Error('Invalid metric definition');
    if (!validText(value.label, 80) || !validText(value.unit, 16, true) || !['number', 'gauge'].includes(value.display)) throw new Error(`Invalid definition for ${key}`);
    const result = { label: value.label.trim(), unit: value.unit.trim(), display: value.display };
    for (const bound of ['min', 'max']) {
      if (value[bound] !== undefined) {
        if (typeof value[bound] !== 'number' || !Number.isFinite(value[bound]) || Math.abs(value[bound]) > MAX_VALUE) throw new Error(`Invalid ${bound} for ${key}`);
        result[bound] = value[bound];
      }
    }
    if (result.display === 'gauge' && (result.min === undefined || result.max === undefined)) throw new Error(`Gauge ${key} needs min and max`);
    if (result.min !== undefined && result.max !== undefined && result.min >= result.max) throw new Error(`Invalid range for ${key}`);
    return [key, result];
  }));
}
function validateValues(raw, definitions, enforceBounds = true) {
  if (!object(raw) || Object.keys(raw).some(key => !Object.hasOwn(definitions, key))) throw new Error('Unknown metric');
  return Object.fromEntries(Object.entries(definitions).map(([key, definition]) => {
    const value = raw[key] ?? null;
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_VALUE || (enforceBounds && (value < (definition.min ?? -MAX_VALUE) || value > (definition.max ?? MAX_VALUE))))) throw new Error(`Invalid ${key}`);
    return [key, value];
  }));
}
function sameMeaning(a, b) {
  return Boolean(a && b && a.unit === b.unit);
}
function canExtendDefinitions(before, after) {
  return Object.keys(before).every(key => Object.hasOwn(after, key) && sameMeaning(before[key], after[key]));
}
function definitionsFor(source) {
  if (source.metricDefinitions && source.kind !== 'agent') {
    return Object.fromEntries(validateOrder(source.metricOrder, source.metricDefinitions).map(key => [key, source.metricDefinitions[key]]));
  }
  return Object.fromEntries((PRESETS[source.kind] || []).map(key => [key, {
    ...BUILTIN_METRICS[key],
    label: key === 'memoryPercent' && source.memoryType === 'unified' ? 'Unified memory' : BUILTIN_METRICS[key].label
  }]));
}
/**
 * The display order of an agent account. Without `metricOrder` it is the
 * default order. Keys that this version does not know and repeated keys are
 * ignored, and known keys that the order leaves out follow in their default
 * order, so a newer Web can add a metric. A value that is not a list of at most
 * 16 strings is invalid.
 */
function agentMetricOrder(value) {
  if (value === undefined) return [...AGENT_DISPLAY_METRICS];
  if (!Array.isArray(value) || value.length > MAX_AGENT_METRIC_ORDER || value.some(key => typeof key !== 'string')) throw new Error('Invalid agent metric order');
  const known = value.filter((key, index) => AGENT_DISPLAY_METRICS.includes(key) && value.indexOf(key) === index);
  return [...known, ...AGENT_DISPLAY_METRICS.filter(key => !known.includes(key))];
}
/** The metrics to display, in order: an agent's in its account order with its weekly model usage while reported, otherwise definitionsFor. */
function displayDefinitions(source) {
  if (source.kind !== 'agent') return definitionsFor(source);
  const preset = definitionsFor(source);
  const model = validPercentage(source.agent?.usageWeekModel);
  return Object.fromEntries(agentMetricOrder(source.metricOrder).flatMap(key => key === 'usageWeekModel'
    ? model ? [[key, WEEKLY_MODEL_METRIC]] : []
    : Object.hasOwn(preset, key) ? [[key, preset[key]]] : []));
}
/** The value of a display metric; the weekly model usage comes from the agent details. */
function displayValue(source, key) {
  if (key === 'usageWeekModel' && source.kind === 'agent') return validPercentage(source.agent?.usageWeekModel) ? source.agent.usageWeekModel : null;
  return source.metrics?.[key] ?? null;
}
function selectionKey(source, key) {
  return source.kind === 'resource' || source.metricDefinitions ? `resource:${encodeURIComponent(source.sourceId)}:${key}` : key;
}
function metricCatalog(sources) {
  const result = {};
  for (const source of sources) {
    // An agent offers every agent display metric, also one that it does not report now.
    const definitions = source.kind === 'agent' ? Object.fromEntries(AGENT_DISPLAY_METRICS.map(key => [key, BUILTIN_METRICS[key] ?? WEEKLY_MODEL_METRIC])) : definitionsFor(source);
    for (const [key, definition] of Object.entries(definitions)) {
      result[selectionKey(source, key)] = source.kind === 'resource' || source.metricDefinitions
        ? { ...definition, label: `${source.displayName} · ${definition.label}` }
        : BUILTIN_METRICS[key] ?? definition;
    }
  }
  return result;
}
function validateOrder(value, definitions) {
  if (value === undefined) return Object.keys(definitions);
  if (!Array.isArray(value) || value.length !== Object.keys(definitions).length || new Set(value).size !== value.length || value.some(key => typeof key !== 'string' || !Object.hasOwn(definitions, key))) throw new Error('Metric order must contain each metric key exactly once');
  return [...value];
}
function mergeMean(previous, previousCount, value, count = 1) {
  if (!previousCount) return value;
  const mean = previous + (value - previous) * (count / (previousCount + count));
  return Math.min(Math.max(previous, value), Math.max(Math.min(previous, value), mean));
}
module.exports = { MAX_METRICS, MAX_VALUE, AGENT_TEXT_LIMITS, BUILTIN_METRICS, AGENT_DISPLAY_METRICS, WEEKLY_MODEL_METRIC, agentMetricOrder, displayDefinitions, displayValue, validPercentage, validText, validMetricKey, validateDefinitions, validateValues, validateOrder, sameMeaning, canExtendDefinitions, definitionsFor, selectionKey, metricCatalog, mergeMean };
