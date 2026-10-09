/** Pure resource display/validation contract shared by Web and Desktop. */
const MAX_METRICS = 32;
const MAX_VALUE = Number.MAX_SAFE_INTEGER;
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
const validText = (value, limit, empty = false) => typeof value === 'string' && (empty || value.trim().length > 0) && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
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
function validateValues(raw, definitions) {
  if (!object(raw) || Object.keys(raw).some(key => !Object.hasOwn(definitions, key))) throw new Error('Unknown metric');
  return Object.fromEntries(Object.entries(definitions).map(([key, definition]) => {
    const value = raw[key] ?? null;
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_VALUE || value < (definition.min ?? -MAX_VALUE) || value > (definition.max ?? MAX_VALUE))) throw new Error(`Invalid ${key}`);
    return [key, value];
  }));
}
function sameMeaning(a, b) {
  return Boolean(a && b && a.unit === b.unit && a.display === b.display && a.min === b.min && a.max === b.max);
}
function canExtendDefinitions(before, after) {
  return Object.keys(before).every(key => Object.hasOwn(after, key) && sameMeaning(before[key], after[key]));
}
function definitionsFor(source) {
  if (source.kind === 'resource') return source.metricDefinitions;
  return Object.fromEntries((PRESETS[source.kind] || []).map(key => [key, {
    ...BUILTIN_METRICS[key],
    label: key === 'memoryPercent' && source.memoryType === 'unified' ? 'Unified memory' : BUILTIN_METRICS[key].label
  }]));
}
function selectionKey(source, key) {
  return source.kind === 'resource' ? `resource:${encodeURIComponent(source.sourceId)}:${key}` : key;
}
function metricCatalog(sources) {
  const result = {};
  for (const source of sources) {
    for (const [key, definition] of Object.entries(definitionsFor(source))) {
      result[selectionKey(source, key)] = source.kind === 'resource'
        ? { ...definition, label: `${source.displayName} · ${definition.label}` }
        : BUILTIN_METRICS[key];
    }
  }
  return result;
}
module.exports = { MAX_METRICS, MAX_VALUE, BUILTIN_METRICS, validText, validMetricKey, validateDefinitions, validateValues, sameMeaning, canExtendDefinitions, definitionsFor, selectionKey, metricCatalog };
