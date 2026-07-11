/**
 * Tests for update-checker.cjs
 */

jest.mock('electron', () => ({
  app: { isPackaged: true }
}));

jest.mock('electron-updater', () => {
  const { EventEmitter } = require('events');
  const autoUpdater = new EventEmitter();
  autoUpdater.checkForUpdates = jest.fn().mockResolvedValue({ updateInfo: { version: '9.9.9' } });
  autoUpdater.downloadUpdate = jest.fn().mockResolvedValue();
  autoUpdater.quitAndInstall = jest.fn();
  return { autoUpdater };
});

const { app } = require('electron');
const { autoUpdater } = require('electron-updater');
const { UpdateChecker } = require('../modules/update-checker.cjs');

// Fresh UpdateChecker per test: clears prior listeners/mock calls since
// autoUpdater is a shared EventEmitter singleton across the mocked module.
function freshChecker() {
  autoUpdater.removeAllListeners();
  autoUpdater.checkForUpdates.mockClear();
  autoUpdater.downloadUpdate.mockClear();
  autoUpdater.quitAndInstall.mockClear();
  return new UpdateChecker();
}

describe('UpdateChecker', () => {
  beforeEach(() => {
    app.isPackaged = true;
  });

  describe('event -> state transitions', () => {
    test('checking-for-update sets status to checking and notifies', () => {
      const checker = freshChecker();
      const onStateChanged = jest.fn();
      checker.onStateChanged = onStateChanged;

      autoUpdater.emit('checking-for-update');

      expect(checker.getState()).toEqual({ status: 'checking', version: null });
      expect(onStateChanged).toHaveBeenCalledTimes(1);
    });

    test('update-available sets status/version and notifies', () => {
      const checker = freshChecker();
      const onStateChanged = jest.fn();
      checker.onStateChanged = onStateChanged;

      autoUpdater.emit('update-available', { version: '2.0.0' });

      expect(checker.getState()).toEqual({ status: 'available', version: '2.0.0' });
      expect(onStateChanged).toHaveBeenCalledTimes(1);
    });

    test('update-not-available resets state to null', () => {
      const checker = freshChecker();
      autoUpdater.emit('update-available', { version: '2.0.0' });
      const onStateChanged = jest.fn();
      checker.onStateChanged = onStateChanged;

      autoUpdater.emit('update-not-available');

      expect(checker.getState()).toEqual({ status: null, version: null });
      expect(onStateChanged).toHaveBeenCalledTimes(1);
    });

    test('update-downloaded sets status to downloaded with version', () => {
      const checker = freshChecker();

      autoUpdater.emit('update-downloaded', { version: '2.0.0' });

      expect(checker.getState()).toEqual({ status: 'downloaded', version: '2.0.0' });
    });

    test('error resets state to null and does not throw', () => {
      const checker = freshChecker();
      autoUpdater.emit('update-available', { version: '2.0.0' });

      expect(() => autoUpdater.emit('error', new Error('boom'))).not.toThrow();
      expect(checker.getState()).toEqual({ status: null, version: null });
    });

    test('identical state does not re-notify', () => {
      const checker = freshChecker();
      autoUpdater.emit('update-available', { version: '2.0.0' });
      const onStateChanged = jest.fn();
      checker.onStateChanged = onStateChanged;

      autoUpdater.emit('update-available', { version: '2.0.0' });

      expect(onStateChanged).not.toHaveBeenCalled();
    });
  });

  describe('checkForUpdates', () => {
    test('skips and returns null when app is not packaged', async () => {
      app.isPackaged = false;
      const checker = freshChecker();

      const result = await checker.checkForUpdates();

      expect(result).toBeNull();
      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });

    test('delegates to autoUpdater.checkForUpdates when packaged', async () => {
      const checker = freshChecker();

      const result = await checker.checkForUpdates();

      expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ updateInfo: { version: '9.9.9' } });
    });

    test('resets state and returns null on check failure', async () => {
      const checker = freshChecker();
      autoUpdater.emit('update-available', { version: '2.0.0' });
      autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('network down'));

      const result = await checker.checkForUpdates();

      expect(result).toBeNull();
      expect(checker.getState()).toEqual({ status: null, version: null });
    });
  });

  describe('downloadAndInstall', () => {
    test('downloads then quits and installs', async () => {
      const checker = freshChecker();

      await checker.downloadAndInstall('2.0.0');

      expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
      expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    });

    test('ignores a concurrent call while a download is in progress', async () => {
      const checker = freshChecker();
      let resolveDownload;
      autoUpdater.downloadUpdate.mockReturnValueOnce(new Promise((resolve) => { resolveDownload = resolve; }));

      const first = checker.downloadAndInstall('2.0.0');
      const second = checker.downloadAndInstall('2.0.0');

      resolveDownload();
      await Promise.all([first, second]);

      expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    });

    test('reverts state to available on download failure', async () => {
      const checker = freshChecker();
      autoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('download failed'));

      await checker.downloadAndInstall('2.0.0');

      expect(checker.getState()).toEqual({ status: 'available', version: '2.0.0' });
      expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });
  });
});
