const { MonitoringClient } = require('../src/monitoring/client.cjs');
const { CredentialStore } = require('../src/monitoring/credential-store.cjs');
const { validateSources, validateTrend, webOrigin } = require('../src/monitoring/domain.cjs');
const rawToken = 'vm_' + '1'.repeat(60);
function okResponse(value) {
  return { ok: true, body: { getReader: () => {
    let sent = false;
    return { read: async () => sent ? { done: true } : (sent = true, { done: false, value: Buffer.from(JSON.stringify(value)) }), cancel: jest.fn(), releaseLock: jest.fn() };
  } } };
}

function store(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { get: key => values.get(key), set: (key, value) => values.set(key, value), delete: key => values.delete(key), values };
}
const source = now => ({ sourceId: 'spark', kind: 'host', displayName: 'Spark', health: 'ok', stale: false, observedAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), metrics: { cpuPercent: 35, memoryPercent: 72, gpuTemperatureC: 40, gpuPercent: null }, memoryType: 'unified' });
function fixture(now = 1000000) {
  const preferences = store({ url: 'https://web.example' });
  const secrets = store();
  let value = rawToken;
  const credentials = { has: () => Boolean(value), get: () => value, set: token => { value = token; }, clear: () => { value = null; } };
  const fetchImpl = jest.fn().mockResolvedValue(okResponse({ sources: [source(now)] }));
  return { client: new MonitoringClient({ preferences, credentials, fetchImpl, now: () => now }), preferences, secrets, fetchImpl };
}

describe('cloud monitoring', () => {
  afterEach(() => jest.useRealTimers());
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
  test('requests selected sources and preserves discovery choices', async () => {
    const { client, fetchImpl } = fixture();
    await client.poll(true);
    await client.select({ sources: ['spark'], metrics: ['cpuPercent'] });
    expect(fetchImpl.mock.calls[1][0]).toContain('?ids=spark');
    expect(client.snapshot().catalog).toEqual([{ sourceId: 'spark', displayName: 'Spark', kind: 'host' }]);
    await client.select({ sources: [], metrics: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(client.snapshot().sources).toEqual([]);
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
    const { client, fetchImpl } = fixture(now); client.now = () => now;
    await client.poll(); now += 120000;
    fetchImpl.mockRejectedValueOnce(new Error('Offline'));
    await client.poll();
    expect(client.snapshot().sources[0]).toMatchObject({ stale: true, metrics: { cpuPercent: 35, gpuPercent: null } });
    fetchImpl.mockResolvedValue(okResponse({ sources: [source(now)] }));
    await client.poll(); expect(client.snapshot().sources[0].stale).toBe(false);
  });
  test('late responses cannot restore data after disconnect', async () => {
    const { client, fetchImpl } = fixture();
    let resolve;
    fetchImpl.mockReturnValue(new Promise(done => { resolve = done; }));
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
  test('rejects invalid server data and unsafe transport origins', () => {
    expect(() => validateSources([{ ...source(1000000), metrics: { cpuPercent: 101 } }])).toThrow();
    expect(() => webOrigin('http://example.com', true)).toThrow();
    expect(() => webOrigin('https://user:password@example.com')).toThrow();
    expect(webOrigin('http://127.0.0.1:3000', true)).toBe('http://127.0.0.1:3000');
  });
});

describe('credential storage', () => {
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
    for (const provider of ['claude', 'codex']) for (const id of ['work', 'personal']) {
      sources.push({ ...source(1000000), sourceId: `${provider}-${id}`, kind: 'agent', metrics: { contextPercent: id === 'work' ? 20 : 70 }, account: { provider, id, displayName: `${provider} ${id}` }, agent: { state: 'working', character: provider === 'claude' ? 'clawd' : 'codex', project: 'same-project' } });
    }
    fetchImpl.mockResolvedValue(okResponse({ sources }));
    await client.poll(true);
    expect(client.snapshot().accounts).toHaveLength(4);
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


describe('bounded response reading', () => {
  const { readJsonResponse } = require('../src/monitoring/response.cjs');
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
    await expect(readJsonResponse({ body: { getReader: () => reader } }, 100)).rejects.toThrow('Invalid JSON from Web');
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
