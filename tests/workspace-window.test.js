const { EventEmitter } = require('node:events');
const path = require('node:path');

jest.mock('electron', () => ({
  BrowserWindow: jest.fn(),
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
  shell: { openExternal: jest.fn() },
  contextBridge: { exposeInMainWorld: jest.fn() },
  ipcRenderer: { invoke: jest.fn(), on: jest.fn(), removeListener: jest.fn() }
}));
jest.mock('../src/modules/window-position.cjs', () => ({ centerOnCursorDisplay: jest.fn() }));

const { BrowserWindow, ipcMain, contextBridge, ipcRenderer } = require('electron');
const { centerOnCursorDisplay } = require('../src/modules/window-position.cjs');
const { WorkspaceWindow } = require('../src/workspace/window.cjs');
const { WORKSPACE_UPDATE_MS } = require('../src/shared/constants.cjs');

let ports, view, native, invoke, event;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  native = new EventEmitter();
  native.webContents = Object.assign(new EventEmitter(), {
    mainFrame: {}, send: jest.fn(), setWindowOpenHandler: jest.fn()
  });
  let visible = false, destroyed = false;
  Object.assign(native, {
    isDestroyed: () => destroyed, isVisible: () => visible, isMinimized: jest.fn(() => false),
    show: jest.fn(() => { visible = true; native.emit('show'); }),
    hide: jest.fn(() => { visible = false; native.emit('hide'); }),
    destroy: jest.fn(() => { destroyed = true; native.emit('closed'); }),
    focus: jest.fn(), restore: jest.fn(), loadFile: jest.fn(() => Promise.resolve())
  });
  BrowserWindow.mockImplementation(() => native);
  const monitoring = Object.assign(new EventEmitter(), {
    snapshot: jest.fn(() => ({ url: 'https://vibemon.io', status: 'connected', sources: [] })),
    configure: jest.fn(), disconnect: jest.fn(), poll: jest.fn(), select: jest.fn(), trend: jest.fn()
  });
  ports = {
    monitoring,
    settings: { getSnapshot: jest.fn(() => ({ version: 'test' })), invoke: jest.fn() },
    getActivity: jest.fn(() => [{ id: 'local' }]), getUsage: jest.fn(() => ({ codex: {} })),
    showCompanion: jest.fn(), reportError: jest.fn(), openExternal: jest.fn()
  };
  view = new WorkspaceWindow(ports);
  invoke = ipcMain.handle.mock.calls[0][1];
  event = { sender: native.webContents, senderFrame: native.webContents.mainFrame };
});
afterEach(() => { view.cleanup(); jest.useRealTimers(); });
function open() { view.open(); native.emit('ready-to-show'); }

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
  const cloud = { url: 'https://example.com', status: 'not-configured', sources: [] };
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
  await invoke(event, 'open-web', ['edit-resource', 'custom:gpu']);
  expect(ports.openExternal).toHaveBeenLastCalledWith('https://vibemon.io/resources/custom%3Agpu/edit');
  for (const destination of ['https://evil.example', '__proto__', 'constructor']) {
    expect(await invoke(event, 'open-web', [destination])).toEqual({ ok: false, error: 'Unknown Web destination' });
  }
  expect(await invoke(event, 'open-web', ['edit-resource', '../secret'])).toEqual({ ok: false, error: 'Unknown Web destination' });
  ports.monitoring.snapshot.mockReturnValue({ url: 'file:///private' });
  expect((await invoke(event, 'open-web', ['docs'])).ok).toBe(false);
  expect(ports.openExternal).toHaveBeenCalledTimes(2);
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
  expect(native.destroy).toHaveBeenCalledTimes(1);
  view.open(); expect(BrowserWindow).toHaveBeenCalledTimes(1);
});

test('preload exposes narrow requests and removable subscriptions without Electron events', async () => {
  jest.isolateModules(() => require('../src/workspace/preload.cjs'));
  const [name, api] = contextBridge.exposeInMainWorld.mock.calls[0];
  expect(name).toBe('workspace');
  await api.request('navigate', 'resources');
  expect(ipcRenderer.invoke).toHaveBeenCalledWith('workspace:request', 'navigate', ['resources']);
  const changed = jest.fn(), visibility = jest.fn();
  const stopChanged = api.onChange(changed), stopVisibility = api.onVisibility(visibility);
  const [[channel, listener], [visibilityChannel, visibilityListener]] = ipcRenderer.on.mock.calls;
  listener({ sender: 'private' }, { route: 'agents' }); visibilityListener({}, false);
  expect(changed).toHaveBeenCalledWith({ route: 'agents' }); expect(visibility).toHaveBeenCalledWith(false);
  stopChanged(); stopVisibility();
  expect(ipcRenderer.removeListener).toHaveBeenCalledWith(channel, listener);
  expect(ipcRenderer.removeListener).toHaveBeenCalledWith(visibilityChannel, visibilityListener);
});
