const { readJsonResponse } = require('../shared/json-response.cjs');
const { EventEmitter } = require('events');
const { METRICS, validId, validAccountId, accountId, groupAccounts, webOrigin, validateSources, validateTrend } = require('./domain.cjs');
const { CLOUD_POLL_MS, CLOUD_REQUEST_TIMEOUT_MS, CLOUD_STALE_MS, CLOUD_TREND_MS, CLOUD_MAX_RESPONSE_BYTES } = require('../shared/constants.cjs');

class MonitoringClient extends EventEmitter {
  constructor({ preferences, credentials, fetchImpl = fetch, allowLocalHttp = false, now = Date.now }) {
    super();
    this.preferences = preferences;
    this.credentials = credentials;
    this.fetch = fetchImpl;
    this.allowLocalHttp = allowLocalHttp;
    this.now = now;
    this.sources = [];
    this.catalog = [];
    this.accountCatalog = [];
    this.status = 'not-configured';
    this.generation = 0;
    this.inflight = null;
    this.timer = null;
  }
  getStatus() { return this.status; }
  hasToken() { return this.credentials.has(); }
  snapshot() {
    const selectedSources = this.preferences.get('selectedSources') ?? null;
    const selectedAccounts = this.preferences.get('selectedAccounts') ?? null;
    const selected = this.sources.filter(source => source.kind === 'agent'
      ? selectedAccounts === null || selectedAccounts.includes(accountId(source.account))
      : selectedSources === null || selectedSources.includes(source.sourceId));
    const sources = selected.map(source => ({ ...source, stale: source.stale || this.now() - Date.parse(source.receivedAt) >= CLOUD_STALE_MS }));
    return {
      url: this.preferences.get('url') || 'https://vibemon.io',
      tokenConfigured: this.credentials.has(), status: this.status,
      selectedSources, selectedAccounts, accountCatalog: this.accountCatalog,
      accounts: groupAccounts(sources),
      selectedMetrics: this.preferences.get('selectedMetrics') ?? Object.keys(METRICS),
      metrics: METRICS, trendRefreshMs: CLOUD_TREND_MS, catalog: this.catalog, sources
    };
  }
  async configure({ url, token }) {
    const origin = webOrigin(url, this.allowLocalHttp);
    if (typeof token !== 'string' || (token && !/^vm_[a-f0-9]{60}$/.test(token))) throw new Error('Enter a generated read token');
    if (token) this.credentials.set(token);
    if (origin !== this.preferences.get('url') && !token && this.credentials.has()) throw new Error('Enter a token when changing the Web address');
    this.preferences.set('url', origin);
    this.generation++;
    this.sources = [];
    this.catalog = [];
    this.accountCatalog = [];
    this.status = 'connecting';
    this.emit('sources', []);
    if (this.inflight) await this.inflight;
    return this.poll(true);
  }
  async disconnect() {
    this.generation++;
    this.credentials.clear();
    this.sources = [];
    this.catalog = [];
    this.accountCatalog = [];
    this.status = 'not-configured';
    this.emit('sources', []);
    this.emit('change', this.snapshot());
    return this.snapshot();
  }
  async select({ sources, accounts = null, metrics }) {
    if (accounts !== null && (!Array.isArray(accounts) || accounts.length > 100 || !accounts.every(validAccountId))) throw new Error('Invalid account selection');
    if (sources !== null && (!Array.isArray(sources) || sources.length > 100 || !sources.every(validId))) throw new Error('Invalid source selection');
    if (!Array.isArray(metrics) || metrics.some(key => !Object.hasOwn(METRICS, key))) throw new Error('Invalid metric selection');
    this.preferences.set('selectedAccounts', accounts === null ? null : [...new Set(accounts)]);
    this.preferences.set('selectedSources', sources === null ? null : [...new Set(sources)]);
    this.preferences.set('selectedMetrics', [...new Set(metrics)]);
    if (this.inflight) await this.inflight;
    return this.poll();
  }
  async request(path) {
    const token = this.credentials.get();
    if (!token) throw Object.assign(new Error('Configure a read token'), { code: 'not-configured' });
    const origin = webOrigin(this.preferences.get('url') || 'https://vibemon.io', this.allowLocalHttp);
    const response = await this.fetch(`${origin}${path}`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
      signal: AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) throw Object.assign(new Error('Web request failed'), { code: response.status === 401 ? 'token-expired' : response.status === 403 ? 'permission-denied' : 'connection-error' });
    return readJsonResponse(response, CLOUD_MAX_RESPONSE_BYTES);
  }
  poll(discover = false) {
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchSources(discover).finally(() => { this.inflight = null; });
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
        this.status = this.credentials.has() ? 'connected' : 'not-configured';
        this.emit('sources', []);
      } else {
        const parts = [];
        if (ids.length) parts.push(`ids=${encodeURIComponent(ids.join(','))}`);
        if (accountIds.length) parts.push(`accounts=${encodeURIComponent(accountIds.join(','))}`);
        const query = !discover && !all ? `?${parts.join('&')}` : '';
        const data = await this.request(`/api/v1/sources${query}`);
        const sources = validateSources(data.sources);
        if (generation === this.generation) {
          this.sources = sources;
          if (discover || all) {
            this.catalog = sources.map(({ sourceId, displayName, kind }) => ({ sourceId, displayName, kind }));
            this.accountCatalog = groupAccounts(sources).map(({ accountId, displayName, provider }) => ({ accountId, displayName, provider }));
          }
          this.status = 'connected';
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
  async trend(target) {
    const sourceId = typeof target === 'string' ? target : target?.id;
    const account = typeof target === 'object' && target?.kind === 'account';
    if (!(account ? validAccountId(sourceId) : validId(sourceId))) throw new Error('Invalid source ID');
    const data = await this.request(`/api/v1/${account ? 'accounts' : 'sources'}/${encodeURIComponent(sourceId)}/trend?hours=1`);
    return validateTrend(data.points);
  }
  start() {
    if (this.timer) return;
    this.poll(true);
    this.timer = setInterval(() => this.poll(), CLOUD_POLL_MS);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.generation++;
  }
}
module.exports = { MonitoringClient };
