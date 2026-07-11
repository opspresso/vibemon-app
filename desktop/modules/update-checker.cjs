/**
 * Auto-update checker for Vibe Monitor
 *
 * Wraps electron-updater's autoUpdater (GitHub Releases provider) to detect
 * new versions in the background and let the user trigger a one-click
 * download + install from the tray menu. Downloads are never started
 * automatically — only a menu click does that.
 */

const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

class UpdateChecker {
  constructor() {
    // null | 'checking' | 'available' | 'downloading' | 'downloaded'
    this.state = { status: null, version: null };
    // Set by main.js to refresh the tray icon/menu when state changes.
    this.onStateChanged = null;
    this.downloadInProgress = false;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => this.setState('checking'));
    autoUpdater.on('update-available', (info) => this.setState('available', info.version));
    autoUpdater.on('update-not-available', () => this.setState(null));
    autoUpdater.on('download-progress', () => this.setState('downloading', this.state.version));
    autoUpdater.on('update-downloaded', (info) => this.setState('downloaded', info.version));
    autoUpdater.on('error', (err) => {
      console.error('[UpdateChecker]', err);
      this.setState(null);
    });
  }

  setState(status, version) {
    const nextVersion = version || null;
    if (this.state.status === status && this.state.version === nextVersion) {
      return;
    }
    this.state = { status: status || null, version: nextVersion };
    if (this.onStateChanged) {
      this.onStateChanged();
    }
  }

  /**
   * Non-blocking read of the current update state, for UI rendering.
   * @returns {{status: string|null, version: string|null}}
   */
  getState() {
    return { ...this.state };
  }

  /**
   * Ask GitHub Releases whether a newer version is published. No-op outside
   * a packaged app (unpackaged builds have no update metadata bundled), or
   * while a download is already in progress — checkForUpdates() can flip
   * state via the checking/available/not-available/error events, which
   * would otherwise clobber the downloading/downloaded state mid-download.
   */
  async checkForUpdates() {
    if (!app.isPackaged || this.downloadInProgress) {
      return null;
    }
    try {
      return await autoUpdater.checkForUpdates();
    } catch (err) {
      console.error('[UpdateChecker] check failed:', err);
      this.setState(null);
      return null;
    }
  }

  /**
   * One-click upgrade: download the update and immediately quit + install.
   * Concurrent calls are ignored.
   * @param {string} version - target version, for tray label purposes
   */
  async downloadAndInstall(version) {
    if (this.downloadInProgress) {
      return;
    }
    this.downloadInProgress = true;
    this.setState('downloading', version);
    try {
      await autoUpdater.downloadUpdate();
      autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      console.error('[UpdateChecker] download/install failed:', err);
      this.setState('available', version);
    } finally {
      this.downloadInProgress = false;
    }
  }

  /**
   * Install an update that has already finished downloading (the tray's
   * "Restart to install vX" action). electron-updater's downloadUpdate()
   * does not cache/reuse a prior completed download — calling it again
   * would re-fetch the whole package — so this skips straight to install.
   */
  installDownloaded() {
    autoUpdater.quitAndInstall(false, true);
  }
}

module.exports = { UpdateChecker };
