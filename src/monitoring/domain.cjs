const { URL } = require('node:url');
const { BUILTIN_METRICS: METRICS, validateDefinitions, validateValues, validateOrder, validText, definitionsFor, selectionKey, metricCatalog } = require('../shared/resource-schema.cjs');
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(id);
function webOrigin(value, allowLocalHttp = false) {
  const url = new URL(value);
  const local = allowLocalHttp && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use an HTTPS Web origin without a path or credentials');
  }
  return url.origin;
}
function metrics(value, definitions = METRICS) {
  // Edited display ranges do not invalidate measurements outside the visible gauge.
  return validateValues(value, definitions, definitions === METRICS);
}
function displayMetrics(source) {
  return Object.entries(definitionsFor(source)).map(([key, definition]) => ({ ...definition, key, selectionKey: selectionKey(source, key) }));
}
function validTime(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function validateSources(value) {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('Invalid source response');
  const ids = new Set();
  return value.map(source => {
    if (!source || !validId(source.sourceId) || ids.has(source.sourceId) || !['agent', 'host', 'cluster', 'resource'].includes(source.kind) || typeof source.displayName !== 'string' || !source.displayName.trim() || source.displayName.length > 128 || !validTime(source.receivedAt) || !validTime(source.observedAt) || !['ok', 'warning', 'error', 'unknown'].includes(source.health) || typeof source.stale !== 'boolean' || (source.memoryType != null && !['ram', 'unified'].includes(source.memoryType))) throw new Error('Invalid source response');
    ids.add(source.sourceId);
    let resource = {};
    if (source.kind === 'resource' || source.metricDefinitions !== undefined) {
      if (!validText(source.resourceType, 64) || (source.statusMessage !== undefined && !validText(source.statusMessage, 160, true)) || source.agent != null || source.account != null) throw new Error('Invalid custom resource response');
      const metricDefinitions = validateDefinitions(source.metricDefinitions);
      resource = { resourceType: source.resourceType, metricDefinitions, metricOrder: validateOrder(source.metricOrder, metricDefinitions), ...(source.statusMessage === undefined ? {} : { statusMessage: source.statusMessage }) };
    }
    let agent = null;
    let account = null;
    if (source.kind === 'agent') {
      if (!source.agent || !['state', 'character', 'project'].every(key => typeof source.agent[key] === 'string' && source.agent[key].length > 0 && source.agent[key].length <= 256)) throw new Error('Invalid agent response');
      if (!source.account || !validAccountId(accountId(source.account)) || typeof source.account.displayName !== 'string' || !source.account.displayName.trim() || source.account.displayName.length > 128) throw new Error('Invalid account response');
      agent = Object.fromEntries(['state', 'character', 'project'].map(key => [key, source.agent[key]]));
      for (const key of ['tool', 'model', 'usageWeekModelLabel']) {
        const text = source.agent[key];
        if (text !== undefined && (typeof text !== 'string' || text.length > 128)) throw new Error('Invalid agent response');
        if (text !== undefined) agent[key] = text;
      }
      for (const key of ['usage5hResetsIn', 'usageWeekResetsIn', 'usageWeekModelResetsIn', 'usageWeekModel']) {
        const number = source.agent[key];
        if (number !== undefined && (!Number.isSafeInteger(number) || number < 0 || (key === 'usageWeekModel' && number > 100))) throw new Error('Invalid agent response');
        if (number !== undefined) agent[key] = number;
      }
      account = { id: source.account.id, provider: source.account.provider, displayName: source.account.displayName };
    }
    return { sourceId: source.sourceId, kind: source.kind, displayName: source.displayName, receivedAt: source.receivedAt, observedAt: source.observedAt, health: source.health, stale: source.stale, memoryType: source.memoryType ?? null, metrics: metrics(source.metrics, resource.metricDefinitions), agent, account, ...resource };
  });
}
function validateTrend(value, definitions = METRICS) {
  if (!Array.isArray(value) || value.length > 61) throw new Error('Invalid trend response');
  let previous = -Infinity;
  return value.map(point => {
    if (!point || !validTime(point.timestamp) || Date.parse(point.timestamp) <= previous || !Number.isSafeInteger(point.samples) || point.samples < 1 || !Number.isFinite(point.expiresAt) || point.expiresAt < 0) throw new Error('Invalid trend response');
    previous = Date.parse(point.timestamp);
    const average = metrics(point.average, definitions);
    const maximum = metrics(point.maximum, definitions);
    for (const key of Object.keys(definitions)) if ((average[key] === null) !== (maximum[key] === null) || (average[key] !== null && maximum[key] < average[key])) throw new Error('Invalid trend response');
    return { timestamp: point.timestamp, samples: point.samples, expiresAt: point.expiresAt, average, maximum };
  });
}
module.exports = { METRICS, validId, webOrigin, validateSources, validateTrend, validateDefinitions, validateOrder, displayMetrics, metricCatalog };

function accountId(account) { return `${account.provider}:${account.id}`; }
function validAccountId(value) {
  if (typeof value !== 'string') return false;
  const separator = value.indexOf(':');
  return separator > 0 && /^[a-z][a-z0-9_-]{0,31}$/.test(value.slice(0, separator)) && validId(value.slice(separator + 1));
}
function groupAccounts(sources) {
  const groups = new Map();
  for (const source of sources) {
    if (source.kind !== 'agent' || !source.account) continue;
    const id = accountId(source.account);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(source);
  }
  return [...groups].map(([id, members]) => {
    members.sort((a, b) => b.observedAt.localeCompare(a.observedAt));
    return { accountId: id, ...members[0].account, latest: members[0], sources: members };
  });
}
module.exports.accountId = accountId;
module.exports.validAccountId = validAccountId;
module.exports.groupAccounts = groupAccounts;
