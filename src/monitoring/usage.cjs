/**
 * Connected services: Claude and Codex accounts whose plan usage the VibeMon
 * server reads (Web docs/api/MONITORING.md, "Coding-service usage").
 *
 * The server keeps the service sign-in; this process sends the saved read
 * token and receives normalized readings only. Usage requests never change
 * the dashboard connection status: a rejected usage request is an error of
 * that request, and the source polling keeps its own result.
 */

const { URL } = require('node:url');
const { readJsonResponse } = require('../shared/json-response.cjs');
const { CLOUD_REQUEST_TIMEOUT_MS, CLOUD_MAX_RESPONSE_BYTES, CLOUD_CONNECTION_MAX_RESPONSE_BYTES } = require('../shared/constants.cjs');
const { validText } = require('../shared/resource-schema.cjs');
const { t } = require('../shared/i18n/locale.cjs');
const { validUuid, validPlan, USAGE_STATUSES } = require('./domain.cjs');

const SERVICES = ['claude', 'codex'];
// The only pages a sign-in may open: the service's own sign-in host over HTTPS.
const PROMPT_HOSTS = { claude: 'claude.ai', codex: 'auth.openai.com' };
const MAX_CONNECTIONS = 50;
const MAX_WINDOWS = 16;
// Web's failure codes of usage requests. The renderer translates each one.
const USAGE_CODES = new Set(['usage-authorization-expired', 'usage-authorization-denied', 'usage-authorization-code-invalid', 'usage-provider-unavailable', 'usage-connection-limit']);

const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const invalid = () => Object.assign(new Error('Invalid usage response'), { code: 'usage-invalid-response' });
function optionalTime(value) {
  if (value === null || value === undefined) return null;
  if (!validTime(value)) throw invalid();
  return value;
}

/** A validated connection, or null for a service that this version does not know. */
function validateConnection(value) {
  if (!value || typeof value !== 'object') throw invalid();
  if (!SERVICES.includes(value.provider)) return null;
  if (!validUuid(value.id) || !validText(value.accountId, 160) || !(value.label === null || value.label === undefined || validText(value.label, 160))
    || !validPlan(value.plan ?? null) || !USAGE_STATUSES.includes(value.status) || typeof value.stale !== 'boolean'
    || !validTime(value.refreshableAt) || !Array.isArray(value.windows) || value.windows.length > MAX_WINDOWS) throw invalid();
  const observedAt = optionalTime(value.observedAt);
  const keys = new Set();
  const windows = value.windows.map(window => {
    if (!window || !validText(window.key, 80) || keys.has(window.key) || !['session', 'week'].includes(window.kind)
      || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100
      || !(window.model === null || window.model === undefined || validText(window.model, 64))
      || !(window.durationSeconds === null || window.durationSeconds === undefined || (Number.isSafeInteger(window.durationSeconds) && window.durationSeconds > 0))) throw invalid();
    keys.add(window.key);
    return { key: window.key, kind: window.kind, model: window.model ?? null, usedPercent: window.usedPercent, resetsAt: optionalTime(window.resetsAt) };
  });
  // A reading without its time cannot be shown with an age.
  if (windows.length && observedAt === null) throw invalid();
  return {
    id: value.id, provider: value.provider, accountId: value.accountId, label: value.label ?? null, plan: value.plan ?? null,
    status: value.status, stale: value.stale, observedAt, checkedAt: optionalTime(value.checkedAt), retryAt: optionalTime(value.retryAt),
    refreshableAt: value.refreshableAt, windows
  };
}

function validateUsage(value) {
  if (!value || !Array.isArray(value.providers) || !Array.isArray(value.connections) || value.connections.length > MAX_CONNECTIONS || !validTime(value.serverTime)) throw invalid();
  const ids = new Set();
  const connections = [];
  for (const item of value.connections) {
    if (ids.has(item?.id)) throw invalid();
    ids.add(item?.id);
    const connection = validateConnection(item);
    if (connection) connections.push(connection);
  }
  return { providers: SERVICES.filter(service => value.providers.includes(service)), connections, serverTime: value.serverTime };
}

function validateAuthorization(value) {
  const authorization = value?.authorization;
  if (!authorization || !validUuid(authorization.id) || !SERVICES.includes(authorization.provider) || !validTime(authorization.expiresAt) || !authorization.prompt) throw invalid();
  const { kind, url, userCode, interval } = authorization.prompt;
  let page;
  try { page = new URL(url); } catch { throw invalid(); }
  if (page.protocol !== 'https:' || page.hostname !== PROMPT_HOSTS[authorization.provider] || page.username || page.password || page.port) throw invalid();
  const expected = authorization.provider === 'claude' ? 'code' : 'device';
  if (kind !== expected) throw invalid();
  const prompt = { kind, url: page.href };
  if (kind === 'device') {
    if (!validText(userCode, 32) || !Number.isSafeInteger(interval) || interval < 1 || interval > 60) throw invalid();
    Object.assign(prompt, { userCode, interval });
  }
  return { id: authorization.id, provider: authorization.provider, prompt, expiresAt: authorization.expiresAt };
}

function validateCompletion(value) {
  if (value?.status === 'pending') {
    if (!Number.isSafeInteger(value.interval) || value.interval < 1 || value.interval > 120) throw invalid();
    return { status: 'pending', interval: value.interval };
  }
  if (value?.status === 'connected') {
    const connection = validateConnection(value.connection);
    if (!connection) throw invalid();
    return { status: 'connected', connection };
  }
  throw invalid();
}

class UsageClient {
  /** @param {{ monitoring: import('./client.cjs').MonitoringClient }} options */
  constructor({ monitoring }) {
    this.monitoring = monitoring;
    // Started sign-ins of this connection: the renderer refers to them by ID,
    // so it can open or copy only what Web returned.
    this.authorizations = new Map();
    this.generation = monitoring.generation;
  }

  /**
   * Sends one usage request with the saved read token. `managing` marks the
   * requests that need the token's `usage` permission: Web's 403 without a
   * code then means the token predates that permission, so the person signs in again.
   */
  async send(path, { method = 'GET', body, expect = 200, managing = false } = {}) {
    const monitoring = this.monitoring;
    if (monitoring.generation !== this.generation) {
      this.generation = monitoring.generation;
      this.authorizations.clear();
    }
    const generation = monitoring.generation;
    const token = monitoring.credentials.get();
    if (!token) throw Object.assign(new Error('Configure a read token'), { code: 'not-configured' });
    const origin = monitoring.savedOrigin();
    let response;
    try {
      response = await monitoring.fetch(`${origin}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch {
      throw Object.assign(new Error('Cannot reach VibeMon'), { code: 'connection-error' });
    }
    if (generation !== monitoring.generation) {
      await response.body?.cancel();
      throw new Error(t('error.connectionChanged'));
    }
    if (response.status === expect) {
      if (expect === 204) { await response.body?.cancel(); return null; }
      return readJsonResponse(response, CLOUD_MAX_RESPONSE_BYTES);
    }
    const failure = await readJsonResponse(response, CLOUD_CONNECTION_MAX_RESPONSE_BYTES).catch(() => ({}));
    const code = typeof failure?.code === 'string' ? failure.code : null;
    if (code && USAGE_CODES.has(code)) throw Object.assign(new Error(code), { code });
    if (!code && response.status === 403 && managing) throw Object.assign(new Error('usage-sign-in-required'), { code: 'usage-sign-in-required' });
    throw Object.assign(new Error('VibeMon request failed'), {
      code: response.status === 401 ? 'token-expired' : response.status === 403 ? 'permission-denied' : 'connection-error'
    });
  }

  async list() {
    return validateUsage(await this.send('/api/v1/usage'));
  }

  async start(provider) {
    if (!SERVICES.includes(provider)) throw new Error('Unknown service');
    const authorization = validateAuthorization(await this.send('/api/v1/usage/authorizations', { method: 'POST', body: { provider }, expect: 201, managing: true }));
    this.authorizations.set(authorization.id, authorization);
    return authorization;
  }

  /** Completes a Claude sign-in with the pasted `code`, or polls a Codex sign-in without one. */
  async complete(id, code) {
    const authorization = this.authorization(id);
    if (authorization.prompt.kind === 'code' && !validText(code, 1024)) throw Object.assign(new Error('usage-authorization-code-invalid'), { code: 'usage-authorization-code-invalid' });
    const body = authorization.prompt.kind === 'code' ? { code: code.trim() } : {};
    try {
      const result = validateCompletion(await this.send(`/api/v1/usage/authorizations/${id}`, { method: 'POST', body, managing: true }));
      if (result.status === 'connected') this.authorizations.delete(id);
      return result;
    } catch (error) {
      if (['usage-authorization-expired', 'usage-authorization-denied', 'usage-sign-in-required'].includes(error.code)) this.authorizations.delete(id);
      throw error;
    }
  }

  /** Abandons an unfinished sign-in on the server. */
  async cancel(id) {
    if (!this.authorizations.has(id)) return false;
    this.authorizations.delete(id);
    await this.send(`/api/v1/usage/authorizations/${id}`, { method: 'DELETE', expect: 204, managing: true });
    return true;
  }

  /** Asks the server for a new reading; earlier than `refreshableAt` it returns the current one. */
  async refresh(id) {
    if (!validUuid(id)) throw new Error('Invalid connection ID');
    const connection = validateConnection((await this.send(`/api/v1/usage/connections/${id}`, { method: 'POST', body: {} }))?.connection);
    if (!connection) throw invalid();
    return connection;
  }

  /** Deletes the saved service sign-in and its readings on the server. */
  async disconnect(id) {
    if (!validUuid(id)) throw new Error('Invalid connection ID');
    await this.send(`/api/v1/usage/connections/${id}`, { method: 'DELETE', expect: 204, managing: true });
    return true;
  }

  /** A sign-in that this connection started; the renderer cannot name another. */
  authorization(id) {
    if (this.monitoring.generation !== this.generation || !validUuid(id) || !this.authorizations.has(id)) {
      throw Object.assign(new Error('usage-authorization-expired'), { code: 'usage-authorization-expired' });
    }
    return this.authorizations.get(id);
  }
}

module.exports = { UsageClient, validateUsage, validateConnection, validateAuthorization, validateCompletion, PROMPT_HOSTS };
