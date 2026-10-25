const { UsageClient, validateUsage, validateConnection, validateAuthorization, validateCompletion } = require('../src/monitoring/usage.cjs');
const { validateSources } = require('../src/monitoring/domain.cjs');

const TOKEN = 'vm_' + 'f'.repeat(60);
const ID = '6f1c2a4e-8b7d-4c3a-9e21-5d6f7a8b9c01';
const SIGN_IN = '7a2d3b5f-9c8e-4d4b-8f32-6e7a8b9cad02';
const connection = (changes = {}) => ({
  id: ID, provider: 'claude', accountId: 'auto:497e', label: 'person@example.com', plan: 'Max', connectedAt: '2026-10-24T12:00:00.000Z',
  status: 'ready', stale: false, observedAt: '2026-10-24T12:00:00.000Z', checkedAt: '2026-10-24T12:00:00.000Z', retryAt: null, refreshableAt: '2026-10-24T12:01:00.000Z',
  windows: [{ key: 'week', kind: 'week', model: null, durationSeconds: 604800, usedPercent: 42, resetsAt: '2026-10-29T04:00:00.000Z' }],
  ...changes
});
const authorization = (provider = 'codex', prompt = { kind: 'device', url: 'https://auth.openai.com/codex/device', userCode: 'BCDF-GHJK', interval: 5 }) =>
  ({ authorization: { id: SIGN_IN, provider, prompt, expiresAt: '2026-10-24T12:15:00.000Z' } });

describe('usage responses', () => {
  test('a connection list keeps known services and rejects an invalid connection', () => {
    const list = validateUsage({ providers: ['claude', 'codex', 'future'], connections: [connection(), connection({ id: SIGN_IN, provider: 'future' })], serverTime: '2026-10-24T12:00:00.000Z' });
    expect(list.providers).toEqual(['claude', 'codex']);
    expect(list.connections).toEqual([expect.objectContaining({ id: ID, accountId: 'auto:497e', plan: 'Max', windows: [expect.objectContaining({ key: 'week', usedPercent: 42 })] })]);
    expect(() => validateUsage({ providers: [], connections: [connection(), connection()], serverTime: '2026-10-24T12:00:00.000Z' })).toThrow();
    expect(() => validateUsage({ providers: [], connections: [], serverTime: 'later' })).toThrow();
  });

  test.each([
    ['a non-UUID ID', { id: 'abc' }],
    ['a long plan', { plan: 'p'.repeat(41) }],
    ['a reading without its time', { observedAt: null }],
    ['a percentage above 100', { windows: [{ key: 'week', kind: 'week', usedPercent: 101, resetsAt: null }] }],
    ['a repeated window', { windows: [{ key: 'week', kind: 'week', usedPercent: 1 }, { key: 'week', kind: 'week', usedPercent: 2 }] }],
    ['an unknown window kind', { windows: [{ key: 'month', kind: 'month', usedPercent: 1 }] }]
  ])('a connection with %s is rejected', (_name, changes) => {
    expect(() => validateConnection(connection(changes))).toThrow(expect.objectContaining({ code: 'usage-invalid-response' }));
  });

  test('a connection with a status that this version does not know is left out, like an unknown service', () => {
    expect(validateConnection(connection({ status: 'paused' }))).toBeNull();
    const list = validateUsage({ providers: ['claude'], connections: [connection({ status: 'paused' }), connection({ id: SIGN_IN })], serverTime: '2026-10-24T12:00:00.000Z' });
    expect(list.connections.map(item => item.id)).toEqual([SIGN_IN]);
    expect(() => validateCompletion({ status: 'connected', connection: connection({ status: 'paused' }) })).toThrow();
  });

  test('a connection without windows or reading is still valid', () => {
    expect(validateConnection(connection({ windows: [], observedAt: null, label: null, plan: null }))).toMatchObject({ label: null, plan: null, windows: [] });
  });

  test('a sign-in prompt opens only the service host over HTTPS', () => {
    expect(validateAuthorization(authorization())).toMatchObject({ id: SIGN_IN, prompt: { kind: 'device', userCode: 'BCDF-GHJK', interval: 5 } });
    expect(validateAuthorization(authorization('claude', { kind: 'code', url: 'https://claude.ai/oauth/authorize?x=1' })).prompt).toEqual({ kind: 'code', url: 'https://claude.ai/oauth/authorize?x=1' });
    for (const [provider, prompt] of [
      ['claude', { kind: 'code', url: 'http://claude.ai/oauth/authorize' }],
      ['claude', { kind: 'code', url: 'https://claude.ai.evil.example/' }],
      ['claude', { kind: 'code', url: 'javascript:alert(1)' }],
      ['codex', { kind: 'device', url: 'https://claude.ai/device', userCode: 'A', interval: 5 }],
      ['codex', { kind: 'device', url: 'https://auth.openai.com/codex/device', userCode: 'A', interval: 0 }],
      ['codex', { kind: 'code', url: 'https://auth.openai.com/codex/device' }]
    ]) expect(() => validateAuthorization(authorization(provider, prompt))).toThrow();
  });

  test('a completion is pending with its interval or connected with a connection', () => {
    expect(validateCompletion({ status: 'pending', interval: 5 })).toEqual({ status: 'pending', interval: 5 });
    expect(validateCompletion({ status: 'connected', connection: connection() }).connection.id).toBe(ID);
    for (const value of [{ status: 'pending', interval: 0 }, { status: 'connected' }, { status: 'done' }]) expect(() => validateCompletion(value)).toThrow();
  });
});

describe('agent account connection', () => {
  const agent = account => ({
    sourceId: 'usage:x', kind: 'agent', displayName: 'Solo', health: 'ok', stale: false, observedAt: '2026-10-24T12:00:00.000Z', receivedAt: '2026-10-24T12:00:00.000Z',
    metrics: { usageWeekPercent: 31 }, agent: { state: 'standby', character: 'codex', project: 'Solo' }, account: { provider: 'codex', id: 'auto:solo', displayName: 'Solo', ...account }
  });
  test('sources keep a valid connection and accept sources without one', () => {
    expect(validateSources([agent({ connection: { id: ID, status: 'rate-limited', plan: 'Plus' } })])[0].account.connection).toEqual({ id: ID, status: 'rate-limited', plan: 'Plus' });
    expect(validateSources([agent({ connection: { id: ID, status: 'ready' } })])[0].account.connection).toEqual({ id: ID, status: 'ready', plan: null });
    expect(validateSources([agent()])[0].account).not.toHaveProperty('connection');
    expect(validateSources([agent({ connection: null })])[0].account).not.toHaveProperty('connection');
  });
  test.each([{ id: 'abc', status: 'ready' }, { id: ID, status: 'paused' }, { id: ID, status: 'ready', plan: 'p'.repeat(41) }, { id: ID, status: 'ready', plan: 7 }, 'linked'])('an unreadable connection is dropped and the source kept: %p', value => {
    const [kept] = validateSources([agent({ connection: value })]);
    expect(kept.account).toEqual({ provider: 'codex', id: 'auto:solo', displayName: 'Solo' });
    expect(kept.metrics.usageWeekPercent).toBe(31);
  });
});

function response(status, value) {
  const text = value === undefined ? '' : JSON.stringify(value);
  let sent = !text;
  return {
    status, ok: status >= 200 && status < 300,
    body: { cancel: jest.fn(async () => {}), getReader: () => ({ read: async () => sent ? { done: true } : (sent = true, { done: false, value: Buffer.from(text) }), cancel: async () => {}, releaseLock() {} }) }
  };
}

describe('usage client', () => {
  let replies, monitoring, client;
  beforeEach(() => {
    replies = [];
    monitoring = {
      generation: 1, status: 'connected', fetch: jest.fn(async () => replies.shift()),
      credentials: { get: () => TOKEN }, savedOrigin: () => 'https://vibemon.io'
    };
    client = new UsageClient({ monitoring });
  });

  test('requests send the read token as Bearer without following redirects', async () => {
    replies.push(response(200, { providers: ['claude'], connections: [connection()], serverTime: '2026-10-24T12:00:00.000Z' }));
    expect((await client.list()).connections).toHaveLength(1);
    const [url, options] = monitoring.fetch.mock.calls[0];
    expect(url).toBe('https://vibemon.io/api/v1/usage');
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${TOKEN}` } });
  });

  test('a 403 without a code on a usage-scope request asks for a new sign-in; the dashboard status stays', async () => {
    replies.push(response(403, { error: 'Usage permission required' }));
    await expect(client.start('claude')).rejects.toMatchObject({ code: 'usage-sign-in-required' });
    replies.push(response(403, {}));
    // Refreshing a reading needs only read permission: its 403 is a plain permission failure.
    await expect(client.refresh(ID)).rejects.toMatchObject({ code: 'permission-denied' });
    replies.push(response(401, {}));
    await expect(client.list()).rejects.toMatchObject({ code: 'token-expired' });
    expect(monitoring.status).toBe('connected');
  });

  test.each([
    [404, 'usage-authorization-expired'], [403, 'usage-authorization-denied'], [400, 'usage-authorization-code-invalid'],
    [503, 'usage-provider-unavailable'], [409, 'usage-connection-limit']
  ])('Web failure %s keeps its code %s', async (status, code) => {
    replies.push(response(201, authorization('claude', { kind: 'code', url: 'https://claude.ai/oauth/authorize' })));
    await client.start('claude');
    replies.push(response(status, { error: 'Failed', code }));
    await expect(client.complete(SIGN_IN, 'pasted')).rejects.toMatchObject({ code });
  });

  test('a sign-in is known by ID until it connects, ends, or is cancelled', async () => {
    replies.push(response(201, authorization()));
    await client.start('codex');
    expect(JSON.parse(monitoring.fetch.mock.calls[0][1].body)).toEqual({ provider: 'codex' });
    expect(client.authorization(SIGN_IN).prompt.userCode).toBe('BCDF-GHJK');
    replies.push(response(200, { status: 'pending', interval: 7 }));
    await expect(client.complete(SIGN_IN)).resolves.toEqual({ status: 'pending', interval: 7 });
    expect(JSON.parse(monitoring.fetch.mock.calls[1][1].body)).toEqual({});
    replies.push(response(200, { status: 'connected', connection: connection() }));
    await expect(client.complete(SIGN_IN)).resolves.toMatchObject({ status: 'connected' });
    expect(() => client.authorization(SIGN_IN)).toThrow(expect.objectContaining({ code: 'usage-authorization-expired' }));
    replies.push(response(201, authorization()));
    await client.start('codex');
    replies.push(response(204));
    await expect(client.cancel(SIGN_IN)).resolves.toBe(true);
    expect(monitoring.fetch.mock.calls.at(-1)).toEqual(['https://vibemon.io/api/v1/usage/authorizations/' + SIGN_IN, expect.objectContaining({ method: 'DELETE' })]);
    await expect(client.cancel(SIGN_IN)).resolves.toBe(false);
  });

  test('a Claude code is required and sent trimmed', async () => {
    replies.push(response(201, authorization('claude', { kind: 'code', url: 'https://claude.ai/oauth/authorize' })));
    await client.start('claude');
    await expect(client.complete(SIGN_IN, '')).rejects.toMatchObject({ code: 'usage-authorization-code-invalid' });
    replies.push(response(400, { code: 'usage-authorization-code-invalid' }));
    await expect(client.complete(SIGN_IN, ' code#state ')).rejects.toMatchObject({ code: 'usage-authorization-code-invalid' });
    expect(JSON.parse(monitoring.fetch.mock.calls.at(-1)[1].body)).toEqual({ code: 'code#state' });
    // A rejected code keeps the sign-in.
    expect(client.authorization(SIGN_IN).id).toBe(SIGN_IN);
  });

  test('a changed VibeMon connection forgets its sign-ins and discards late answers', async () => {
    replies.push(response(201, authorization()));
    await client.start('codex');
    monitoring.generation++;
    expect(() => client.authorization(SIGN_IN)).toThrow();
    monitoring.fetch.mockImplementationOnce(async () => { monitoring.generation++; return response(200, { providers: [], connections: [], serverTime: '2026-10-24T12:00:00.000Z' }); });
    await expect(client.list()).rejects.toThrow('The connection changed');
  });

  test('refresh and disconnect use the connection ID and expected statuses', async () => {
    replies.push(response(200, { connection: connection({ status: 'unavailable' }) }));
    expect((await client.refresh(ID)).status).toBe('unavailable');
    replies.push(response(204));
    await expect(client.disconnect(ID)).resolves.toBe(true);
    expect(monitoring.fetch.mock.calls.map(([url, { method }]) => `${method} ${url}`)).toEqual([
      `POST https://vibemon.io/api/v1/usage/connections/${ID}`, `DELETE https://vibemon.io/api/v1/usage/connections/${ID}`
    ]);
    await expect(client.disconnect('../tokens')).rejects.toThrow('Invalid connection ID');
    replies.push(response(204));
    await expect(client.refresh(ID)).rejects.toMatchObject({ code: 'connection-error' });
  });

  test('an unreachable server is a connection error of the request', async () => {
    monitoring.fetch.mockRejectedValueOnce(new Error('offline'));
    await expect(client.list()).rejects.toMatchObject({ code: 'connection-error' });
  });
});
