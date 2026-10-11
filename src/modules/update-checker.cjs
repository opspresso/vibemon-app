/** Native updater adapter. Downloading never quits the application. */
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

class UpdateChecker {
  constructor() {
    // null means not checked; current and error are explicit outcomes.
    this.state = { status: null, version: null };
    this.onStateChanged = null;
    this.checkPromise = null;
    this.downloadPromise = null;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('checking-for-update', () => this.setState('checking'));
    autoUpdater.on('update-available', info => this.setState('available', info.version));
    autoUpdater.on('update-not-available', () => this.setState('current'));
    autoUpdater.on('download-progress', () => this.setState('downloading', this.state.version));
    autoUpdater.on('update-downloaded', info => this.setState('downloaded', info.version));
    autoUpdater.on('error', () => {
      // The active operation owns its rejection. A download failure retains
      // the available version so the user can explicitly try it again.
      if (!this.downloadPromise) this.setState('error');
    });
  }

  setState(status, version = null) {
    if (this.state.status === status && this.state.version === version) return;
    this.state = { status, version };
    this.onStateChanged?.();
  }

  getState() { return { ...this.state }; }

  checkForUpdates() {
    if (!app.isPackaged || this.downloadPromise || this.state.status === 'downloaded') return Promise.resolve(null);
    if (this.checkPromise) return this.checkPromise;
    this.setState('checking');
    this.checkPromise = Promise.resolve().then(() => autoUpdater.checkForUpdates()).catch(error => {
      this.setState('error');
      throw error;
    }).finally(() => { this.checkPromise = null; });
    return this.checkPromise;
  }

  downloadUpdate() {
    if (this.downloadPromise) return this.downloadPromise;
    if (this.state.status === 'downloaded') return Promise.resolve();
    if (!app.isPackaged || this.state.status !== 'available') return Promise.reject(new Error('Check for an available update before downloading'));
    const version = this.state.version;
    this.setState('downloading', version);
    this.downloadPromise = Promise.resolve().then(() => autoUpdater.downloadUpdate()).then(() => {
      this.setState('downloaded', version);
    }).catch(error => {
      this.setState('available', version);
      throw error;
    }).finally(() => { this.downloadPromise = null; });
    return this.downloadPromise;
  }

  installDownloaded() {
    if (this.state.status !== 'downloaded') throw new Error('Download the update before installing it');
    autoUpdater.quitAndInstall(false, true);
  }
}

module.exports = { UpdateChecker };
