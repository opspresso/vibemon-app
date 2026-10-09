const { EventEmitter } = require('events');
const { METRICS, validId, webOrigin, validateSources } = require('./domain.cjs');
const { CLOUD_POLL_MS, CLOUD_REQUEST_TIMEOUT_MS, CLOUD_STALE_MS, CLOUD_TREND_MS } = require('../shared/constants.cjs');

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
    this.status = 'not-configured';
    this.generation = 0;
    this.inflight = null;
    this.timer = null;
  }
  snapshot() {
    return {
      url: this.preferences.get('url') || 'https://vibemon.io',
      tokenConfigured: this.credentials.has(),
      status: this.status,
      selectedSources: this.preferences.get('selectedSources') ?? null,
      selectedMetrics: this.preferences.get('selectedMetrics') ?? Object.keys(METRICS),
      metrics: METRICS,
      trendRefreshMs: CLOUD_TREND_MS,
      catalog: this.catalog,
      sources: this.sources.map(source => ({ ...source, stale: source.stale || this.now() - Date.parse(source.receivedAt) >= CLOUD_STALE_MS }))
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
    this.status = 'connecting';
    if (this.inflight) await this.inflight;
    return this.poll(true);
  }
  async disconnect() {
    this.generation++;
    this.credentials.clear();
    this.sources = [];
    this.catalog = [];
    this.status = 'not-configured';
    this.emit('change', this.snapshot());
    return this.snapshot();
  }
  async select({ sources, metrics }) {
    if (sources !== null && (!Array.isArray(sources) || sources.length > 100 || !sources.every(validId))) throw new Error('Invalid source selection');
    if (!Array.isArray(metrics) || metrics.some(key => !Object.hasOwn(METRICS, key))) throw new Error('Invalid metric selection');
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
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error('Web response is too large');
    return JSON.parse(text);
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
      if (!discover && Array.isArray(selected) && selected.length === 0) {
        this.sources = [];
        this.status = this.credentials.has() ? 'connected' : 'not-configured';
      } else {
        const query = !discover && selected ? `?ids=${encodeURIComponent(selected.join(','))}` : '';
        const data = await this.request(`/api/v1/sources${query}`);
        const sources = validateSources(data.sources);
        if (generation === this.generation) {
          this.sources = sources;
          if (discover || !selected) this.catalog = sources.map(({ sourceId, displayName }) => ({ sourceId, displayName }));
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
  async trend(sourceId) {
    if (!validId(sourceId)) throw new Error('Invalid source ID');
    const data = await this.request(`/api/v1/sources/${encodeURIComponent(sourceId)}/trend?hours=1`);
    if (!Array.isArray(data.points) || data.points.length > 61) throw new Error('Invalid trend response');
    return data.points;
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
