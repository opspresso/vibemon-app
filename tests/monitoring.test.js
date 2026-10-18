const { URL } = require('node:url');
const { MonitoringClient } = require('../src/monitoring/client.cjs');
const { CredentialStore } = require('../src/monitoring/credential-store.cjs');
const { validateSources, validateTrend, webOrigin } = require('../src/monitoring/domain.cjs');
const rawToken = 'vm_' + '1'.repeat(60);
function okResponse(value) {
  if (value.sources && !Object.hasOwn(value, 'serverTime')) value = { ...value, serverTime: new Date(1000000).toISOString() };
  return { ok: true, body: { getReader: () => {
    let sent = false;
    return { read: async () => sent ? { done: true } : (sent = true, { done: false, value: Buffer.from(JSON.stringify(value)) }), cancel: jest.fn(), releaseLock: jest.fn() };
  } } };
}

function store(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { get: key => values.get(key), set: (key, value) => typeof key === 'object' ? Object.entries(key).forEach(([name, entry]) => values.set(name, entry)) : values.set(key, value), delete: key => values.delete(key), values };
}
const source = now => ({ sourceId: 'spark', kind: 'host', displayName: 'Spark', health: 'ok', stale: false, observedAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), metrics: { cpuPercent: 35, memoryPercent: 72, gpuTemperatureC: 40, gpuPercent: null }, memoryType: 'unified' });
test.each(['First\nSecond', 'First\u007fSecond', '\ud800'])('source names use the same display-text contract: %p', displayName => {
  expect(() => validateSources([{ ...source(1000), displayName }])).toThrow();
});
test('sources keep the heartbeat flag and reject a non-boolean one', () => {
  expect(validateSources([{ ...source(1000), heartbeat: true }])[0].heartbeat).toBe(true);
  expect(validateSources([source(1000)])[0].heartbeat).toBe(false);
  expect(() => validateSources([{ ...source(1000), heartbeat: 'yes' }])).toThrow();
});
function fixture(now = 1000000) {
  const preferences = store({ url: 'https://web.example' });
  const secrets = store();
  let value = rawToken;
  const credentials = { has: () => Boolean(value), get: () => value, set: (token, origin) => { value = token; if (origin) preferences.set('url', origin); }, clear: () => { value = null; } };
  const fetchImpl = jest.fn().mockResolvedValue(okResponse({ sources: [source(now)] }));
  return { client: new MonitoringClient({ preferences, credentials, fetchImpl, now: () => now, monotonicNow: () => now }), preferences, secrets, fetchImpl };
}

describe('cloud monitoring', () => {
  afterEach(() => jest.useRealTimers());
  test.each([[401, 'token-expired'], [403, 'permission-denied'], [503, 'connection-error']])('empty selection cannot hide HTTP %s as a successful connection', async (status, expected) => {
    const { client, preferences, fetchImpl } = fixture();
    preferences.set('selectedSources', []);
    preferences.set('selectedAccounts', []);
    fetchImpl.mockResolvedValue({ ok: false, status });
    await client.poll(true);
    expect(client.getStatus()).toBe(expected);
    await client.poll();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(client.getStatus()).toBe(expected);
  });
  test('polls latest state every 30 seconds and never prefetches trends', async () => {
    jest.useFakeTimers();
    const { client, fetchImpl } = fixture();
    client.start(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(30000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(([url]) => url.includes('/api/v1/sources') && !url.includes('trend'))).toBe(true);
    client.stop(); await jest.advanceTimersByTimeAsync(60000); expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  test.each([[401, 'token-expired'], [403, 'permission-denied']])('a rejected token (HTTP %s) pauses scheduled polls until a manual poll succeeds', async (status, expected) => {
    jest.useFakeTimers();
    const { client, fetchImpl } = fixture();
    const changes = jest.fn();
    client.on('change', changes);
    fetchImpl.mockResolvedValueOnce({ ok: false, status });
    client.start(); await jest.advanceTimersByTimeAsync(0);
    expect(client.getStatus()).toBe(expected);
    const emitted = changes.mock.calls.length;
    await jest.advanceTimersByTimeAsync(120000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledTimes(emitted);
    await client.poll(true);
    expect(client.getStatus()).toBe('connected');
    await jest.advanceTimersByTimeAsync(30000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    client.stop();
  });
  test('scheduled polls do not run without a saved token', async () => {
    jest.useFakeTimers();
    const { client, fetchImpl } = fixture();
    client.credentials.clear();
    const changes = jest.fn();
    client.on('change', changes);
    client.start(); await jest.advanceTimersByTimeAsync(90000);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    client.stop();
  });
  test('requests selected sources and preserves discovery choices', async () => {
    const { client, fetchImpl } = fixture();
    await client.poll(true);
    await client.select({ sources: ['spark'], metrics: ['cpuPercent'] });
    expect(fetchImpl.mock.calls[1][0]).toBe('https://web.example/api/v1/sources');
    expect(client.snapshot().catalog).toEqual([{ sourceId: 'spark', displayName: 'Spark', kind: 'host' }]);
    await client.select({ sources: [], metrics: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(client.snapshot().sources).toEqual([]);
  });
  test('discovery waits for a selected-source poll and coalesces catalog refreshes', async () => {
    const { client, preferences, fetchImpl } = fixture();
    await client.poll(true);
    preferences.set('selectedSources', ['spark']);
    preferences.set('selectedAccounts', []);
    fetchImpl.mockClear();
    let complete;
    fetchImpl.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    fetchImpl.mockResolvedValueOnce(okResponse({ sources: [source(1000000), { ...source(1000000), sourceId: 'cluster-two' }] }));
    const selected = client.poll();
    const first = client.poll(true), second = client.poll(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    complete(okResponse({ sources: [source(1000000)] }));
    const [, a, b] = await Promise.all([selected, first, second]);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['https://web.example/api/v1/sources?ids=spark', 'https://web.example/api/v1/sources']);
    expect(a.catalog.map(item => item.sourceId)).toEqual(['spark', 'cluster-two']);
    expect(b.catalog).toEqual(a.catalog);
    expect(a.selectedSources).toEqual(['spark']);
  });
  test('disconnect cancels a queued catalog discovery', async () => {
    const { client, fetchImpl } = fixture();
    let complete;
    fetchImpl.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    const selected = client.poll();
    const discovery = client.poll(true);
    await client.disconnect();
    complete(okResponse({ sources: [source(1000000)] }));
    await selected;
    expect(await discovery).toMatchObject({ status: 'not-configured', catalog: [], lastSyncedAt: null });
    // Only the token deletion follows the cancelled discovery.
    expect(fetchImpl.mock.calls.map(([, options]) => options.method ?? 'GET')).toEqual(['GET', 'DELETE']);
  });
  test('last sync records successful reads rather than attempts or selection changes', async () => {
    let now = 1000000;
    const { client, preferences, fetchImpl } = fixture(now);
    client.now = () => now;
    expect(client.snapshot().lastSyncedAt).toBeNull();
    await client.poll();
    const synchronized = new Date(now).toISOString();
    now += 30000;
    fetchImpl.mockResolvedValue({ ok: false, status: 503 });
    await client.poll();
    expect(client.snapshot().lastSyncedAt).toBe(synchronized);
    preferences.set('selectedSources', []); preferences.set('selectedAccounts', []);
    await client.poll();
    expect(client.snapshot().lastSyncedAt).toBe(synchronized);
    await client.disconnect();
    expect(client.snapshot().lastSyncedAt).toBeNull();
  });
  test('a first connection is visible while the response is pending', async () => {
    const { client, fetchImpl } = fixture();
    let complete;
    fetchImpl.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    const changed = jest.fn(); client.on('change', changed);
    const pending = client.poll(true);
    expect(changed.mock.calls.at(-1)[0]).toMatchObject({ status: 'connecting', lastSyncedAt: null });
    complete(okResponse({ sources: [source(1000000)] }));
    await pending;
    expect(changed.mock.calls.at(-1)[0].status).toBe('connected');
  });
  test('a candidate connection replaces the previous workspace only after validation', async () => {
    const { client, fetchImpl } = fixture();
    await client.poll(true);
    let complete;
    fetchImpl.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    const changed = jest.fn(); client.on('change', changed);
    const pending = client.configure({ url: 'https://other.example', token: 'vm_' + '2'.repeat(60) });
    expect(changed).not.toHaveBeenCalled();
    expect(client.snapshot()).toMatchObject({ url: 'https://web.example', status: 'connected' });
    expect(client.snapshot().sources).toHaveLength(1);
    complete(okResponse({ sources: [] }));
    await pending;
    expect(client.snapshot()).toMatchObject({ url: 'https://other.example', status: 'connected', sources: [] });
  });
  test.each([[401, 'token-expired'], [403, 'permission-denied'], [503, 'connection-error']])('distinguishes HTTP %s', async (status, expected) => {
    const { client, fetchImpl } = fixture();
    await client.poll();
    fetchImpl.mockResolvedValue({ ok: false, status });
    await client.poll();
    expect(client.snapshot().status).toBe(expected);
    expect(client.snapshot().sources).toHaveLength(1);
  });
  test('marks cached data stale during an outage and recovers without clearing it to zero', async () => {
    let now = 1000000;
    const { client, fetchImpl } = fixture(now); client.now = () => now; client.monotonicNow = () => now;
    await client.poll(); now += 120000;
    fetchImpl.mockRejectedValueOnce(new Error('Offline'));
    await client.poll();
    expect(client.snapshot().sources[0]).toMatchObject({ stale: true, metrics: { cpuPercent: 35, gpuPercent: null } });
    fetchImpl.mockResolvedValue(okResponse({ sources: [source(now)], serverTime: new Date(now).toISOString() }));
    await client.poll(); expect(client.snapshot().sources[0].stale).toBe(false);
  });
  test.each([-86400000, 86400000])('server receipt age ignores a reader clock offset of %i ms', async offset => {
    const { client, fetchImpl } = fixture();
    let elapsed = 0;
    client.now = () => 1000000 + offset;
    client.monotonicNow = () => elapsed;
    await client.poll();
    expect(client.snapshot()).toMatchObject({ attentionCount: 0, evaluatedAt: 1000000 });
    client.now = () => 1000000 - offset;
    elapsed = 119999;
    expect(client.snapshot().sources[0].displayState).toBe('ok');
    elapsed++;
    fetchImpl.mockRejectedValue(new Error('Offline'));
    await client.poll();
    expect(client.snapshot()).toMatchObject({ attentionCount: 1, evaluatedAt: 1120000 });
    fetchImpl.mockResolvedValue(okResponse({ sources: [source(1120000)], serverTime: null }));
    await client.poll();
    expect(client.snapshot().sources[0].receivedAt).toBe(new Date(1000000).toISOString());
    expect(client.snapshot().status).toBe('connection-error');
  });
  test('late responses cannot restore data after disconnect', async () => {
    const { client, fetchImpl } = fixture();
    let resolve;
    fetchImpl.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const pending = client.poll(); await client.disconnect();
    resolve(okResponse({ sources: [source(1000000)] }));
    await pending; expect(client.snapshot().sources).toEqual([]); expect(client.snapshot().tokenConfigured).toBe(false);
  });
  test('only requests a trend on demand and validates IDs', async () => {
    const { client, fetchImpl } = fixture();
    fetchImpl.mockResolvedValue(okResponse({ points: [] }));
    await client.trend('spark'); expect(fetchImpl.mock.calls[0][0]).toBe('https://web.example/api/v1/sources/spark/trend?hours=1');
    await expect(client.trend('../other')).rejects.toThrow('Invalid source ID');
  });
  test('history from a previous connection cannot be delivered after disconnect', async () => {
    const { client, fetchImpl } = fixture();
    let complete;
    fetchImpl.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    const history = client.trend('spark');
    await client.disconnect();
    complete(okResponse({ points: [] }));
    await expect(history).rejects.toThrow('connection changed');
  });
  test('rejects invalid server data and unsafe transport origins', () => {
    expect(() => validateSources([{ ...source(1000000), metrics: { cpuPercent: 101 } }])).toThrow();
    expect(() => webOrigin('http://example.com', true)).toThrow();
    expect(() => webOrigin('https://user:password@example.com')).toThrow();
    expect(webOrigin('http://127.0.0.1:3000', true)).toBe('http://127.0.0.1:3000');
  });
  test('cloud model-scoped percentages preserve decimals while reset durations remain integers', () => {
    const raw = { ...source(1000000), kind: 'agent', account: { provider: 'codex', id: 'work', displayName: 'Work' },
      agent: { state: 'working', character: 'codex', project: 'demo', usageWeekModel: 22.875, usageWeekModelResetsIn: 120 } };
    expect(validateSources([raw])[0].agent.usageWeekModel).toBe(22.875);
    for (const value of [-1, 101, Infinity, NaN]) expect(() => validateSources([{ ...raw, agent: { ...raw.agent, usageWeekModel: value } }])).toThrow();
    expect(() => validateSources([{ ...raw, agent: { ...raw.agent, usageWeekModelResetsIn: 1.5 } }])).toThrow();
  });
  test('agent plan usage metrics carry their reset time on the report clock', async () => {
    const { client, fetchImpl } = fixture();
    const observed = 1000000 - 90000;
    fetchImpl.mockResolvedValue(okResponse({ sources: [source(1000000), { ...source(observed), sourceId: 'work', kind: 'agent', memoryType: null,
      metrics: { usageSessionPercent: 40, usageWeekPercent: 20 }, account: { provider: 'codex', id: 'work', displayName: 'Work' },
      agent: { state: 'working', character: 'codex', project: 'demo', usage5hResetsIn: 125 } }] }));
    await client.poll(true);
    const metrics = Object.fromEntries(client.snapshot().accounts[0].latest.displayMetrics.map(metric => [metric.key, metric]));
    expect(metrics.usageSessionPercent.resetAt).toBe(observed + 125 * 60000);
    expect(metrics.usageWeekPercent).not.toHaveProperty('resetAt');
    expect(metrics.contextPercent).not.toHaveProperty('resetAt');
    expect(client.snapshot().sources.find(item => item.kind === 'host').displayMetrics.some(metric => 'resetAt' in metric)).toBe(false);
  });
});

describe('credential storage', () => {
  test('a damaged encrypted credential is a local recovery error, not a network failure', async () => {
    const preferences = store({ credential: 'saved-encrypted-bytes' });
    const safe = { isEncryptionAvailable: () => true, decryptString: () => { throw new Error('private storage detail'); } };
    const vault = new CredentialStore(preferences, safe);
    const fetchImpl = jest.fn();
    const client = new MonitoringClient({ preferences, credentials: vault, fetchImpl });
    const result = await client.poll(true);
    expect(result.status).toBe('credential-unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.tokenConfigured).toBe(true);
    expect(() => vault.get()).toThrow('saved token cannot be unlocked');
    try { vault.get(); } catch (error) { expect(error.message).not.toContain('private storage detail'); }
  });
  test('stores encrypted bytes, never plaintext, and does not expose credentials in snapshots', () => {
    const preferences = store();
    const safe = { isEncryptionAvailable: () => true, encryptString: jest.fn(() => Buffer.from('encrypted')), decryptString: jest.fn(() => rawToken) };
    const vault = new CredentialStore(preferences, safe);
    vault.set(rawToken); expect(JSON.stringify([...preferences.values])).not.toContain(rawToken); expect(vault.get()).toBe(rawToken);
    const client = new MonitoringClient({ preferences, credentials: vault });
    expect(JSON.stringify(client.snapshot())).not.toContain(rawToken);
    vault.clear(); expect(vault.get()).toBeNull();
  });
  test.each([false, true])('refuses plaintext backends and unavailable encryption: %s', available => {
    const preferences = store();
    const vault = new CredentialStore(preferences, { isEncryptionAvailable: () => available, getSelectedStorageBackend: () => 'basic_text' });
    expect(() => vault.set(rawToken)).toThrow('OS secure storage');
    expect(preferences.values.size).toBe(0);
  });
});

describe('multiple accounts and resources', () => {
  test('groups matching project names by provider account and polls only selected targets', async () => {
    const { client, fetchImpl } = fixture();
    const sources = [source(1000000), { ...source(1000000), sourceId: 'cluster-two', kind: 'cluster' }];
    for (const provider of ['claude', 'codex', 'kiro']) for (const id of ['work', 'personal']) {
      sources.push({ ...source(1000000), sourceId: `${provider}-${id}`, kind: 'agent', metrics: { contextPercent: id === 'work' ? 20 : 70 }, account: { provider, id, displayName: `${provider} ${id}` }, agent: { state: 'working', character: provider === 'claude' ? 'clawd' : provider, project: 'same-project' } });
    }
    fetchImpl.mockResolvedValue(okResponse({ sources }));
    await client.poll(true);
    expect(client.snapshot().accounts).toHaveLength(6);
    expect(client.snapshot().accounts.find(account => account.accountId === 'codex:work').latest.metrics.contextPercent).toBe(20);
    expect(client.snapshot().accounts.find(account => account.accountId === 'codex:personal').latest.metrics.contextPercent).toBe(70);
    await client.select({ sources: ['spark'], accounts: ['codex:work', 'claude:personal'], metrics: ['cpuPercent', 'usageWeekPercent'] });
    expect(fetchImpl.mock.calls.at(-1)[0]).toBe('https://web.example/api/v1/sources?ids=spark&accounts=codex%3Awork%2Cclaude%3Apersonal');
    fetchImpl.mockResolvedValue(okResponse({ points: [] }));
    await client.trend({ kind: 'account', id: 'codex:work' });
    expect(fetchImpl.mock.calls.at(-1)[0]).toBe('https://web.example/api/v1/accounts/codex%3Awork/trend?hours=1');
    const calls = fetchImpl.mock.calls.length;
    await client.select({ sources: [], accounts: [], metrics: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
  });
});

describe('selection of every available item', () => {
  test('follows accounts that appear after the selection was saved', async () => {
    const { client, preferences, fetchImpl } = fixture();
    const agent = (provider) => ({ ...source(1000000), sourceId: `${provider}-default`, kind: 'agent', metrics: {}, account: { provider, id: 'default', displayName: `${provider} default` }, agent: { state: 'working', character: provider, project: 'project' } });
    fetchImpl.mockResolvedValue(okResponse({ sources: [source(1000000), agent('codex')] }));
    await client.poll(true);
    await client.select({ sources: ['spark'], accounts: ['codex:default'], metrics: ['cpuPercent'] });
    expect(preferences.get('selectedAccounts')).toBeNull();
    expect(preferences.get('selectedSources')).toBeNull();
    expect(preferences.get('selectedMetrics')).toEqual(['cpuPercent']);
    fetchImpl.mockResolvedValue(okResponse({ sources: [source(1000000), agent('codex'), agent('claude'), agent('opencode')] }));
    await client.poll();
    expect(fetchImpl.mock.calls.at(-1)[0]).toBe('https://web.example/api/v1/sources');
    expect(client.snapshot().accounts.map(account => account.accountId).sort()).toEqual(['claude:default', 'codex:default', 'opencode:default']);
  });
});


describe('bounded response reading', () => {
  const { readJsonResponse } = require('../src/shared/json-response.cjs');
  test('cancels oversized bodies before buffering the rest', async () => {
    const reader = { read: jest.fn().mockResolvedValue({ done: false, value: Buffer.alloc(8) }), cancel: jest.fn(), releaseLock: jest.fn() };
    await expect(readJsonResponse({ body: { getReader: () => reader } }, 10)).rejects.toThrow('size limit');
    expect(reader.read).toHaveBeenCalledTimes(2);
    expect(reader.cancel).toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalled();
  });
  test('does not expose an invalid response body in error messages', async () => {
    let sent = false;
    const reader = { read: async () => sent ? { done: true } : (sent = true, { done: false, value: Buffer.from('fixture-sensitive-text') }), releaseLock: jest.fn() };
    await expect(readJsonResponse({ body: { getReader: () => reader } }, 100)).rejects.toThrow('Invalid JSON response');
  });
});


describe('validated renderer data', () => {
  test('unknown fields never cross the source boundary', () => {
    const [value] = validateSources([{ ...source(1000000), token: rawToken, privatePayload: { token: rawToken } }]);
    expect(JSON.stringify(value)).not.toContain(rawToken);
  });
  test('duplicate source IDs and invalid freshness flags are rejected', () => {
    expect(() => validateSources([source(1000000), source(1000000)])).toThrow();
    expect(() => validateSources([{ ...source(1000000), stale: 'false' }])).toThrow();
  });
  test('trends reject malformed metrics, reversed timestamps, and impossible maxima', () => {
    const point = { timestamp: '2026-10-09T00:00:00.000Z', samples: 2, expiresAt: 2000000000, average: { cpuPercent: 35 }, maximum: { cpuPercent: 40 } };
    expect(validateTrend([point])[0]).toMatchObject({ average: { cpuPercent: 35, gpuPercent: null } });
    for (const invalid of [null, { ...point, average: { cpuPercent: '35' } }, { ...point, average: { cpuPercent: -5 } }, { ...point, maximum: { cpuPercent: 30 } }, { ...point, samples: 0 }]) expect(() => validateTrend([invalid])).toThrow();
    expect(() => validateTrend([point, point])).toThrow();
  });
});

describe('custom resource definitions', () => {
  const { selectionKey } = require('../src/shared/resource-schema.cjs');
  const custom = (id, unit = 'ms') => ({ ...source(1000000), sourceId: id, kind: 'resource', resourceType: 'Any service', displayName: id, statusMessage: 'Serving requests', metricDefinitions: { value: { label: 'Measurement', unit, display: 'gauge', min: -100, max: 500 } }, metrics: { value: -20 } });
  test('validates arbitrary resource metadata and preserves negative values', () => {
    expect(validateSources([custom('service')])[0]).toMatchObject({ resourceType: 'Any service', statusMessage: 'Serving requests', metrics: { value: -20 } });
    for (const changes of [{ resourceType: '' }, { metrics: { value: Infinity } }, { metricDefinitions: { constructor: { label: 'Bad', unit: '', display: 'number' } } }]) expect(() => validateSources([{ ...custom('service'), ...changes }])).toThrow();
  });
  test('discovers custom fields and selects equal keys independently per resource', async () => {
    const { client, fetchImpl } = fixture();
    const one = custom('database', 'ms'), two = custom('sensor', '°C');
    fetchImpl.mockResolvedValue(okResponse({ sources: [one, two] }));
    await client.poll(true);
    const first = selectionKey(one, 'value'), second = selectionKey(two, 'value');
    expect(client.snapshot().selectedMetrics).toEqual(expect.arrayContaining([first, second]));
    expect(client.snapshot().metrics[first].unit).toBe('ms');
    expect(client.snapshot().metrics[second].unit).toBe('°C');
    await client.select({ sources: ['database'], metrics: [first] });
    expect(client.snapshot().selectedMetrics).toEqual([first]);
    expect(client.snapshot().sources[0].displayMetrics[0]).toMatchObject({ key: 'value', selectionKey: first, min: -100, max: 500 });
    await expect(client.select({ sources: ['database'], metrics: ['resource:unknown:value'] })).rejects.toThrow('Invalid metric selection');
  });
  test('validates custom trend values using the returned schema and keeps null gaps', async () => {
    const { client, fetchImpl } = fixture();
    const item = custom('sensor', '°C');
    const point = { timestamp: '2026-10-09T00:00:00Z', samples: 1, expiresAt: 2000000000, average: { value: -20 }, maximum: { value: -15 } };
    fetchImpl.mockResolvedValue(okResponse({ points: [point], metricDefinitions: item.metricDefinitions }));
    const trend = await client.trend('sensor');
    expect(trend.points[0].average.value).toBe(-20);
    expect(trend.displayMetrics[0]).toMatchObject({ key: 'value', unit: '°C', min: -100, max: 500, selectionKey: 'resource:sensor:value' });
    expect(validateTrend([{ ...point, average: { value: null }, maximum: { value: null } }], item.metricDefinitions)[0].average.value).toBeNull();
    expect(() => validateTrend([{ ...point, maximum: { value: -30 } }], item.metricDefinitions)).toThrow();
  });
  test('keeps edited preset order and values outside display bounds, preserving old selections', async () => {
    const { client, fetchImpl, preferences } = fixture();
    const metricDefinitions = {
      cpuPercent: { label: 'Processor', unit: '%', display: 'number' },
      memoryPercent: { label: 'RAM', unit: '%', display: 'gauge', min: 0, max: 50 }
    };
    preferences.set('selectedMetrics', ['cpuPercent', 'memoryPercent']);
    fetchImpl.mockResolvedValue(okResponse({ sources: [{ ...source(1000000), resourceType: 'Build server', metrics: { cpuPercent: 35, memoryPercent: 72 }, metricDefinitions, metricOrder: ['memoryPercent', 'cpuPercent'] }] }));
    await client.poll(true);
    const result = client.snapshot();
    expect(result.sources[0].displayMetrics.map(metric => metric.key)).toEqual(['memoryPercent', 'cpuPercent']);
    expect(result.sources[0].metrics.memoryPercent).toBe(72);
    expect(result.selectedMetrics).toEqual(['resource:spark:memoryPercent', 'resource:spark:cpuPercent']);
    fetchImpl.mockResolvedValue(okResponse({ points: [], metricDefinitions, metricOrder: ['memoryPercent', 'cpuPercent'] }));
    expect((await client.trend('spark')).displayMetrics.map(metric => metric.key)).toEqual(['memoryPercent', 'cpuPercent']);
  });
  test('rejects invalid order at the server boundary', () => {
    expect(() => validateSources([{ ...custom('sensor'), metricOrder: ['unknown'] }])).toThrow('exactly once');
    expect(() => validateSources([{ ...custom('sensor'), metricOrder: ['value', 'value'] }])).toThrow('exactly once');
  });
});

test.each([401, 403, 503])('a rejected replacement (%s) preserves the saved connection and data', async status => {
  const { client, preferences, fetchImpl } = fixture();
  await client.poll(true);
  const before = client.snapshot();
  fetchImpl.mockResolvedValueOnce({ ok: false, status });
  await expect(client.configure({ url: 'https://other.example', token: 'vm_' + '2'.repeat(60) })).rejects.toThrow();
  expect(client.credentials.get()).toBe(rawToken);
  expect(preferences.get('url')).toBe('https://web.example');
  expect(client.snapshot()).toEqual(before);
});
test('invalid response data and storage failures cannot publish a new connection', async () => {
  const { client, fetchImpl } = fixture();
  await client.poll(true);
  const before = client.snapshot();
  fetchImpl.mockResolvedValueOnce(okResponse({ sources: 'invalid' }));
  await expect(client.configure({ url: 'https://other.example', token: rawToken })).rejects.toThrow('Invalid source');
  client.credentials.set = () => { throw new Error('Storage failed'); };
  fetchImpl.mockResolvedValueOnce(okResponse({ sources: [] }));
  await expect(client.configure({ url: 'https://other.example', token: rawToken })).rejects.toThrow('Storage failed');
  expect(client.snapshot()).toEqual(before);
});
test('late candidate checks cannot overwrite a newer choice or undo disconnect', async () => {
  const { client, fetchImpl } = fixture();
  let complete;
  fetchImpl.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  const old = client.configure({ url: 'https://old.example', token: rawToken });
  await client.configure({ url: 'https://new.example', token: 'vm_' + '2'.repeat(60) });
  complete(okResponse({ sources: [] }));
  await expect(old).rejects.toThrow('connection changed');
  expect(client.snapshot().url).toBe('https://new.example');
  fetchImpl.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  const cancelled = client.configure({ url: 'https://old.example', token: rawToken });
  await client.disconnect(); complete(okResponse({ sources: [] }));
  await expect(cancelled).rejects.toThrow('connection changed');
  expect(client.snapshot().tokenConfigured).toBe(false);
});
test('the credential adapter commits encrypted token and origin together', () => {
  const storage = { set: jest.fn(), get: jest.fn() };
  const vault = new CredentialStore(storage, { isEncryptionAvailable: () => true, encryptString: () => Buffer.from('encrypted') });
  vault.set(rawToken, 'https://new.example');
  expect(storage.set).toHaveBeenCalledTimes(1);
  expect(storage.set).toHaveBeenCalledWith({ credential: Buffer.from('encrypted').toString('base64'), url: 'https://new.example' });
});

describe('selection saved before version 2', () => {
  const saved = { url: 'https://web.example', selectedSources: ['eks-demo', 'k3s-demo', 'spark-0702'], selectedAccounts: ['codex:default'], selectedMetrics: ['cpuPercent'] };
  test('resets a frozen list once so accounts created later are polled', async () => {
    const preferences = store({ ...saved });
    const fetchImpl = jest.fn().mockResolvedValue(okResponse({ sources: [source(1000000)] }));
    const client = new MonitoringClient({ preferences, credentials: { has: () => true, get: () => rawToken }, fetchImpl, now: () => 1000000, monotonicNow: () => 1000000 });
    await client.poll();
    expect(fetchImpl.mock.calls[0][0]).toBe('https://web.example/api/v1/sources');
    expect(preferences.get('selectionVersion')).toBe(2);
    preferences.set('selectedAccounts', ['codex:default']);
    new MonitoringClient({ preferences, credentials: { has: () => true, get: () => rawToken }, fetchImpl });
    expect(preferences.get('selectedAccounts')).toEqual(['codex:default']);
  });
});

describe('replacing a token deletes the replaced one on Web', () => {
  const replacement = 'vm_' + '2'.repeat(60);
  test('a verified replacement deletes the previous token at its own origin', async () => {
    const { client, fetchImpl } = fixture();
    await client.configure({ url: 'https://other.example', token: replacement });
    const [url, options] = fetchImpl.mock.calls.at(-1);
    expect([url, options.method, options.headers.Authorization]).toEqual(['https://web.example/api/v1/connection', 'DELETE', `Bearer ${rawToken}`]);
    expect(client.snapshot().url).toBe('https://other.example');
  });
  test('the same token, a URL-only change, and a failed check delete nothing', async () => {
    const { client, fetchImpl } = fixture();
    await client.configure({ url: 'https://web.example', token: rawToken });
    await client.configure({ url: 'https://web.example', token: '' });
    fetchImpl.mockResolvedValueOnce({ ok: false, status: 401 });
    await expect(client.configure({ url: 'https://web.example', token: replacement })).rejects.toMatchObject({ code: 'token-expired' });
    expect(fetchImpl.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
  });
});

describe('disconnect deletes the token on Web', () => {
  test('sends DELETE with the saved token after removing it locally, and reports a failure', async () => {
    const { client, fetchImpl } = fixture();
    fetchImpl.mockResolvedValueOnce({ status: 204, ok: true });
    const result = await client.disconnect();
    expect(result.tokenDeleted).toBe(true);
    expect(result.tokenConfigured).toBe(false);
    const [url, options] = fetchImpl.mock.calls.at(-1);
    expect([url, options.method, options.headers.Authorization, options.redirect]).toEqual(['https://web.example/api/v1/connection', 'DELETE', `Bearer ${rawToken}`, 'error']);
    const offline = fixture();
    offline.fetchImpl.mockRejectedValueOnce(new Error('offline'));
    expect((await offline.client.disconnect()).tokenDeleted).toBe(false);
    expect(offline.client.snapshot().tokenConfigured).toBe(false);
    // A locked keychain: the token exists but cannot be read, so Web still has it.
    const locked = fixture();
    const credentials = locked.client.credentials;
    credentials.get = () => { throw Object.assign(new Error('locked'), { code: 'secure-storage-unavailable' }); };
    expect((await locked.client.disconnect()).tokenDeleted).toBe(false);
    expect(locked.fetchImpl).not.toHaveBeenCalled();
  });
});


describe('removal handoff', () => {
  test('checks the reader workspace and keeps credentials out of the browser URL', async () => {
    const { client, fetchImpl } = fixture();
    await client.poll(true);
    fetchImpl.mockResolvedValue(okResponse({ connected: true, scope: 'read', ownerId: 'fixture-owner' }));
    const url = new URL(await client.removalUrl({ kind: 'source', id: 'spark' }));
    expect(url.origin).toBe('https://web.example');
    expect(Object.fromEntries(url.searchParams)).toEqual({ view: 'resources', remove: 'source', id: 'spark', owner: 'fixture-owner' });
    expect(url.href).not.toContain(rawToken);
    expect(fetchImpl.mock.calls.at(-1)[1].method).toBeUndefined();
  });
  test('keeps full generated account IDs in the request while labels can be short', async () => {
    const { client, fetchImpl } = fixture();
    const id = `codex:auto:${'a'.repeat(64)}`;
    client.accountCatalog = [{ accountId: id }];
    fetchImpl.mockResolvedValue(okResponse({ connected: true, scope: 'read', ownerId: 'fixture-owner' }));
    expect(new URL(await client.removalUrl({ kind: 'account', id })).searchParams.get('id')).toBe(id);
    await expect(client.removalUrl({ kind: 'account', id: 'codex:unknown' })).rejects.toThrow('no longer');
    await expect(client.removalUrl({ kind: 'source', id: '../bad' })).rejects.toThrow('Invalid');
  });
  test('rejects an older Web server or a changed connection before opening the browser', async () => {
    const { client, fetchImpl } = fixture();
    await client.poll(true);
    fetchImpl.mockResolvedValue(okResponse({ connected: true }));
    await expect(client.removalUrl({ kind: 'source', id: 'spark' })).rejects.toThrow('Update Web');
    fetchImpl.mockImplementation(async () => { client.generation++; return okResponse({ connected: true, scope: 'read', ownerId: 'other-owner' }); });
    await expect(client.removalUrl({ kind: 'source', id: 'spark' })).rejects.toThrow('connection');
  });
});
