const { HookCloudDelivery } = require('../src/modules/hook-cloud-delivery.cjs');
const token = 'vm_' + 'a'.repeat(60);
function response(value = { connected: true, scope: 'write' }) {
  let read = false;
  return { ok: true, body: { getReader: () => ({ read: async () => read ? { done: true } : (read = true, { done: false, value: Buffer.from(JSON.stringify(value)) }), releaseLock() {}, cancel: jest.fn() }) } };
}
function fixture() {
  const config = { vibemon_url: 'https://vibemon.io', vibemon_token: token, http_urls: ['http://localhost:19280'] };
  const configManager = { read: () => ({ ...config }), write: jest.fn(value => Object.assign(config, value)) };
  const fetchImpl = jest.fn(async () => response());
  const delivery = new HookCloudDelivery({ configManager, fetchImpl, now: () => 1000000 });
  return { config, configManager, fetchImpl, delivery };
}
test('verifies write access before saving and never exposes stored credentials', async () => {
  const { delivery, fetchImpl, configManager } = fixture();
  await delivery.configure({ url: 'https://vibemon.io/', token: '' });
  expect(fetchImpl).toHaveBeenCalledWith('https://vibemon.io/api/v1/connection?scope=write', expect.objectContaining({ redirect: 'error', headers: { Authorization: `Bearer ${token}` } }));
  expect(configManager.write).toHaveBeenCalledWith({ vibemon_url: 'https://vibemon.io', vibemon_token: token });
  expect(delivery.snapshot()).toMatchObject({ status: 'verified', checkedAt: new Date(1000000).toISOString(), tokenConfigured: true });
  expect(JSON.stringify(delivery.snapshot())).not.toContain(token);
});
test.each([[401, 'rejected'], [403, 'write permission'], [404, 'Update VibeMon'], [503, 'service is available']])('failed verification (%s) cannot replace a working credential', async (status, message) => {
  const { delivery, fetchImpl, configManager } = fixture();
  fetchImpl.mockResolvedValue({ ok: false, status });
  await expect(delivery.configure({ url: 'https://vibemon.io', token: 'vm_' + 'b'.repeat(60) })).rejects.toThrow(message);
  expect(configManager.write).not.toHaveBeenCalled();
  expect(delivery.snapshot().busy).toBe(false);
});
test('requires explicit replacement before sending a saved token to another origin', async () => {
  const { delivery, fetchImpl } = fixture();
  await expect(delivery.configure({ url: 'https://other.example', token: '' })).rejects.toThrow('new write token');
  expect(fetchImpl).not.toHaveBeenCalled();
  await delivery.configure({ url: 'https://other.example', token: 'vm_' + 'b'.repeat(60) });
  expect(fetchImpl.mock.calls[0][0]).toBe('https://other.example/api/v1/connection?scope=write');
});
test.each(['http://remote.example', 'https://user:secret@example.com', 'https://example.com/api', 'https://example.com?secret=x'])('rejects unsafe origins before transmitting credentials: %s', async url => {
  const { delivery, fetchImpl } = fixture();
  await expect(delivery.configure({ url, token })).rejects.toThrow('HTTPS VibeMon address');
  expect(fetchImpl).not.toHaveBeenCalled();
});
test('rejects unexpected or oversized success responses instead of claiming verification', async () => {
  const { delivery, fetchImpl } = fixture();
  fetchImpl.mockResolvedValueOnce(response({ connected: true, scope: 'read' }));
  await expect(delivery.check()).rejects.toThrow('Unexpected connection response');
  fetchImpl.mockResolvedValueOnce(response({ connected: true, scope: 'write', padding: 'x'.repeat(5000) }));
  await expect(delivery.check()).rejects.toThrow('size limit');
  expect(delivery.snapshot().status).toBe('error');
});
test('connection failures do not leak request details through the workspace', async () => {
  const { delivery, fetchImpl } = fixture();
  fetchImpl.mockRejectedValue(new Error(`private request ${token}`));
  await expect(delivery.check()).rejects.toThrow('Cannot reach VibeMon');
  expect(JSON.stringify(delivery.snapshot())).not.toContain(token);
});
test('rejects concurrent changes and preserves externally updated credentials', async () => {
  const { delivery, fetchImpl, config, configManager } = fixture();
  let finish;
  fetchImpl.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const save = delivery.configure({ url: 'https://vibemon.io', token });
  await expect(delivery.check()).rejects.toThrow('already in progress');
  await expect(delivery.disconnect()).rejects.toThrow('Wait');
  config.vibemon_token = 'vm_' + 'c'.repeat(60);
  finish(response());
  await expect(save).rejects.toThrow('changed while checking');
  expect(configManager.write).not.toHaveBeenCalled();
});
test('stopping cloud delivery preserves local routing and invalidates its verification', async () => {
  const { delivery, config } = fixture();
  await delivery.check();
  await delivery.disconnect();
  expect(config.http_urls).toEqual(['http://localhost:19280']);
  expect(delivery.snapshot()).toMatchObject({ tokenConfigured: false, status: 'not-configured', checkedAt: null });
});

test('equivalent URL spellings retain the same credential boundary', async () => {
  const { delivery, config } = fixture();
  config.vibemon_url = 'https://VIBEMON.IO:443/';
  await delivery.configure({ url: 'https://vibemon.io', token: '' });
  expect(delivery.snapshot().status).toBe('verified');
});

test('malformed saved addresses cannot disclose embedded credentials to the renderer', () => {
  const { delivery, config } = fixture();
  config.vibemon_url = 'https://user:private-password@example.com';
  expect(delivery.snapshot()).toMatchObject({ status: 'error', url: '' });
  expect(JSON.stringify(delivery.snapshot())).not.toContain('private-password');
});

test('disconnect deletes the saved write token from VibeMon and reports a failure', async () => {
  const { delivery, fetchImpl, config } = fixture();
  fetchImpl.mockResolvedValueOnce({ status: 204, ok: true });
  await expect(delivery.disconnect()).resolves.toEqual({ tokenDeleted: true });
  const [url, options] = fetchImpl.mock.calls.at(-1);
  expect([url, options.method, options.headers.Authorization]).toEqual(['https://vibemon.io/api/v1/connection', 'DELETE', `Bearer ${token}`]);
  expect(config.vibemon_token).toBe('');
  const offline = fixture();
  offline.fetchImpl.mockRejectedValueOnce(new Error('offline'));
  await expect(offline.delivery.disconnect()).resolves.toEqual({ tokenDeleted: false });
  expect(offline.config.vibemon_token).toBe('');
});

test('a verified replacement deletes the replaced write token from VibeMon', async () => {
  const { delivery, fetchImpl } = fixture();
  const replacement = 'vm_' + 'b'.repeat(60);
  await delivery.configure({ url: 'https://vibemon.io', token: replacement });
  const [url, options] = fetchImpl.mock.calls.at(-1);
  expect([url, options.method, options.headers.Authorization]).toEqual(['https://vibemon.io/api/v1/connection', 'DELETE', `Bearer ${token}`]);
  fetchImpl.mockClear();
  await delivery.configure({ url: 'https://vibemon.io', token: replacement });
  expect(fetchImpl.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
});

test('cancelled verification preserves the saved write token and local delivery', async () => {
  const { delivery, fetchImpl, config, configManager } = fixture();
  const original = { ...config };
  const controller = new globalThis.AbortController();
  let finish;
  fetchImpl.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const save = delivery.configure({ url: 'https://vibemon.io', token: 'vm_' + 'b'.repeat(60) }, { signal: controller.signal });
  controller.abort(new Error('Cancelled sign-in'));
  expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  finish(response());
  await expect(save).rejects.toThrow('Cancelled sign-in');
  expect(config).toEqual(original);
  expect(configManager.write).not.toHaveBeenCalled();
  expect(delivery.snapshot().busy).toBe(false);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
