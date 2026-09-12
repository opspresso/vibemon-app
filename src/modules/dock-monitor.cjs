const { execFile } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { DOCK_QUERY_TIMEOUT_MS, DOCK_REFRESH_MS } = require('../shared/constants.cjs');
const { isRectangle } = require('./dock-layout.cjs');
// Electron's fs can read inside app.asar; osascript cannot open that path.
const dockScript = readFileSync(path.join(__dirname, '../native/dock-bounds.jxa'), 'utf8');

class DockMonitor {
  constructor() {
    this.bounds = [];
    this.pending = null;
    this.timer = null;
    this.onChange = null;
    this.closed = false;
  }

  refresh() {
    if (process.platform !== 'darwin' || this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = new Promise(resolve => {
      execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', dockScript],
        { timeout: DOCK_QUERY_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error, stdout) => {
          let next = [];
          if (!error) {
            try {
              const value = JSON.parse(stdout);
              if (Array.isArray(value)) next = value.filter(isRectangle);
            } catch {
              // An unavailable WindowServer must not leave stale obstacles.
            }
          }
          if (!this.closed && JSON.stringify(next) !== JSON.stringify(this.bounds)) {
            this.bounds = next;
            this.onChange?.();
          }
          resolve();
        });
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  start(shouldRefresh) {
    if (process.platform !== 'darwin' || this.timer || this.closed) return;
    this.timer = setInterval(() => {
      if (shouldRefresh()) this.refresh();
    }, DOCK_REFRESH_MS);
    this.timer.unref();
  }

  cleanup() {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = null;
    this.onChange = null;
  }
}

module.exports = { DockMonitor };
