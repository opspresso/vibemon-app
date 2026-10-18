const { readJsonResponse } = require('../shared/json-response.cjs');
const { EventEmitter } = require('events');
const { URL, URLSearchParams } = require('node:url');
const { METRICS, validId, validAccountId, accountId, groupAccounts, webOrigin, validateSources, validateTrend, validateDefinitions, validateOrder, displayMetrics, metricCatalog } = require('./domain.cjs');
const { CLOUD_POLL_MS, CLOUD_REQUEST_TIMEOUT_MS, CLOUD_TREND_MS, CLOUD_MAX_RESPONSE_BYTES, CLOUD_MAX_ETAG_LENGTH } = require('../shared/constants.cjs');
const { sourceStale, sourceState, accountActivity, needsAttention, attentionCount } = require('../shared/monitoring/state.cjs');
const { snapshotClock } = require('../shared/monitoring/clock.cjs');
const { t } = require('../shared/i18n/locale.cjs');
const { isApiToken, revokeApiToken } = require('../shared/api-token.cjs');

const DEFAULT_WEB_URL = 'https://vibemon.io';
// Web rejected the saved token. Repeating the request cannot succeed until the token changes.
const REJECTED = new Set(['token-expired', 'permission-denied']);
// An ETag that can be sent back unchanged as an If-None-Match header value.
const ENTITY_TAG = /^(W\/)?"[\x21\x23-\x7e]*"$/;
function entityTag(value) {
  return typeof value === 'string' && value.length <= CLOUD_MAX_ETAG_LENGTH && ENTITY_TAG.test(value) ? value : null;
}

class MonitoringClient extends EventEmitter {
  constructor({ preferences, credentials, fetchImpl = fetch, allowLocalHttp = false, now = Date.now, monotonicNow = () => globalThis.performance.now() }) {
    super();
    this.preferences = preferences;
    // Before selection version 2, saving Customize view froze the lists even
    // when every item was chosen, hiding accounts created later. A frozen list
    // cannot be told apart from a deliberate subset, so it resets to all once.
    if (preferences.get('selectionVersion') !== 2) {
      for (const key of ['selectedAccounts', 'selectedSources', 'selectedMetrics']) preferences.delete(key);
      preferences.set('selectionVersion', 2);
    }
    this.credentials = credentials;
    this.fetch = fetchImpl;
    this.allowLocalHttp = allowLocalHttp;
    this.now = now;
    this.monotonicNow = monotonicNow;
    this.reportClock = null;
    this.sources = [];
    this.catalog = [];
    this.accountCatalog = [];
    this.status = 'not-configured';
    this.generation = 0;
    this.configurationAttempt = 0;
    this.inflight = null;
    this.inflightDiscovery = false;
    this.lastSyncedAt = null;
    this.timer = null;
    // The last 200 source list for one origin, token and query, and its ETag.
    this.conditional = null;
  }
  getStatus() { return this.status; }
  /** The saved Web address, or the public service before one is saved. */
  savedUrl() { return this.preferences.get('url') || DEFAULT_WEB_URL; }
  /** The saved Web address as a checked origin; throws when it is not allowed here. */
  savedOrigin() { return webOrigin(this.savedUrl(), this.allowLocalHttp); }
  currentTime() { return this.reportClock ? this.reportClock() : this.now(); }
  snapshot() {
    const now = this.currentTime();
    const selectedSources = this.preferences.get('selectedSources') ?? null;
    const selectedAccounts = this.preferences.get('selectedAccounts') ?? null;
    const selected = this.sources.filter(source => source.kind === 'agent'
      ? selectedAccounts === null || selectedAccounts.includes(accountId(source.account))
      : selectedSources === null || selectedSources.includes(source.sourceId));
    const sources = selected.map(source => {
      const displayState = sourceState(source, now);
      return { ...source, displayMetrics: displayMetrics(source, now), stale: sourceStale(source, now), displayState, needsAttention: needsAttention(displayState) };
    });
    const catalogMetrics = metricCatalog(this.catalog);
    const savedMetrics = this.preferences.get('selectedMetrics');
    const selectedMetrics = savedMetrics === undefined || savedMetrics === null ? Object.keys(catalogMetrics) : [...new Set([
      ...savedMetrics.filter(key => Object.hasOwn(catalogMetrics, key)),
      ...this.catalog.filter(source => ['host', 'cluster'].includes(source.kind) && source.metricDefinitions)
        .flatMap(source => displayMetrics(source).filter(metric => savedMetrics.includes(metric.key)).map(metric => metric.selectionKey))
    ])];
    return {
      url: this.savedUrl(),
      tokenConfigured: this.credentials.has(), status: this.status,
      lastSyncedAt: this.lastSyncedAt, connectionRevision: this.generation,
      evaluatedAt: now,
      selectedSources, selectedAccounts, accountCatalog: this.accountCatalog,
      accounts: groupAccounts(sources).map(account => {
        const { state: displayState, project: displayProject } = accountActivity(account, now);
        return { ...account, displayState, displayProject, needsAttention: needsAttention(displayState) };
      }),
      attentionCount: attentionCount(sources, now),
      selectedMetrics,
      metrics: catalogMetrics, trendRefreshMs: CLOUD_TREND_MS, catalog: this.catalog, sources
    };
  }
  async configure({ url, token }) {
    const origin = webOrigin(url, this.allowLocalHttp);
    if (typeof token !== 'string' || (token && !isApiToken(token))) throw new Error(t('error.readTokenFormat'));
    if (origin !== this.preferences.get('url') && !token && this.credentials.has()) throw new Error(t('error.tokenForNewAddress'));
    const candidate = token || this.credentials.get();
    const attempt = ++this.configurationAttempt;
    const data = await this.requestWith(origin, candidate, '/api/v1/sources');
    const sources = validateSources(data.sources);
    const clock = snapshotClock(data.serverTime, this.monotonicNow);
    if (attempt !== this.configurationAttempt) throw new Error(t('error.connectionChanged'));
    const replaced = token ? this.savedCredential() : null;
    if (token) this.credentials.set(token, origin);
    else this.preferences.set('url', origin);
    // The replaced token has no other holder on this device. Web keeps it valid until it is deleted.
    if (replaced && replaced.token !== token) revokeApiToken(this.fetch, replaced.origin, replaced.token);
    this.generation++;
    this.conditional = null;
    this.sources = sources;
    this.reportClock = clock;
    this.catalog = sources.map(source => this.catalogEntry(source));
    this.accountCatalog = groupAccounts(sources).map(({ accountId, displayName, provider }) => ({ accountId, displayName, provider }));
    this.lastSyncedAt = new Date(this.now()).toISOString();
    this.status = 'connected';
    const snapshot = this.snapshot();
    this.emit('change', snapshot);
    return snapshot;
  }
  /**
   * Removes the connection on this device, then deletes its token on Web.
   * `tokenDeleted` is false when Web could not delete it (for example offline);
   * the token then stays valid until it is deleted on Web Account.
   */
  async disconnect() {
    this.configurationAttempt++;
    this.generation++;
    const saved = this.credentials.has();
    const credential = this.savedCredential();
    this.credentials.clear();
    this.conditional = null;
    this.sources = [];
    this.catalog = [];
    this.accountCatalog = [];
    this.lastSyncedAt = null;
    this.reportClock = null;
    this.status = 'not-configured';
    const snapshot = this.snapshot();
    this.emit('change', snapshot);
    // A saved token that cannot be read cannot be deleted on Web either.
    return { ...snapshot, tokenDeleted: credential ? await revokeApiToken(this.fetch, credential.origin, credential.token) : !saved };
  }
  /** The saved token and its origin, or null when none is saved or either cannot be used. */
  savedCredential() {
    try {
      const token = this.credentials.get();
      return token ? { token, origin: this.savedOrigin() } : null;
    } catch {
      return null;
    }
  }
  async select({ sources, accounts = null, metrics }) {
    if (accounts !== null && (!Array.isArray(accounts) || accounts.length > 100 || !accounts.every(validAccountId))) throw new Error('Invalid account selection');
    if (sources !== null && (!Array.isArray(sources) || sources.length > 100 || !sources.every(validId))) throw new Error('Invalid source selection');
    const available = metricCatalog(this.catalog);
    if (!Array.isArray(metrics) || metrics.length > 4096 || metrics.some(key => typeof key !== 'string' || !Object.hasOwn(available, key))) throw new Error('Invalid metric selection');
    // Choosing every available item means "all": accounts, resources and
    // metrics that appear later are followed instead of silently excluded.
    const chosen = (values, available) => values === null || (available.length > 0 && available.every(value => values.includes(value))) ? null : [...new Set(values)];
    this.preferences.set('selectedAccounts', chosen(accounts, this.accountCatalog.map(account => account.accountId)));
    this.preferences.set('selectedSources', chosen(sources, this.catalog.filter(source => source.kind !== 'agent').map(source => source.sourceId)));
    this.preferences.set('selectedMetrics', chosen(metrics, Object.keys(available)));
    if (this.inflight) await this.inflight;
    return this.poll();
  }
  async request(path) {
    const origin = this.savedOrigin();
    return this.requestWith(origin, this.credentials.get(), path);
  }
  async requestWith(origin, token, path) {
    return this.readResponse(await this.send(origin, token, path));
  }
  async send(origin, token, path, etag = null) {
    if (!token) throw Object.assign(new Error('Configure a read token'), { code: 'not-configured' });
    try {
      return await this.fetch(`${origin}${path}`, {
        headers: { Authorization: `Bearer ${token}`, ...(etag ? { 'If-None-Match': etag } : {}) }, redirect: 'error',
        signal: AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS)
      });
    } catch { throw Object.assign(new Error('Cannot reach Web'), { code: 'connection-error' }); }
  }
  readResponse(response) {
    if (!response.ok) throw Object.assign(new Error('Web request failed'), { code: response.status === 401 ? 'token-expired' : response.status === 403 ? 'permission-denied' : 'connection-error' });
    return readJsonResponse(response, CLOUD_MAX_RESPONSE_BYTES);
  }
  /**
   * Requests the source list, conditional on the last 200 response for the
   * same origin, token and query. A 304 reuses those sources with the time in
   * X-Server-Time. Any failure forgets the cached response, so the next
   * request is unconditional.
   */
  async requestSources(path) {
    const origin = this.savedOrigin();
    const token = this.credentials.get();
    const key = JSON.stringify([origin, token, path]);
    const cached = this.conditional?.key === key ? this.conditional : null;
    this.conditional = null;
    const response = await this.send(origin, token, path, cached?.etag);
    if (response.status === 304) {
      if (!cached) throw Object.assign(new Error('Unexpected not-modified response'), { code: 'connection-error' });
      return { key, etag: cached.etag, sources: cached.sources, clock: snapshotClock(response.headers?.get('X-Server-Time'), this.monotonicNow) };
    }
    const data = await this.readResponse(response);
    const sources = validateSources(data.sources);
    return { key, etag: entityTag(response.headers?.get('ETag')), sources, clock: snapshotClock(data.serverTime, this.monotonicNow) };
  }
  poll(discover = false) {
    if (this.inflight) {
      if (discover && !this.inflightDiscovery) {
        const generation = this.generation;
        // A selected-source poll cannot satisfy a request for the full catalog.
        return this.inflight.then(() => generation === this.generation ? this.poll(true) : this.snapshot());
      }
      return this.inflight;
    }
    this.inflightDiscovery = discover;
    this.inflight = this.fetchSources(discover).finally(() => { this.inflight = null; this.inflightDiscovery = false; });
    return this.inflight;
  }
  async fetchSources(discover) {
    const generation = this.generation;
    try {
      const selected = this.preferences.get('selectedSources') ?? null;
      const selectedAccounts = this.preferences.get('selectedAccounts') ?? null;
      const all = selected === null && selectedAccounts === null;
      const ids = selected ?? this.catalog.filter(source => source.kind !== 'agent').map(source => source.sourceId);
      const accountIds = selectedAccounts ?? this.accountCatalog.map(account => account.accountId);
      if (!discover && !all && ids.length === 0 && accountIds.length === 0) {
        this.sources = [];
        // No request was made: keep the last connection result, including errors.
        if (!this.credentials.has()) this.status = 'not-configured';
      } else {
        if (!this.lastSyncedAt && this.credentials.has() && this.status !== 'connecting') {
          this.status = 'connecting';
          this.emit('change', this.snapshot());
        }
        const parts = [];
        if (ids.length) parts.push(`ids=${encodeURIComponent(ids.join(','))}`);
        if (accountIds.length) parts.push(`accounts=${encodeURIComponent(accountIds.join(','))}`);
        const query = !discover && !all ? `?${parts.join('&')}` : '';
        const { key, etag, sources, clock } = await this.requestSources(`/api/v1/sources${query}`);
        if (generation === this.generation) {
          this.conditional = etag ? { key, etag, sources } : null;
          this.sources = sources;
          this.reportClock = clock;
          if (discover || all) {
            this.catalog = sources.map(source => this.catalogEntry(source));
            this.accountCatalog = groupAccounts(sources).map(({ accountId, displayName, provider }) => ({ accountId, displayName, provider }));
          }
          if (!discover && !all) {
            const updates = new Map(sources.map(source => [source.sourceId, this.catalogEntry(source)]));
            this.catalog = this.catalog.map(source => updates.get(source.sourceId) || source);
            const accountUpdates = new Map(groupAccounts(sources).map(({ accountId, displayName, provider }) => [accountId, { accountId, displayName, provider }]));
            this.accountCatalog = this.accountCatalog.map(account => accountUpdates.get(account.accountId) || account);
          }
          this.status = 'connected';
          this.lastSyncedAt = new Date(this.now()).toISOString();
        }
      }
    } catch (error) {
      this.conditional = null;
      if (generation === this.generation) this.status = error.code || 'connection-error';
    }
    // Every completed poll is a clock step: listeners re-evaluate staleness even when the data did not change.
    const snapshot = this.snapshot();
    this.emit('change', snapshot);
    return snapshot;
  }
  catalogEntry(source) {
    return { sourceId: source.sourceId, displayName: source.displayName, kind: source.kind,
      ...(source.metricDefinitions ? { resourceType: source.resourceType, metricDefinitions: source.metricDefinitions, metricOrder: source.metricOrder } : {}) };
  }
  async removalUrl(target) {
    const generation = this.generation;
    const account = target?.kind === 'account';
    if (!target || !['source', 'account'].includes(target.kind) || !(account ? validAccountId(target.id) : validId(target.id))) throw new Error('Invalid removal target');
    const present = account ? this.accountCatalog.some(item => item.accountId === target.id)
      : this.catalog.some(item => item.sourceId === target.id && item.kind !== 'agent');
    if (!present) throw new Error(t('error.removalMissing'));
    const origin = this.savedOrigin();
    const connection = await this.request('/api/v1/connection?scope=read');
    if (generation !== this.generation) throw new Error(t('error.connectionChanged'));
    if (connection.connected !== true || connection.scope !== 'read' || !validId(connection.ownerId)) throw new Error(t('error.removalUpgrade'));
    const url = new URL('/dashboard', origin);
    url.search = new URLSearchParams({ view: account ? 'agents' : 'resources', remove: target.kind, id: target.id, owner: connection.ownerId }).toString();
    return url.href;
  }
  async trend(target) {
    const generation = this.generation;
    const sourceId = typeof target === 'string' ? target : target?.id;
    const account = typeof target === 'object' && target?.kind === 'account';
    if (!(account ? validAccountId(sourceId) : validId(sourceId))) throw new Error('Invalid source ID');
    const data = await this.request(`/api/v1/${account ? 'accounts' : 'sources'}/${encodeURIComponent(sourceId)}/trend?hours=1`);
    if (generation !== this.generation) throw new Error(t('error.historyChanged'));
    const definitions = data.metricDefinitions === undefined ? METRICS : validateDefinitions(data.metricDefinitions);
    const points = validateTrend(data.points, definitions);
    const metrics = data.metricDefinitions === undefined
      ? Object.entries(definitions).map(([key, definition]) => ({ ...definition, key, selectionKey: key }))
      : displayMetrics({ sourceId, kind: 'resource', metricDefinitions: definitions, metricOrder: validateOrder(data.metricOrder, definitions) });
    return { points, displayMetrics: metrics };
  }
  /**
   * Polls now and every CLOUD_POLL_MS. Scheduled polls pause while no token is
   * saved or Web rejected the saved one; configure(), select() and a manual
   * refresh still poll and resume the schedule when they succeed.
   */
  start() {
    if (this.timer) return;
    this.poll(true);
    this.timer = setInterval(() => {
      if (this.credentials.has() && !REJECTED.has(this.status)) this.poll();
    }, CLOUD_POLL_MS);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.configurationAttempt++;
    this.generation++;
    this.conditional = null;
  }
}
module.exports = { MonitoringClient };
