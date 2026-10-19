const { createHash } = require('node:crypto');
const { URL, URLSearchParams } = require('node:url');
const { setImmediate } = require('node:timers');
const { WebSignIn, SignInError } = require('../src/monitoring/web-sign-in.cjs');

const TOKEN = `vm_${'a'.repeat(60)}`;

function jsonBody(value) {
  let sent = false;
  return { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true, { done: false, value: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) }), cancel: async () => {}, releaseLock() {} }) };
}

function setup(reply = { status: 200, body: { access_token: TOKEN, token_type: 'Bearer', scope: 'read' } }) {
  const opened = [];
  const fetchImpl = jest.fn(async () => ({ ok: reply.status === 200, status: reply.status, body: jsonBody(reply.body) }));
  const signIn = new WebSignIn({ port: 19280, openExternal: async url => { opened.push(new URL(url)); }, fetchImpl, deviceName: 'studio', timeoutMs: 1000 });
  return { signIn, opened, fetchImpl };
}
const adopt = async token => token;
const callback = (url, values) => new URLSearchParams({ state: url.searchParams.get('state'), ...values });

describe('desktop sign-in through Web', () => {
  test('opens /authorize with PKCE and exchanges the code for a token of the asked scope', async () => {
    const { signIn, opened, fetchImpl } = setup();
    const result = signIn.signIn('https://vibemon.io', 'read', adopt);
    await new Promise(setImmediate);
    const url = opened[0];
    expect(url.origin + url.pathname).toBe('https://vibemon.io/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual(expect.objectContaining({
      client_id: 'vibemon-desktop', redirect_uri: 'http://127.0.0.1:19280/auth/callback', scope: 'read',
      code_challenge_method: 'S256', device_name: 'studio'
    }));
    expect(signIn.complete(callback(url, { code: 'one-time' }))).toEqual({ ok: true, message: expect.stringContaining('Signed in') });
    await expect(result).resolves.toBe(TOKEN);
    const [endpoint, options] = fetchImpl.mock.calls[0];
    expect(String(endpoint)).toBe('https://vibemon.io/api/oauth/token');
    expect(options.redirect).toBe('error');
    const form = Object.fromEntries(options.body);
    expect(form).toEqual(expect.objectContaining({ grant_type: 'authorization_code', client_id: 'vibemon-desktop', code: 'one-time' }));
    // The challenge in the browser URL is the SHA-256 of the verifier sent only in the exchange.
    expect(createHash('sha256').update(form.code_verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
  });

  test('ignores callbacks of another sign-in and reports a denial', async () => {
    const { signIn, opened } = setup();
    const result = signIn.signIn('https://vibemon.io', 'write', adopt);
    await new Promise(setImmediate);
    expect(signIn.complete(new URLSearchParams({ state: 'forged', code: 'x' })).ok).toBe(false);
    expect(signIn.complete(callback(opened[0], { error: 'access_denied' })).ok).toBe(false);
    await expect(result).rejects.toMatchObject({ reason: 'denied' });
    // After it finished, the same callback is no longer accepted.
    expect(signIn.complete(callback(opened[0], { code: 'late' })).ok).toBe(false);
  });

  test('a new sign-in replaces one that waits, and a waiting sign-in times out', async () => {
    jest.useFakeTimers();
    try {
      const { signIn } = setup();
      const first = signIn.signIn('https://vibemon.io', 'read', adopt);
      const second = signIn.signIn('https://vibemon.io', 'read', adopt);
      await expect(first).rejects.toMatchObject({ reason: 'cancelled' });
      jest.advanceTimersByTime(1000);
      await expect(second).rejects.toMatchObject({ reason: 'timeout' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('rejects an expired code, an unusable answer, and an insecure address', async () => {
    for (const [reply, reason] of [[{ status: 400, body: { error: 'invalid_grant' } }, 'expired'], [{ status: 200, body: { access_token: 'nope' } }, 'rejected'], [{ status: 200, body: `{"access_token":"${TOKEN}","padding":"${'x'.repeat(5000)}"}` }, 'rejected']]) {
      const { signIn, opened } = setup(reply);
      const result = signIn.signIn('https://vibemon.io', 'read', adopt);
      await new Promise(setImmediate);
      signIn.complete(callback(opened[0], { code: 'c' }));
      await expect(result).rejects.toMatchObject({ reason });
    }
    await expect(setup().signIn.signIn('http://vibemon.io', 'read', adopt)).rejects.toThrow();
    await expect(setup().signIn.signIn('https://vibemon.io', 'admin', adopt)).rejects.toBeInstanceOf(SignInError);
  });

  test('deletes a new token on Web when the App cannot keep it', async () => {
    const { signIn, opened, fetchImpl } = setup();
    const result = signIn.signIn('https://vibemon.io', 'read', async () => { throw new Error('Cannot reach Web'); });
    await new Promise(setImmediate);
    signIn.complete(callback(opened[0], { code: 'c' }));
    await expect(result).rejects.toThrow('Cannot reach Web');
    const [endpoint, options] = fetchImpl.mock.calls[1];
    expect([String(endpoint), options.method, options.headers.Authorization]).toEqual(['https://vibemon.io/api/v1/connection', 'DELETE', `Bearer ${TOKEN}`]);
  });

  test('fails at once when the callback server does not listen', async () => {
    const opened = [];
    const signIn = new WebSignIn({ port: 19280, openExternal: async url => { opened.push(url); }, fetchImpl: jest.fn(), canReceive: () => false });
    await expect(signIn.signIn('https://vibemon.io', 'read', adopt)).rejects.toMatchObject({ reason: 'no-callback', message: expect.stringContaining('19280') });
    expect(opened).toEqual([]);
  });

  test('cancelling after the callback but before exchange sends no request', async () => {
    const { signIn, opened, fetchImpl } = setup();
    const keep = jest.fn();
    const result = signIn.signIn('https://vibemon.io', 'read', keep);
    signIn.complete(callback(opened[0], { code: 'c' }));
    signIn.cancel();
    await expect(result).rejects.toMatchObject({ reason: 'cancelled' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(keep).not.toHaveBeenCalled();
  });

  test('cancelling during token exchange deletes the issued token without adopting it', async () => {
    const { signIn, opened, fetchImpl } = setup();
    let finish;
    fetchImpl.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const keep = jest.fn();
    const result = signIn.signIn('https://vibemon.io', 'read', keep);
    signIn.complete(callback(opened[0], { code: 'c' }));
    await new Promise(setImmediate);
    signIn.cancel();
    finish({ ok: true, status: 200, body: jsonBody({ access_token: TOKEN, token_type: 'Bearer', scope: 'read' }) });
    await expect(result).rejects.toMatchObject({ reason: 'cancelled' });
    expect(keep).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
  });

  test('an older exchange cannot adopt its token after a newer sign-in completes', async () => {
    const { signIn, opened, fetchImpl } = setup();
    let finish;
    fetchImpl.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const firstKeep = jest.fn(), secondKeep = jest.fn();
    const first = signIn.signIn('https://vibemon.io', 'read', firstKeep);
    signIn.complete(callback(opened[0], { code: 'old' }));
    await new Promise(setImmediate);
    const second = signIn.signIn('https://vibemon.io', 'write', secondKeep);
    signIn.complete(callback(opened[1], { code: 'new' }));
    await second;
    finish({ ok: true, status: 200, body: jsonBody({ access_token: 'vm_' + 'b'.repeat(60), scope: 'read' }) });
    await expect(first).rejects.toMatchObject({ reason: 'cancelled' });
    expect(firstKeep).not.toHaveBeenCalled();
    expect(secondKeep).toHaveBeenCalledTimes(1);
  });

  test('cancellation reaches a connection verification that is still running', async () => {
    const { signIn, opened, fetchImpl } = setup();
    let finish;
    const verification = new Promise(resolve => { finish = resolve; });
    let signal;
    const result = signIn.signIn('https://vibemon.io', 'read', async (_token, current) => {
      signal = current;
      await verification;
      current.throwIfAborted();
    });
    signIn.complete(callback(opened[0], { code: 'c' }));
    await new Promise(setImmediate);
    signIn.cancel();
    finish();
    await expect(result).rejects.toMatchObject({ reason: 'cancelled' });
    expect(signal?.aborted).toBe(true);
    expect(fetchImpl.mock.calls.at(-1)[1].method).toBe('DELETE');
  });

  test('cancellation keeps its reason when an aborted verification reports a transport error', async () => {
    const { signIn, opened } = setup();
    let finish;
    const reading = new Promise(resolve => { finish = resolve; });
    const result = signIn.signIn('https://vibemon.io', 'read', async () => {
      await reading;
      throw new Error('Body read aborted');
    });
    signIn.complete(callback(opened[0], { code: 'c' }));
    await new Promise(setImmediate);
    signIn.cancel();
    finish();
    await expect(result).rejects.toMatchObject({ reason: 'cancelled' });
  });
});
