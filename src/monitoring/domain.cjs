const { URL } = require('node:url');
const METRICS = Object.freeze({
  cpuPercent: { label: 'CPU', unit: '%' },
  memoryPercent: { label: 'RAM', unit: '%' },
  gpuPercent: { label: 'GPU', unit: '%' },
  gpuTemperatureC: { label: 'GPU temperature', unit: '°C' },
  nodesReady: { label: 'Ready nodes', unit: '' },
  nodesTotal: { label: 'Total nodes', unit: '' },
  podsUnhealthy: { label: 'Unhealthy pods', unit: '' },
  contextPercent: { label: 'Agent context', unit: '%' },
  usageSessionPercent: { label: 'Session usage', unit: '%' },
  usageWeekPercent: { label: 'Weekly usage', unit: '%' }
});
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(id);
function webOrigin(value, allowLocalHttp = false) {
  const url = new URL(value);
  const local = allowLocalHttp && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use an HTTPS Web origin without a path or credentials');
  }
  return url.origin;
}
function validateSources(value) {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('Invalid source response');
  return value.map(source => {
    if (!source || !validId(source.sourceId) || !['agent', 'host', 'cluster'].includes(source.kind) || typeof source.displayName !== 'string' || source.displayName.length > 128 || !Number.isFinite(Date.parse(source.receivedAt)) || !Number.isFinite(Date.parse(source.observedAt)) || !source.metrics) {
      throw new Error('Invalid source response');
    }
    const metrics = {};
    for (const key of Object.keys(METRICS)) {
      const metric = source.metrics[key] ?? null;
      if (metric !== null && (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0 || metric > (key.endsWith('Percent') ? 100 : key === 'gpuTemperatureC' ? 150 : 1000000))) throw new Error('Invalid metric response');
      metrics[key] = metric;
    }
    return { ...source, metrics };
  });
}
module.exports = { METRICS, validId, webOrigin, validateSources };
