const { readJsonResponse } = require('../shared/json-response.cjs');
const { EventEmitter } = require('events');
const { METRICS, validId, validAccountId, accountId, groupAccounts, webOrigin, validateSources, validateTrend, validateDefinitions, validateOrder, displayMetrics, metricCatalog } = require('./domain.cjs');
const { CLOUD_POLL_MS, CLOUD_REQUEST_TIMEOUT_MS, CLOUD_TREND_MS, CLOUD_MAX_RESPONSE_BYTES } = require('../shared/constants.cjs');
const { sourceStale, sourceState, accountActivity, needsAttention, attentionCount } = require('../shared/monitoring/state.cjs');
const { snapshotClock } = require('../shared/monitoring/clock.cjs');

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
  }
  getStatus() { return this.status; }
  hasToken() { return this.credentials.has(); }
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
      url: this.preferences.get('url') || 'https://vibemon.io',
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
    if (typeof token !== 'string' || (token && !/^vm_[a-f0-9]{60}$/.test(token))) throw new Error('Enter a generated read token');
    if (origin !== this.preferences.get('url') && !token && this.credentials.has()) throw new Error('Enter a token when changing the Web address');
    const candidate = token || this.credentials.get();
    const attempt = ++this.configurationAttempt;
    const data = await this.requestWith(origin, candidate, '/api/v1/sources');
    const sources = validateSources(data.sources);
    const clock = snapshotClock(data.serverTime, this.monotonicNow);
    if (attempt !== this.configurationAttempt) throw new Error('The connection changed while checking. Try again');
    if (token) this.credentials.set(token, origin);
    else this.preferences.set('url', origin);
    this.generation++;
    this.sources = sources;
    this.reportClock = clock;
    this.catalog = sources.map(source => this.catalogEntry(source));
    this.accountCatalog = groupAccounts(sources).map(({ accountId, displayName, provider }) => ({ accountId, displayName, provider }));
    this.lastSyncedAt = new Date(this.now()).toISOString();
    this.status = 'connected';
    this.emit('sources', this.snapshot().sources);
    this.emit('change', this.snapshot());
    return this.snapshot();
  }
  /**
   * Removes the connection on this device, then deletes its token on Web.
   * `tokenDeleted` is false when Web could not delete it (for example offline);
   * the token then stays valid until it is deleted on Web Account.
   */
  async disconnect() {
    this.configurationAttempt++;
    this.generation++;
    const origin = this.snapshot().url;
    let token = null;
    try { token = this.credentials.has() ? this.credentials.get() : null; } catch { token = null; }
    this.credentials.clear();
    this.sources = [];
    this.catalog = [];
    this.accountCatalog = [];
    this.lastSyncedAt = null;
    this.reportClock = null;
    this.status = 'not-configured';
    this.emit('sources', []);
    this.emit('change', this.snapshot());
    return { ...this.snapshot(), tokenDeleted: token ? await this.deleteToken(origin, token) : true };
  }
  async deleteToken(origin, token) {
    try {
      const response = await this.fetch(`${origin}/api/v1/connection`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS)
      });
      // A token that Web no longer accepts is already gone.
      return response.status === 204 || response.status === 401;
    } catch {
      return false;
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
    const origin = webOrigin(this.preferences.get('url') || 'https://vibemon.io', this.allowLocalHttp);
    return this.requestWith(origin, this.credentials.get(), path);
  }
  async requestWith(origin, token, path) {
    if (!token) throw Object.assign(new Error('Configure a read token'), { code: 'not-configured' });
    let response;
    try {
      response = await this.fetch(`${origin}${path}`, {
        headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
        signal: AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS)
      });
    } catch { throw Object.assign(new Error('Cannot reach Web'), { code: 'connection-error' }); }
    if (!response.ok) throw Object.assign(new Error('Web request failed'), { code: response.status === 401 ? 'token-expired' : response.status === 403 ? 'permission-denied' : 'connection-error' });
    return readJsonResponse(response, CLOUD_MAX_RESPONSE_BYTES);
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
        this.emit('sources', []);
      } else {
        if (!this.lastSyncedAt && this.credentials.has() && this.status !== 'connecting') {
          this.status = 'connecting';
          this.emit('change', this.snapshot());
        }
        const parts = [];
        if (ids.length) parts.push(`ids=${encodeURIComponent(ids.join(','))}`);
        if (accountIds.length) parts.push(`accounts=${encodeURIComponent(accountIds.join(','))}`);
        const query = !discover && !all ? `?${parts.join('&')}` : '';
        const data = await this.request(`/api/v1/sources${query}`);
        const sources = validateSources(data.sources);
        const clock = snapshotClock(data.serverTime, this.monotonicNow);
        if (generation === this.generation) {
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
          this.emit('sources', this.snapshot().sources);
        }
      }
    } catch (error) {
      if (generation === this.generation) this.status = error.code || 'connection-error';
    } finally {
      this.emit('change', this.snapshot());
    }
    return this.snapshot();
  }
  catalogEntry(source) {
    return { sourceId: source.sourceId, displayName: source.displayName, kind: source.kind,
      ...(source.metricDefinitions ? { resourceType: source.resourceType, metricDefinitions: source.metricDefinitions, metricOrder: source.metricOrder } : {}) };
  }
  async trend(target) {
    const generation = this.generation;
    const sourceId = typeof target === 'string' ? target : target?.id;
    const account = typeof target === 'object' && target?.kind === 'account';
    if (!(account ? validAccountId(sourceId) : validId(sourceId))) throw new Error('Invalid source ID');
    const data = await this.request(`/api/v1/${account ? 'accounts' : 'sources'}/${encodeURIComponent(sourceId)}/trend?hours=1`);
    if (generation !== this.generation) throw new Error('The workspace connection changed; reopen this history');
    const definitions = data.metricDefinitions === undefined ? METRICS : validateDefinitions(data.metricDefinitions);
    const points = validateTrend(data.points, definitions);
    const metrics = data.metricDefinitions === undefined
      ? Object.entries(definitions).map(([key, definition]) => ({ ...definition, key, selectionKey: key }))
      : displayMetrics({ sourceId, kind: 'resource', metricDefinitions: definitions, metricOrder: validateOrder(data.metricOrder, definitions) });
    return { points, displayMetrics: metrics };
  }
  start() {
    if (this.timer) return;
    this.poll(true);
    this.timer = setInterval(() => this.poll(), CLOUD_POLL_MS);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.configurationAttempt++;
    this.generation++;
  }
}
module.exports = { MonitoringClient };
