const { loadBrowserModule } = require('./helpers/browser-module.cjs');

const { UsageStore, UsageConnectFlow, USAGE_POLL_MS, MAX_CODES } = loadBrowserModule('src/workspace/services-store.js', ['UsageStore', 'UsageConnectFlow', 'USAGE_POLL_MS', 'MAX_CODES'], { Date });

const failure = code => Object.assign(new Error(`message for ${code}`), { code });
// Timers of this test realm, so Jest's fake timers drive the module's polling.
const timers = {
  setInterval: (...args) => setInterval(...args), clearInterval: id => clearInterval(id),
  setTimeout: (...args) => setTimeout(...args), clearTimeout: id => clearTimeout(id)
};
const connection = (id, changes = {}) => ({ id, provider: 'claude', accountId: 'studio', status: 'ready', stale: false, refreshableAt: '2026-10-25T00:01:00.000Z', windows: [], ...changes });
const snapshot = connections => ({ providers: ['claude', 'codex'], connections, serverTime: '2026-10-25T00:00:00.000Z' });

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('UsageStore', () => {
  test('polls every minute only while a page shows connections, on the server clock', async () => {
    let clock = 1000;
    const request = jest.fn(async () => snapshot([connection('a')]));
    const store = new UsageStore({ request, timers, clock: () => clock });
    store.follow(1);
    expect(request).not.toHaveBeenCalled();
    store.setActive(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.connections.map(item => item.id)).toEqual(['a']);
    clock += 5000;
    expect(store.now()).toBe(Date.parse('2026-10-25T00:00:05.000Z'));
    await jest.advanceTimersByTimeAsync(USAGE_POLL_MS);
    expect(request).toHaveBeenCalledTimes(2);
    store.setActive(false);
    await jest.advanceTimersByTimeAsync(USAGE_POLL_MS * 3);
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('a new VibeMon connection forgets the previous data and discards its late answer', async () => {
    let answer;
    const request = jest.fn(() => new Promise(resolve => { answer = resolve; }));
    const store = new UsageStore({ request, timers, clock: () => 0 });
    store.follow(1);
    store.setActive(true);
    const first = answer;
    store.follow(2);
    expect(request).toHaveBeenCalledTimes(2);
    first(snapshot([connection('old')]));
    await jest.advanceTimersByTimeAsync(0);
    expect(store.snapshot).toBeNull();
    answer(snapshot([connection('new')]));
    await jest.advanceTimersByTimeAsync(0);
    expect(store.connections.map(item => item.id)).toEqual(['new']);
  });

  test('a failed list keeps its message until a later list succeeds', async () => {
    const request = jest.fn().mockRejectedValueOnce(failure('connection-error')).mockResolvedValue(snapshot([]));
    const store = new UsageStore({ request, timers, clock: () => 0 });
    store.follow(1);
    await store.load();
    expect(store.error).toBe('message for connection-error');
    await store.load();
    expect(store.error).toBeNull();
    expect(store.snapshot.connections).toEqual([]);
  });

  test('refresh replaces one connection; disconnect removes it; a failure stays with its connection', async () => {
    const request = jest.fn(async command => command === 'usage' ? snapshot([connection('a'), connection('b')]) : command === 'usage-refresh' ? connection('a', { status: 'unavailable' }) : true);
    const onChange = jest.fn();
    const store = new UsageStore({ request, timers, clock: () => 0, onChange });
    store.follow(1);
    await store.load();
    await expect(store.refresh('a')).resolves.toBe(true);
    expect(request).toHaveBeenLastCalledWith('usage-refresh', 'a');
    expect(store.connections.map(item => item.status)).toEqual(['unavailable', 'ready']);
    await expect(store.disconnect('b')).resolves.toBe(true);
    expect(request).toHaveBeenLastCalledWith('usage-disconnect', 'b');
    expect(store.connections.map(item => item.id)).toEqual(['a']);
    request.mockRejectedValueOnce(failure('usage-sign-in-required'));
    await expect(store.disconnect('a')).resolves.toBe(false);
    expect(store.actionErrors.get('a')).toEqual({ message: 'message for usage-sign-in-required', code: 'usage-sign-in-required' });
    expect(store.connections.map(item => item.id)).toEqual(['a']);
    expect(store.busy.size).toBe(0);
    expect(onChange).toHaveBeenCalled();
  });

  test('one action per connection runs at a time', async () => {
    let finish;
    const request = jest.fn(() => new Promise(resolve => { finish = resolve; }));
    const store = new UsageStore({ request, timers, clock: () => 0 });
    const first = store.refresh('a');
    await expect(store.refresh('a')).resolves.toBe(false);
    expect(store.busy.has('a')).toBe(true);
    finish(connection('a'));
    await first;
    expect(store.busy.has('a')).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('UsageConnectFlow', () => {
  const expiresAt = '2026-10-25T00:10:00.000Z';
  const claude = { id: 'sign-in-1', provider: 'claude', expiresAt, prompt: { kind: 'code', url: 'https://claude.ai/oauth/authorize' } };
  const codex = { id: 'sign-in-2', provider: 'codex', expiresAt, prompt: { kind: 'device', url: 'https://auth.openai.com/codex/device', userCode: 'BCDF-GHJK', interval: 5 } };
  // The device clock, before the sign-in expires unless a test moves it.
  let deviceTime;
  beforeEach(() => { deviceTime = Date.parse('2026-10-25T00:00:00.000Z'); });
  const now = () => deviceTime;

  test('Claude: a rejected code keeps the sign-in, and a pasted code connects', async () => {
    const onConnected = jest.fn();
    const request = jest.fn(async (command, _id, code) => {
      if (command === 'usage-start') return claude;
      if (code !== 'right') throw failure('usage-authorization-code-invalid');
      return { status: 'connected', connection: connection('new') };
    });
    const flow = new UsageConnectFlow({ request, now, timers, onConnected });
    flow.open('claude');
    await flow.start();
    expect(request).toHaveBeenCalledWith('usage-start', 'claude');
    expect(flow.phase).toBe('authorize');
    await expect(flow.submit('wrong')).resolves.toBeNull();
    expect(flow.phase).toBe('authorize');
    expect(flow.error.code).toBe('usage-authorization-code-invalid');
    await expect(flow.submit('  right ')).resolves.toEqual(connection('new'));
    expect(request).toHaveBeenLastCalledWith('usage-complete', 'sign-in-1', 'right');
    expect(flow.phase).toBe('connected');
    expect(onConnected).toHaveBeenCalledWith(connection('new'));
    // A finished sign-in is not cancelled.
    await flow.close();
    expect(request).not.toHaveBeenCalledWith('usage-cancel', expect.anything());
  });

  test(`Claude: the ${MAX_CODES}th rejected code ends the sign-in`, async () => {
    const request = jest.fn(async command => { if (command === 'usage-start') return claude; throw failure('usage-authorization-code-invalid'); });
    const flow = new UsageConnectFlow({ request, now, timers, describe: code => `described ${code}` });
    flow.open('claude');
    await flow.start();
    for (let attempt = 1; attempt < MAX_CODES; attempt++) await flow.submit(`code-${attempt}`);
    expect(flow.phase).toBe('authorize');
    await flow.submit('last');
    expect(flow.phase).toBe('choose');
    expect(flow.error).toEqual({ message: 'described usage-authorization-expired', code: 'usage-authorization-expired' });
    expect(flow.provider).toBe('claude');
  });

  test('Codex: polls at the server interval after the page opens, until connected', async () => {
    const answers = [{ status: 'pending', interval: 2 }, failure('connection-error'), { status: 'connected', connection: connection('codex', { provider: 'codex' }) }];
    const request = jest.fn(async command => {
      if (command === 'usage-start') return codex;
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const flow = new UsageConnectFlow({ request, now, timers });
    flow.open('codex');
    await flow.start();
    await jest.advanceTimersByTimeAsync(60000);
    expect(request).toHaveBeenCalledTimes(1);
    flow.approvalOpened();
    expect(flow.waiting).toBe(true);
    await jest.advanceTimersByTimeAsync(4999);
    expect(request).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenLastCalledWith('usage-complete', 'sign-in-2');
    // The server asked for 2 seconds.
    await jest.advanceTimersByTimeAsync(2000);
    expect(request).toHaveBeenCalledTimes(3);
    expect(flow.error.code).toBe('connection-error');
    expect(flow.phase).toBe('authorize');
    // A transient failure doubles the interval.
    await jest.advanceTimersByTimeAsync(9999);
    expect(request).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1);
    expect(flow.phase).toBe('connected');
    expect(flow.error).toBeNull();
    await jest.advanceTimersByTimeAsync(60000);
    expect(request).toHaveBeenCalledTimes(4);
  });

  test('Codex: closing stops polling and cancels the unfinished sign-in', async () => {
    const request = jest.fn(async command => command === 'usage-start' ? codex : command === 'usage-cancel' ? true : { status: 'pending', interval: 5 });
    const flow = new UsageConnectFlow({ request, now, timers });
    flow.open('codex');
    await flow.start();
    flow.approvalOpened();
    await jest.advanceTimersByTimeAsync(5000);
    await flow.close();
    expect(request).toHaveBeenLastCalledWith('usage-cancel', 'sign-in-2');
    const calls = request.mock.calls.length;
    await jest.advanceTimersByTimeAsync(60000);
    expect(request).toHaveBeenCalledTimes(calls);
    expect(flow.phase).toBe('choose');
  });

  test('a sign-in that starts after the flow closed is cancelled at once', async () => {
    let started;
    const request = jest.fn(command => command === 'usage-start' ? new Promise(resolve => { started = resolve; }) : Promise.resolve(true));
    const flow = new UsageConnectFlow({ request, now, timers });
    flow.open('codex');
    const start = flow.start();
    await flow.close();
    started(codex);
    await start;
    expect(request).toHaveBeenLastCalledWith('usage-cancel', 'sign-in-2');
    expect(flow.phase).toBe('choose');
  });

  test('a code that connects after the flow closed adds the connection without reopening the flow', async () => {
    let complete;
    const onConnected = jest.fn();
    const request = jest.fn(command => {
      if (command === 'usage-start') return Promise.resolve(claude);
      if (command === 'usage-complete') return new Promise(resolve => { complete = resolve; });
      return Promise.resolve(true);
    });
    const flow = new UsageConnectFlow({ request, now, timers, onConnected });
    flow.open('claude');
    await flow.start();
    const submit = flow.submit('right');
    await flow.close();
    complete({ status: 'connected', connection: connection('late') });
    await expect(submit).resolves.toBeNull();
    // The person approved it: the list shows it, and VibeMon keeps it.
    expect(onConnected).toHaveBeenCalledWith(connection('late'));
    expect(flow.phase).toBe('choose');
    expect(request).not.toHaveBeenCalledWith('usage-disconnect', expect.anything());
  });

  test('a token without the usage permission ends the attempt and asks for a new VibeMon sign-in', async () => {
    const request = jest.fn(async () => { throw failure('usage-sign-in-required'); });
    const flow = new UsageConnectFlow({ request, now, timers });
    flow.open('codex');
    await flow.start();
    expect(flow.phase).toBe('choose');
    expect(flow.provider).toBe('codex');
    expect(flow.error.code).toBe('usage-sign-in-required');
  });

  test('a denied device sign-in stops polling', async () => {
    const request = jest.fn(async command => { if (command === 'usage-start') return codex; throw failure('usage-authorization-denied'); });
    const flow = new UsageConnectFlow({ request, now, timers });
    flow.open('codex');
    await flow.start();
    flow.approvalOpened();
    await jest.advanceTimersByTimeAsync(5000);
    expect(flow.phase).toBe('choose');
    expect(flow.error.code).toBe('usage-authorization-denied');
    await jest.advanceTimersByTimeAsync(60000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('Codex: polling stops when the sign-in expires', async () => {
    const request = jest.fn(async command => command === 'usage-start' ? codex : { status: 'pending', interval: 5 });
    const flow = new UsageConnectFlow({ request, now, timers, describe: code => `described ${code}` });
    flow.open('codex');
    await flow.start();
    flow.approvalOpened();
    await jest.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledTimes(2);
    deviceTime = Date.parse(expiresAt) + 1;
    await jest.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(flow.phase).toBe('choose');
    expect(flow.error).toEqual({ message: 'described usage-authorization-expired', code: 'usage-authorization-expired' });
    await jest.advanceTimersByTimeAsync(60000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  test.each(['token-expired', 'permission-denied'])('Codex: VibeMon rejecting the token (%s) stops polling', async code => {
    const request = jest.fn(async command => { if (command === 'usage-start') return codex; throw failure(code); });
    const flow = new UsageConnectFlow({ request, now, timers });
    flow.open('codex');
    await flow.start();
    flow.approvalOpened();
    await jest.advanceTimersByTimeAsync(5000);
    expect(flow.phase).toBe('choose');
    expect(flow.error.code).toBe(code);
    await jest.advanceTimersByTimeAsync(60000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('Claude: a pending answer shows checking and asks again after its interval', async () => {
    const answers = [{ status: 'pending', interval: 3 }, { status: 'connected', connection: connection('new') }];
    const request = jest.fn(async command => command === 'usage-start' ? claude : answers.shift());
    const changes = [];
    const flow = new UsageConnectFlow({ request, now, timers });
    flow.onChange = () => changes.push(flow.checking);
    flow.open('claude');
    await flow.start();
    const submitted = flow.submit('code');
    await jest.advanceTimersByTimeAsync(0);
    expect(flow.checking).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(2999);
    expect(request).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    await expect(submitted).resolves.toEqual(connection('new'));
    expect(request).toHaveBeenLastCalledWith('usage-complete', 'sign-in-1', 'code');
    expect(flow.phase).toBe('connected');
    expect(flow.checking).toBe(false);
    expect(changes).toContain(true);
  });

  test('Claude: an expired sign-in stops checking a pending code', async () => {
    const request = jest.fn(async command => command === 'usage-start' ? claude : { status: 'pending', interval: 3 });
    const flow = new UsageConnectFlow({ request, now, timers });
    flow.open('claude');
    await flow.start();
    const submitted = flow.submit('code');
    await jest.advanceTimersByTimeAsync(0);
    deviceTime = Date.parse(expiresAt) + 1;
    await jest.advanceTimersByTimeAsync(3000);
    await expect(submitted).resolves.toBeNull();
    expect(flow.phase).toBe('choose');
    expect(flow.error.code).toBe('usage-authorization-expired');
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('expiry follows the injected server clock, not the device clock', async () => {
    const request = jest.fn(async command => command === 'usage-start' ? codex : { status: 'pending', interval: 5 });
    // The device clock runs an hour fast; the server clock is still before the expiry.
    jest.setSystemTime(Date.parse(expiresAt) + 3600000);
    const flow = new UsageConnectFlow({ request, now, timers });
    flow.open('codex');
    await flow.start();
    flow.approvalOpened();
    await jest.advanceTimersByTimeAsync(10000);
    expect(request).toHaveBeenCalledTimes(3);
    expect(flow.phase).toBe('authorize');
    expect(flow.error).toBeNull();
  });
});
