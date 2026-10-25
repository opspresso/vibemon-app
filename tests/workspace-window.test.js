const { EventEmitter } = require('node:events');
const path = require('node:path');

jest.mock('electron', () => ({
  BrowserWindow: jest.fn(),
  autoUpdater: new (require('node:events').EventEmitter)(),
  nativeTheme: Object.assign(new (require('node:events').EventEmitter)(), { shouldUseDarkColors: false }),
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn(), on: jest.fn(), off: jest.fn() },
  shell: { openExternal: jest.fn() },
  contextBridge: { exposeInMainWorld: jest.fn() },
  ipcRenderer: { invoke: jest.fn(), on: jest.fn(), removeListener: jest.fn(), sendSync: jest.fn(() => ({ locale: 'en', messages: { en: {} } })) }
}));
jest.mock('../src/modules/window-position.cjs', () => ({ centerOnCursorDisplay: jest.fn() }));

const { BrowserWindow, ipcMain, contextBridge, ipcRenderer, autoUpdater, nativeTheme } = require('electron');
const { centerOnCursorDisplay } = require('../src/modules/window-position.cjs');
const { WorkspaceWindow } = require('../src/workspace/window.cjs');
const { WORKSPACE_UPDATE_MS } = require('../src/shared/constants.cjs');
const { setLocale } = require('../src/shared/i18n/locale.cjs');

let ports, view, native, invoke, event;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  native = new EventEmitter();
  native.webContents = Object.assign(new EventEmitter(), {
    mainFrame: {}, send: jest.fn(), setWindowOpenHandler: jest.fn()
  });
  let visible = false, destroyed = false, focused = false;
  Object.assign(native, {
    isDestroyed: () => destroyed, isVisible: () => visible, isMinimized: jest.fn(() => false),
    isFocused: jest.fn(() => focused),
    show: jest.fn(() => { visible = true; focused = true; native.emit('show'); }),
    hide: jest.fn(() => { visible = false; focused = false; native.emit('hide'); }),
    destroy: jest.fn(() => { destroyed = true; native.emit('closed'); }),
    focus: jest.fn(() => { focused = true; }), restore: jest.fn(), loadFile: jest.fn(() => Promise.resolve()),
    setBackgroundColor: jest.fn()
  });
  BrowserWindow.mockImplementation(() => native);
  const monitoring = Object.assign(new EventEmitter(), {
    snapshot: jest.fn(() => ({ url: 'https://vibemon.io', status: 'connected', sources: [], accounts: [] })),
    configure: jest.fn(), disconnect: jest.fn(), poll: jest.fn(), select: jest.fn(), trend: jest.fn(), removalUrl: jest.fn()
  });
  ports = {
    monitoring,
    settings: { getSnapshot: jest.fn(() => ({ version: 'test', hooks: [], vibemonConfig: { status: {} }, cloudDelivery: { status: 'verified' }, update: { status: 'current', version: null } })), invoke: jest.fn() },
    getActivity: jest.fn(() => [{ id: 'local' }]), getUsage: jest.fn(() => ({ codex: {} })),
    showCompanion: jest.fn(), reportError: jest.fn(), openExternal: jest.fn(),
    signIn: { signal: new globalThis.AbortController().signal, signIn: jest.fn(async (_url, scope, adopt) => adopt(`token-for-${scope}`, ports.signIn.signal)), cancel: jest.fn() }
  };
  view = new WorkspaceWindow(ports);
  invoke = ipcMain.handle.mock.calls[0][1];
  event = { sender: native.webContents, senderFrame: native.webContents.mainFrame };
});
afterEach(() => { view.cleanup(); jest.useRealTimers(); });
function open() { view.open(); native.emit('ready-to-show'); }

test('native update shutdown releases hide-on-close before app before-quit', () => {
  open();
  const close = { preventDefault: jest.fn() };
  autoUpdater.emit('before-quit-for-update');
  native.emit('close', close);
  expect(close.preventDefault).not.toHaveBeenCalled();
  expect(native.isDestroyed()).toBe(true);
  expect(view.disposed).toBe(true);
  expect(autoUpdater.listenerCount('before-quit-for-update')).toBe(0);
  view.open();
  expect(BrowserWindow).toHaveBeenCalledTimes(1);
});

test('the native window background follows the OS theme with the shared background token', () => {
  nativeTheme.shouldUseDarkColors = true;
  open();
  expect(BrowserWindow.mock.calls[0][0].backgroundColor).toBe('#111722');
  nativeTheme.shouldUseDarkColors = false;
  nativeTheme.emit('updated');
  expect(native.setBackgroundColor).toHaveBeenLastCalledWith('#f6f8fb');
  view.cleanup();
  expect(nativeTheme.listenerCount('updated')).toBe(0);
});

test('one sandboxed window serves navigation and denies external window navigation', async () => {
  open();
  expect(BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({ webPreferences: expect.objectContaining({ contextIsolation: true, nodeIntegration: false, sandbox: true }) }));
  expect(native.loadFile).toHaveBeenCalledWith(path.resolve(__dirname, '../src/workspace/index.html'));
  expect(centerOnCursorDisplay).toHaveBeenCalledWith(native);
  expect(native.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' });
  const navigation = { preventDefault: jest.fn() };
  native.webContents.emit('will-navigate', navigation);
  expect(navigation.preventDefault).toHaveBeenCalled();
  expect(await invoke(event, 'navigate', ['agents'])).toMatchObject({ ok: true, value: { route: 'agents' } });
  native.isMinimized.mockReturnValue(true);
  view.open('companion');
  expect(BrowserWindow).toHaveBeenCalledTimes(1);
  expect(native.restore).toHaveBeenCalledTimes(1);
  expect(view.snapshot().route).toBe('companion');
  expect(native.show).toHaveBeenCalledTimes(1);
  expect(native.focus).not.toHaveBeenCalled();
  native.isFocused.mockReturnValue(false);
  view.open('resources');
  expect(native.show).toHaveBeenCalledTimes(2);
});

test('only the workspace main frame may request data or perform actions', async () => {
  await expect(invoke(event, 'snapshot')).rejects.toThrow('Untrusted');
  open();
  await expect(invoke({ ...event, sender: {} }, 'disconnect')).rejects.toThrow('Untrusted');
  await expect(invoke({ ...event, senderFrame: {} }, 'disconnect')).rejects.toThrow('Untrusted');
  expect(ports.monitoring.disconnect).not.toHaveBeenCalled();
  expect(await invoke(event, 'snapshot')).toMatchObject({ ok: true, value: { activity: [{ id: 'local' }] } });
  native.destroy();
  await expect(invoke(event, 'snapshot')).rejects.toThrow('Untrusted');
});

test.each([{}, 'not-an-array', [1, 2, 3, 4]])('rejects malformed IPC argument containers: %p', async args => {
  open();
  await expect(invoke(event, 'settings', args)).rejects.toThrow('Invalid workspace arguments');
  expect(ports.settings.invoke).not.toHaveBeenCalled();
});

test('unknown routes and actions report errors without changing the current route', async () => {
  open();
  expect(await invoke(event, 'navigate', ['__proto__'])).toEqual({ ok: false, error: 'Unknown workspace page' });
  expect(view.snapshot().route).toBe('overview');
  expect(await invoke(event, 'execute', ['rm'])).toEqual({ ok: false, error: 'Unknown workspace command' });
  expect(await invoke(event, 'settings', ['set-render-mode', '3d'])).toEqual({ ok: false, error: 'Invalid settings arguments' });
});

test('coalesces a burst of local events without rereading unrelated settings or usage', () => {
  open();
  ports.settings.getSnapshot.mockClear(); ports.getActivity.mockClear(); ports.getUsage.mockClear(); native.webContents.send.mockClear();
  for (let index = 0; index < 250; index++) view.notify('activity');
  expect(ports.getActivity).not.toHaveBeenCalled();
  jest.advanceTimersByTime(WORKSPACE_UPDATE_MS);
  expect(ports.getActivity).toHaveBeenCalledTimes(1);
  expect(ports.settings.getSnapshot).not.toHaveBeenCalled();
  expect(ports.getUsage).not.toHaveBeenCalled();
  expect(native.webContents.send).toHaveBeenCalledTimes(1);
});

test('hidden windows suspend rendering and receive the newest state when reopened', () => {
  open();
  view.notify('activity');
  const close = { preventDefault: jest.fn() };
  native.emit('close', close);
  expect(close.preventDefault).toHaveBeenCalled();
  expect(native.isVisible()).toBe(false);
  native.webContents.send.mockClear(); ports.getActivity.mockClear(); ports.getUsage.mockClear();
  const cloud = { url: 'https://example.com', status: 'not-configured', sources: [], accounts: [] };
  ports.monitoring.emit('change', cloud);
  view.notify('settings');
  jest.advanceTimersByTime(WORKSPACE_UPDATE_MS * 2);
  expect(native.webContents.send).not.toHaveBeenCalled();
  expect(ports.getActivity).not.toHaveBeenCalled();
  expect(ports.getUsage).not.toHaveBeenCalled();
  view.open('resources');
  expect(native.webContents.send).toHaveBeenCalledWith('workspace:visibility', true);
  expect(native.webContents.send).toHaveBeenCalledWith('workspace:changed', expect.objectContaining({ cloud, route: 'resources' }));
  expect(ports.getUsage).toHaveBeenCalledTimes(1);
});

test('only closing the window tells the page to end its work; hiding or minimizing does not', () => {
  open();
  native.webContents.send.mockClear();
  // Minimizing, and hiding the App (Cmd+H, app.hide()), keep a sign-in in progress.
  native.emit('minimize');
  native.hide();
  expect(native.webContents.send).not.toHaveBeenCalledWith('workspace:closed');
  expect(native.webContents.send).toHaveBeenCalledWith('workspace:visibility', false);
  native.show();
  native.webContents.send.mockClear();
  native.emit('close', { preventDefault: jest.fn() });
  expect(native.webContents.send.mock.calls.map(([channel]) => channel)).toEqual(['workspace:closed', 'workspace:visibility']);
  expect(native.isVisible()).toBe(false);
});

test('every frame carries a newer sequence, so the page can drop a late reply', async () => {
  open();
  const reply = (await invoke(event, 'navigate', ['agents'])).value;
  view.notify('activity');
  jest.advanceTimersByTime(WORKSPACE_UPDATE_MS);
  const published = native.webContents.send.mock.calls.filter(([channel]) => channel === 'workspace:changed').at(-1)[1];
  expect(Number.isSafeInteger(reply.sequence)).toBe(true);
  expect(published.sequence).toBeGreaterThan(reply.sequence);
  expect(view.snapshot().sequence).toBeGreaterThan(published.sequence);
});

test('a command that returns a frame does not publish the same frame again', async () => {
  open();
  jest.advanceTimersByTime(WORKSPACE_UPDATE_MS * 2);
  native.webContents.send.mockClear();
  expect(await invoke(event, 'navigate', ['agents'])).toMatchObject({ ok: true, value: { route: 'agents' } });
  jest.advanceTimersByTime(WORKSPACE_UPDATE_MS * 2);
  expect(native.webContents.send).not.toHaveBeenCalledWith('workspace:changed', expect.anything());
  view.notify('activity');
  jest.advanceTimersByTime(WORKSPACE_UPDATE_MS);
  expect(native.webContents.send).toHaveBeenCalledWith('workspace:changed', expect.objectContaining({ route: 'agents' }));
});

test('forwards monitoring commands and reports secure-storage failures without exposing tokens', async () => {
  open();
  const config = { url: 'https://vibemon.io', token: `vm_${'f'.repeat(60)}` };
  ports.monitoring.configure.mockResolvedValue({ status: 'connected' });
  expect(await invoke(event, 'configure', [config])).toEqual({ ok: true, value: { status: 'connected' } });
  expect(ports.monitoring.configure).toHaveBeenCalledWith(config);
  await invoke(event, 'refresh'); expect(ports.monitoring.poll).toHaveBeenCalledWith(true);
  await invoke(event, 'select', [{ sources: ['gpu'] }]); expect(ports.monitoring.select).toHaveBeenCalledWith({ sources: ['gpu'] });
  await invoke(event, 'trend', [{ sourceId: 'gpu' }]); expect(ports.monitoring.trend).toHaveBeenCalledWith({ sourceId: 'gpu' });
  await invoke(event, 'disconnect'); expect(ports.monitoring.disconnect).toHaveBeenCalled();
  ports.monitoring.configure.mockRejectedValue(new Error(`Rejected ${config.token}`));
  expect(await invoke(event, 'configure', [config])).toEqual({ ok: false, error: 'Rejected [redacted]' });
  ports.monitoring.configure.mockRejectedValue(Object.assign(new Error('Storage failed'), { code: 'secure-storage-unavailable' }));
  expect(await invoke(event, 'configure', [config])).toEqual({ ok: false, error: 'secure-storage-unavailable' });
});

test('settings mutations invalidate settings only and preserve service validation errors', async () => {
  open();
  ports.settings.getSnapshot.mockClear(); ports.getUsage.mockClear();
  await invoke(event, 'settings', ['set-character-scale', [85]]);
  expect(ports.settings.invoke).toHaveBeenCalledWith('set-character-scale', 85);
  jest.advanceTimersByTime(WORKSPACE_UPDATE_MS);
  expect(ports.settings.getSnapshot).toHaveBeenCalledTimes(1);
  expect(ports.getUsage).not.toHaveBeenCalled();
  ports.settings.invoke.mockRejectedValue(new Error('Unsupported scale'));
  expect(await invoke(event, 'settings', ['set-character-scale', [-1]])).toEqual({ ok: false, error: 'Unsupported scale' });
  await invoke(event, 'show-companion'); expect(ports.showCompanion).toHaveBeenCalledTimes(1);
});

test('external links use an explicit destination on the validated workspace origin', async () => {
  open();
  expect(await invoke(event, 'open-web', ['account'])).toEqual({ ok: true, value: true });
  expect(ports.openExternal).toHaveBeenLastCalledWith('https://vibemon.io/account');
  await invoke(event, 'open-write-token-account', ['https://collector.example']);
  expect(ports.openExternal).toHaveBeenLastCalledWith('https://collector.example/account?purpose=write');
  expect((await invoke(event, 'open-write-token-account', ['https://secret@other.example'])).ok).toBe(false);
  await invoke(event, 'open-web', ['edit-resource', 'custom:gpu']);
  expect(ports.openExternal).toHaveBeenLastCalledWith('https://vibemon.io/resources/custom%3Agpu/edit');
  for (const destination of ['https://evil.example', '__proto__', 'constructor']) {
    expect(await invoke(event, 'open-web', [destination])).toEqual({ ok: false, error: 'Unknown Web destination' });
  }
  expect(await invoke(event, 'open-web', ['edit-resource', '../secret'])).toEqual({ ok: false, error: 'Unknown Web destination' });
  ports.monitoring.snapshot.mockReturnValue({ url: 'file:///private' });
  expect((await invoke(event, 'open-web', ['docs'])).ok).toBe(false);
  expect(ports.openExternal).toHaveBeenCalledTimes(3);
});

test('failed navigation destroys the broken window and reports the load error', async () => {
  const error = new Error('Missing workspace assets');
  native.loadFile.mockRejectedValue(error);
  view.open();
  await Promise.resolve();
  expect(native.destroy).toHaveBeenCalledTimes(1);
  expect(ports.reportError).toHaveBeenCalledWith(error);
});

test('cleanup stops updates, removes IPC and listeners, and prevents reopening', () => {
  open(); view.notify('activity'); native.webContents.send.mockClear();
  view.cleanup();
  jest.advanceTimersByTime(WORKSPACE_UPDATE_MS);
  expect(native.webContents.send).not.toHaveBeenCalled();
  expect(ports.monitoring.listenerCount('change')).toBe(0);
  expect(ipcMain.removeHandler).toHaveBeenCalledWith('workspace:request');
  expect(ipcMain.off).toHaveBeenCalledWith('workspace:language', ipcMain.on.mock.calls[0][1]);
  expect(native.destroy).toHaveBeenCalledTimes(1);
  view.open(); expect(BrowserWindow).toHaveBeenCalledTimes(1);
});

test('preload exposes narrow requests and removable subscriptions without Electron events', async () => {
  jest.isolateModules(() => require('../src/workspace/preload.cjs'));
  const [name, api] = contextBridge.exposeInMainWorld.mock.calls[0];
  expect(name).toBe('workspace');
  await api.request('navigate', 'resources');
  expect(ipcRenderer.invoke).toHaveBeenCalledWith('workspace:request', 'navigate', ['resources']);
  const changed = jest.fn(), visibility = jest.fn(), closed = jest.fn();
  const stopChanged = api.onChange(changed), stopVisibility = api.onVisibility(visibility), stopClose = api.onClose(closed);
  const [[channel, listener], [visibilityChannel, visibilityListener], [closeChannel, closeListener]] = ipcRenderer.on.mock.calls;
  listener({ sender: 'private' }, { route: 'agents' }); visibilityListener({}, false); closeListener({ sender: 'private' });
  expect(changed).toHaveBeenCalledWith({ route: 'agents' }); expect(visibility).toHaveBeenCalledWith(false);
  expect(closeChannel).toBe('workspace:closed'); expect(closed).toHaveBeenCalledWith(undefined);
  stopChanged(); stopVisibility(); stopClose();
  expect(ipcRenderer.removeListener).toHaveBeenCalledWith(channel, listener);
  expect(ipcRenderer.removeListener).toHaveBeenCalledWith(visibilityChannel, visibilityListener);
  expect(ipcRenderer.removeListener).toHaveBeenCalledWith(closeChannel, closeListener);
  expect(ipcRenderer.sendSync).toHaveBeenCalledWith('workspace:language');
  expect(api.language).toEqual({ locale: 'en', messages: { en: {} } });
});

test('only the workspace main frame receives the App language and its messages', () => {
  const [channel, reply] = ipcMain.on.mock.calls[0];
  expect(channel).toBe('workspace:language');
  open();
  setLocale('ko');
  try {
    const trusted = { ...event };
    reply(trusted);
    expect(trusted.returnValue.locale).toBe('ko');
    expect(trusted.returnValue.messages.ko['nav.overview']).toBe('개요');
    expect(trusted.returnValue.messages.en['nav.overview']).toBe('Overview');
    expect(trusted.returnValue.messages.ko['state.standby']).toBe('대기');
    const frame = { sender: native.webContents, senderFrame: {} };
    reply(frame);
    expect(frame.returnValue).toBeNull();
  } finally {
    setLocale('en');
  }
});

test('signs in through VibeMon: a read token connects the workspace, a write token goes to hook delivery', async () => {
  open();
  ports.monitoring.configure.mockResolvedValue({ status: 'connected' });
  await expect(invoke(event, 'sign-in', ['https://vibemon.io'])).resolves.toEqual({ ok: true, value: { status: 'connected' } });
  // The dashboard token may also connect and disconnect services.
  expect(ports.signIn.signIn).toHaveBeenCalledWith('https://vibemon.io', 'read usage', expect.any(Function));
  expect(ports.monitoring.configure).toHaveBeenCalledWith({ url: 'https://vibemon.io', token: 'token-for-read usage' }, { signal: ports.signIn.signal });
  await invoke(event, 'sign-in-cloud-delivery', ['https://vibemon.io']);
  expect(ports.signIn.signIn).toHaveBeenCalledWith('https://vibemon.io', 'write', expect.any(Function));
  expect(ports.settings.invoke).toHaveBeenCalledWith('configure-cloud-delivery', { url: 'https://vibemon.io', token: 'token-for-write' }, { signal: ports.signIn.signal });
  await invoke(event, 'cancel-sign-in', []);
  expect(ports.signIn.cancel).toHaveBeenCalled();
  // A sign-in failure reaches the page as a sentence, without token values.
  ports.signIn.signIn.mockRejectedValueOnce(Object.assign(new Error('You selected Deny on VibeMon.'), { reason: 'denied' }));
  await expect(invoke(event, 'sign-in', ['https://vibemon.io'])).resolves.toEqual({ ok: false, error: 'You selected Deny on VibeMon.' });
});

test.each([
  ['configure', [{ url: 'https://vibemon.io', token: 'manual' }]],
  ['disconnect', []],
  ['settings', ['configure-cloud-delivery', [{ url: 'https://vibemon.io', token: 'manual' }]]],
  ['settings', ['disconnect-cloud-delivery', []]]
])('%s cancels an unfinished sign-in before changing a connection', async (command, args) => {
  open();
  await invoke(event, command, args);
  expect(ports.signIn.cancel).toHaveBeenCalledTimes(1);
});


test('removal opens only the owner-bound URL provided by the monitoring client', async () => {
  open();
  ports.monitoring.removalUrl.mockResolvedValue('https://vibemon.io/dashboard?remove=source&id=spark&owner=fixture');
  expect(await invoke(event, 'remove-monitor', [{ kind: 'source', id: 'spark' }])).toEqual({ ok: true, value: true });
  expect(ports.openExternal).toHaveBeenLastCalledWith('https://vibemon.io/dashboard?remove=source&id=spark&owner=fixture');
  ports.monitoring.removalUrl.mockRejectedValue(new Error('Connection changed'));
  expect((await invoke(event, 'remove-monitor', [{ kind: 'account', id: 'codex:work' }])).ok).toBe(false);
  expect(ports.openExternal).toHaveBeenCalledTimes(1);
});

describe('connected services', () => {
  const SIGN_IN = '6f1c2a4e-8b7d-4c3a-9e21-5d6f7a8b9c01';
  let services, clipboard;
  beforeEach(() => {
    view.cleanup();
    jest.clearAllMocks();
    clipboard = [];
    services = {
      list: jest.fn(async () => ({ providers: ['claude'], connections: [], serverTime: '2026-10-25T00:00:00.000Z' })),
      start: jest.fn(), complete: jest.fn(), cancel: jest.fn(async () => true), refresh: jest.fn(async id => ({ id })), disconnect: jest.fn(async () => true),
      authorization: jest.fn(id => {
        if (id !== SIGN_IN) throw Object.assign(new Error('usage-authorization-expired'), { code: 'usage-authorization-expired' });
        return { id, prompt: { kind: 'device', url: 'https://auth.openai.com/codex/device', userCode: 'BCDF-GHJK', interval: 5 } };
      })
    };
    view = new WorkspaceWindow({ ...ports, services, writeClipboard: value => clipboard.push(value) });
    invoke = ipcMain.handle.mock.calls[0][1];
  });

  test('requests reach the usage client and changes reload the sources', async () => {
    open();
    expect((await invoke(event, 'usage', [])).value.providers).toEqual(['claude']);
    expect(await invoke(event, 'usage-refresh', ['a'])).toEqual({ ok: true, value: { id: 'a' } });
    expect(await invoke(event, 'usage-disconnect', ['a'])).toEqual({ ok: true, value: true });
    services.complete.mockResolvedValueOnce({ status: 'pending', interval: 5 }).mockResolvedValueOnce({ status: 'connected', connection: { id: 'b' } });
    await invoke(event, 'usage-complete', [SIGN_IN]);
    expect(ports.monitoring.poll).toHaveBeenCalledTimes(2);
    await invoke(event, 'usage-complete', [SIGN_IN, undefined]);
    // Refresh, disconnect, and a completed sign-in each reload the full source list at once.
    expect(ports.monitoring.poll.mock.calls).toEqual([[true], [true], [true]]);
    await invoke(event, 'usage-cancel', [SIGN_IN]);
    expect(services.cancel).toHaveBeenCalledWith(SIGN_IN);
  });

  test('the page opens and copies only what a started sign-in returned', async () => {
    open();
    expect(await invoke(event, 'usage-open', [SIGN_IN])).toEqual({ ok: true, value: true });
    expect(ports.openExternal).toHaveBeenLastCalledWith('https://auth.openai.com/codex/device');
    expect(await invoke(event, 'usage-copy', [SIGN_IN])).toEqual({ ok: true, value: true });
    expect(clipboard).toEqual(['BCDF-GHJK']);
    expect(await invoke(event, 'usage-open', ['https://evil.example'])).toEqual({ ok: false, error: 'usage-authorization-expired' });
    expect(ports.openExternal).toHaveBeenCalledTimes(1);
  });

  test('a usage failure reaches the page as its code and leaves the dashboard connection alone', async () => {
    open();
    services.start.mockRejectedValue(Object.assign(new Error('usage-sign-in-required'), { code: 'usage-sign-in-required' }));
    expect(await invoke(event, 'usage-start', ['claude'])).toEqual({ ok: false, error: 'usage-sign-in-required' });
    expect(ports.monitoring.configure).not.toHaveBeenCalled();
    expect(ports.monitoring.disconnect).not.toHaveBeenCalled();
  });

  test('Connected services is a Settings page', async () => {
    open();
    expect((await invoke(event, 'navigate', ['services'])).value.route).toBe('services');
  });
});
