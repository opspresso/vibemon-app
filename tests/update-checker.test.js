jest.mock('electron', () => ({ app: { isPackaged: true } }));
jest.mock('electron-updater', () => {
  const { EventEmitter } = require('node:events');
  const autoUpdater = new EventEmitter();
  autoUpdater.checkForUpdates = jest.fn();
  autoUpdater.downloadUpdate = jest.fn();
  autoUpdater.quitAndInstall = jest.fn();
  return { autoUpdater };
});
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');
const { UpdateChecker } = require('../src/modules/update-checker.cjs');
let checker;
beforeEach(() => {
  autoUpdater.removeAllListeners();
  autoUpdater.checkForUpdates.mockReset().mockImplementation(async () => {
    autoUpdater.emit('update-available', { version: '3.1.0' });
    return { updateInfo: { version: '3.1.0' } };
  });
  autoUpdater.downloadUpdate.mockReset().mockResolvedValue(['verified-update.zip']);
  autoUpdater.quitAndInstall.mockReset();
  app.isPackaged = true;
  checker = new UpdateChecker();
  checker.onStateChanged = jest.fn();
});

test('checking, current and failed outcomes stay distinct from not checked', async () => {
  expect(checker.getState()).toEqual({ status: null, version: null });
  const promise = checker.checkForUpdates();
  expect(checker.getState().status).toBe('checking');
  await promise;
  expect(checker.getState()).toEqual({ status: 'available', version: '3.1.0' });
  autoUpdater.checkForUpdates.mockImplementationOnce(async () => { autoUpdater.emit('update-not-available'); });
  await checker.checkForUpdates();
  expect(checker.getState()).toEqual({ status: 'current', version: null });
  autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('Network unavailable'));
  await expect(checker.checkForUpdates()).rejects.toThrow('Network unavailable');
  expect(checker.getState()).toEqual({ status: 'error', version: null });
  await checker.checkForUpdates();
  expect(checker.getState().status).toBe('available');
});

test('concurrent checks share one SDK request', async () => {
  const first = checker.checkForUpdates(), second = checker.checkForUpdates();
  expect(first).toBe(second);
  await Promise.all([first, second]);
  expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
});

test('downloading waits for a separate restart action and never installs on ordinary quit', async () => {
  expect(autoUpdater.autoDownload).toBe(false);
  expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  await checker.checkForUpdates();
  const download = checker.downloadUpdate();
  expect(checker.getState()).toEqual({ status: 'downloading', version: '3.1.0' });
  await download;
  expect(checker.getState()).toEqual({ status: 'downloaded', version: '3.1.0' });
  expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  await checker.downloadUpdate();
  expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  checker.installDownloaded();
  expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
});

test('background checks cannot overwrite an active or downloaded update', async () => {
  let resolve;
  autoUpdater.downloadUpdate.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  await checker.checkForUpdates(); autoUpdater.checkForUpdates.mockClear();
  const first = checker.downloadUpdate(), second = checker.downloadUpdate();
  expect(first).toBe(second);
  await checker.checkForUpdates();
  expect(checker.getState().status).toBe('downloading');
  resolve(); await first;
  await checker.checkForUpdates();
  expect(checker.getState().status).toBe('downloaded');
  expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
});

test('signature verification failure propagates, keeps retry available and never installs', async () => {
  await checker.checkForUpdates();
  const error = new Error('Untrusted Authenticode signature');
  autoUpdater.downloadUpdate.mockImplementationOnce(async () => {
    autoUpdater.emit('error', error);
    throw error;
  });
  await expect(checker.downloadUpdate()).rejects.toThrow('Untrusted Authenticode signature');
  expect(checker.getState()).toEqual({ status: 'available', version: '3.1.0' });
  expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  await checker.downloadUpdate();
  expect(checker.getState().status).toBe('downloaded');
});

test('invalid download/install actions do not call the SDK', async () => {
  await expect(checker.downloadUpdate()).rejects.toThrow('available update');
  expect(() => checker.installDownloaded()).toThrow('Download the update');
  expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
});

test('unpackaged apps do not request native updates', async () => {
  app.isPackaged = false;
  expect(await checker.checkForUpdates()).toBeNull();
  autoUpdater.emit('update-available', { version: '3.1.0' });
  await expect(checker.downloadUpdate()).rejects.toThrow();
  expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
});

test('SDK events update availability without redundant notifications', () => {
  autoUpdater.emit('checking-for-update');
  expect(checker.getState().status).toBe('checking');
  autoUpdater.emit('update-available', { version: '3.1.0' });
  checker.onStateChanged.mockClear();
  autoUpdater.emit('update-available', { version: '3.1.0' });
  expect(checker.onStateChanged).not.toHaveBeenCalled();
  autoUpdater.emit('download-progress');
  expect(checker.getState()).toEqual({ status: 'downloading', version: '3.1.0' });
  autoUpdater.emit('update-downloaded', { version: '3.1.0' });
  expect(checker.getState()).toEqual({ status: 'downloaded', version: '3.1.0' });
  autoUpdater.emit('error', new Error('Install could not finish'));
  expect(checker.getState()).toEqual({ status: 'error', version: null });
});
