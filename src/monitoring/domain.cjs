const { webOrigin } = require('../shared/web-origin.cjs');
const { t } = require('../shared/i18n/locale.cjs');
const { usageResetAt } = require('../shared/monitoring/clock.cjs');
const { accountKey: accountId, groupAccounts } = require('../shared/monitoring/state.cjs');
const { BUILTIN_METRICS: METRICS, AGENT_TEXT_LIMITS, validPercentage, validateDefinitions, validateValues, validateOrder, validText, definitionsFor, selectionKey, metricCatalog } = require('../shared/resource-schema.cjs');
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(id);
// Web's usage connection and sign-in IDs are UUIDs.
const validUuid = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const USAGE_STATUSES = ['ready', 'rate-limited', 'reconnect-required', 'unavailable'];
const validPlan = plan => plan === null || validText(plan, 40);
function metrics(value, definitions = METRICS) {
  // Edited display ranges do not invalidate measurements outside the visible gauge.
  return validateValues(value, definitions, definitions === METRICS);
}
// Agent plan usage metrics also carry `resetAt`, the report-clock time at which they reset.
function displayMetrics(source, now) {
  return Object.entries(definitionsFor(source)).map(([key, definition]) => {
    const resetAt = source.agent ? usageResetAt(key, source.agent, source.observedAt, now) : null;
    return { ...definition, key, selectionKey: selectionKey(source, key), ...(resetAt === null ? {} : { resetAt }) };
  });
}
function validTime(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function validateSources(value) {
  if (!Array.isArray(value) || value.length > 1000) throw new Error(t('error.invalidSourceResponse'));
  const ids = new Set();
  return value.map(source => {
    if (!source || !validId(source.sourceId) || ids.has(source.sourceId) || !['agent', 'host', 'cluster', 'resource'].includes(source.kind) || !validText(source.displayName, 128) || !validTime(source.receivedAt) || !validTime(source.observedAt) || !['ok', 'warning', 'error', 'unknown'].includes(source.health) || typeof source.stale !== 'boolean' || (source.heartbeat !== undefined && typeof source.heartbeat !== 'boolean') || (source.memoryType != null && !['ram', 'unified'].includes(source.memoryType))) throw new Error(t('error.invalidSourceResponse'));
    ids.add(source.sourceId);
    let resource = {};
    if (source.kind === 'resource' || source.metricDefinitions !== undefined) {
      if (!validText(source.resourceType, 64) || (source.statusMessage !== undefined && !validText(source.statusMessage, 160, true)) || source.agent != null || source.account != null) throw new Error(t('error.invalidCustomResponse'));
      const metricDefinitions = validateDefinitions(source.metricDefinitions);
      resource = { resourceType: source.resourceType, metricDefinitions, metricOrder: validateOrder(source.metricOrder, metricDefinitions), ...(source.statusMessage === undefined ? {} : { statusMessage: source.statusMessage }) };
    }
    let agent = null;
    let account = null;
    if (source.kind === 'agent') {
      if (!source.agent || !['state', 'character', 'project'].every(key => validText(source.agent[key], AGENT_TEXT_LIMITS[key]))) throw new Error(t('error.invalidAgentResponse'));
      if (!source.account || !validAccountId(accountId(source.account)) || !validText(source.account.displayName, 128)) throw new Error(t('error.invalidAccountResponse'));
      agent = Object.fromEntries(['state', 'character', 'project'].map(key => [key, source.agent[key]]));
      for (const key of ['tool', 'model', 'usageWeekModelLabel']) {
        const text = source.agent[key];
        if (text !== undefined && !validText(text, AGENT_TEXT_LIMITS[key], true)) throw new Error(t('error.invalidAgentResponse'));
        if (text !== undefined) agent[key] = text;
      }
      for (const key of ['usage5hResetsIn', 'usageWeekResetsIn', 'usageWeekModelResetsIn', 'usageWeekModel']) {
        const number = source.agent[key];
        if (number !== undefined && (key === 'usageWeekModel' ? !validPercentage(number) : !Number.isSafeInteger(number) || number < 0)) throw new Error(t('error.invalidAgentResponse'));
        if (number !== undefined) agent[key] = number;
      }
      account = { id: source.account.id, provider: source.account.provider, displayName: source.account.displayName };
      // The connected service that reads this account's plan usage (Web's `account.connection`).
      // It only decorates the account: a value this version cannot read, such
      // as a newer status, is left out and never rejects the sources.
      const connection = source.account.connection;
      if (connection && validUuid(connection.id) && USAGE_STATUSES.includes(connection.status) && validPlan(connection.plan ?? null)) {
        account.connection = { id: connection.id, status: connection.status, plan: connection.plan ?? null };
      }
    }
    return { sourceId: source.sourceId, kind: source.kind, displayName: source.displayName, receivedAt: source.receivedAt, observedAt: source.observedAt, health: source.health, stale: source.stale, heartbeat: source.heartbeat === true, memoryType: source.memoryType ?? null, metrics: metrics(source.metrics, resource.metricDefinitions), agent, account, ...resource };
  });
}
function validateTrend(value, definitions = METRICS) {
  if (!Array.isArray(value) || value.length > 61) throw new Error(t('error.invalidTrendResponse'));
  let previous = -Infinity;
  return value.map(point => {
    if (!point || !validTime(point.timestamp) || Date.parse(point.timestamp) <= previous || !Number.isSafeInteger(point.samples) || point.samples < 1 || !Number.isFinite(point.expiresAt) || point.expiresAt < 0) throw new Error(t('error.invalidTrendResponse'));
    previous = Date.parse(point.timestamp);
    const average = metrics(point.average, definitions);
    const maximum = metrics(point.maximum, definitions);
    for (const key of Object.keys(definitions)) if ((average[key] === null) !== (maximum[key] === null) || (average[key] !== null && maximum[key] < average[key])) throw new Error(t('error.invalidTrendResponse'));
    return { timestamp: point.timestamp, samples: point.samples, expiresAt: point.expiresAt, average, maximum };
  });
}

function validAccountId(value) {
  if (typeof value !== 'string') return false;
  const separator = value.indexOf(':');
  return separator > 0 && /^[a-z][a-z0-9_-]{0,31}$/.test(value.slice(0, separator)) && validId(value.slice(separator + 1));
}
module.exports = {
  METRICS, validId, validUuid, validPlan, USAGE_STATUSES, validAccountId, accountId, groupAccounts, webOrigin,
  validateSources, validateTrend, validateDefinitions, validateOrder, displayMetrics, metricCatalog
};
