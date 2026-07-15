/**
 * Manages ~/.vibemon/config.json — the shared config read by the
 * Claude/Codex/Kiro `vibemon.py` hook scripts and, as a fallback for
 * transmission settings, by the OpenClaw vibemon-bridge plugin (whose
 * plugin config in ~/.openclaw/openclaw.json overrides it). Without an
 * http_urls entry pointing at this app, those hooks run but have nowhere
 * to send status, even if their hook file is installed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { HTTP_PORT } = require('../shared/config.cjs');

function homePath(...segments) {
  return path.join(os.homedir(), ...segments);
}

const VIBEMON_HOME = homePath('.vibemon');
const VIBEMON_CONFIG_PATH = path.join(VIBEMON_HOME, 'config.json');
const DESKTOP_HTTP_URL = `http://127.0.0.1:${HTTP_PORT}`;

// Matches vibemon-docs' config.example.json defaults. Only the fields this
// app exposes as user-editable — statusline-only fields (show_*, usage_*,
// token_reset_hours) are out of scope here, and cache_path is intentionally
// excluded: no documented reason for a user to change it, and a typo silently
// breaks memory/model/usage display with no surfaced error.
const VIBEMON_CONFIG_DEFAULTS = {
  debug: false,
  auto_launch: true,
  http_urls: [],
  serial_port: null,
  vibemon_url: 'https://vibemon.io',
  vibemon_token: ''
};

function readRawConfig() {
  if (!fs.existsSync(VIBEMON_CONFIG_PATH)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(VIBEMON_CONFIG_PATH, 'utf8'));
  } catch {
    return undefined; // exists but invalid JSON
  }
}

class VibemonConfigManager {
  /**
   * Read-only check of ~/.vibemon/config.json. Cheap synchronous file I/O
   * (no subprocess), so this is never cached — every call re-reads the file.
   * @returns {{exists: boolean, hasDesktopUrl: boolean}}
   */
  getStatus() {
    const raw = readRawConfig();
    if (raw === null) {
      return { exists: false, hasDesktopUrl: false };
    }
    if (raw === undefined) {
      return { exists: true, hasDesktopUrl: false };
    }
    const urls = Array.isArray(raw.http_urls) ? raw.http_urls : [];
    return { exists: true, hasDesktopUrl: urls.includes(DESKTOP_HTTP_URL) };
  }

  /**
   * Full config merged over defaults — always a complete, safe object even
   * when the file is missing or corrupt.
   * @returns {object}
   */
  read() {
    const raw = readRawConfig();
    return { ...VIBEMON_CONFIG_DEFAULTS, ...(raw || {}) };
  }

  /**
   * Merge and persist a partial update. Unknown keys are ignored; known keys
   * are coerced to their expected type.
   * @param {object} partial
   * @returns {object} the fresh config after writing (same shape as read())
   */
  write(partial) {
    const current = this.read();
    const next = { ...current };

    for (const key of Object.keys(partial)) {
      if (!Object.prototype.hasOwnProperty.call(VIBEMON_CONFIG_DEFAULTS, key)) {
        continue;
      }
      const value = partial[key];

      switch (key) {
        case 'debug':
        case 'auto_launch':
          next[key] = Boolean(value);
          break;
        case 'vibemon_url':
        case 'vibemon_token':
          next[key] = String(value ?? '').trim();
          break;
        case 'serial_port': {
          const trimmed = String(value ?? '').trim();
          next[key] = trimmed || null;
          break;
        }
        case 'http_urls': {
          const urls = Array.isArray(value) ? value : [];
          next[key] = [...new Set(urls.map(u => String(u).trim()).filter(Boolean))];
          break;
        }
      }
    }

    this.persist(next);
    return next;
  }

  /**
   * Add a single HTTP URL, based on a fresh read of the current on-disk
   * config rather than a caller-supplied array — a caller (e.g. settings.html)
   * that held onto a stale snapshot can't clobber an entry added elsewhere
   * (e.g. ensureDesktopUrl()'s periodic check) in the meantime.
   * @param {string} url
   * @returns {object} the fresh config after writing (same shape as read())
   */
  addHttpUrl(url) {
    const current = this.read();
    return this.write({ http_urls: [...current.http_urls, url] });
  }

  /**
   * Remove a single HTTP URL, based on a fresh read of the current on-disk
   * config. See addHttpUrl() for why this reads fresh rather than taking a
   * full array from the caller.
   * @param {string} url
   * @returns {object} the fresh config after writing (same shape as read())
   */
  removeHttpUrl(url) {
    const current = this.read();
    return this.write({ http_urls: current.http_urls.filter(u => u !== url) });
  }

  /**
   * Create or repair ~/.vibemon/config.json so its http_urls includes this
   * app, without running the python installer. Existing fields (other
   * http_urls entries, an already-set vibemon_token, etc.) are preserved.
   * @param {string|null} token - only used to fill an empty vibemon_token
   * @returns {boolean} whether the file was created/modified
   */
  ensureDesktopUrl(token) {
    const status = this.getStatus();
    if (status.exists && status.hasDesktopUrl) {
      return false;
    }

    const raw = readRawConfig();
    let config = { ...VIBEMON_CONFIG_DEFAULTS };
    if (raw === undefined) {
      try {
        fs.copyFileSync(VIBEMON_CONFIG_PATH, `${VIBEMON_CONFIG_PATH}.bak`);
        fs.chmodSync(`${VIBEMON_CONFIG_PATH}.bak`, 0o600);
      } catch {
        // Best-effort backup; proceed to overwrite either way.
      }
    } else if (raw !== null) {
      config = { ...config, ...raw };
    }

    const urls = new Set(Array.isArray(config.http_urls) ? config.http_urls : []);
    urls.add(DESKTOP_HTTP_URL);
    config.http_urls = [...urls];

    if (!config.vibemon_token && token) {
      config.vibemon_token = token;
    }

    this.persist(config);
    return true;
  }

  /**
   * Atomically write the config. Never throws — callers run from timers and
   * IPC handlers whose UIs re-read the file afterwards, so a failed write
   * surfaces as the on-disk value winning; the error itself is logged here.
   * @param {object} config
   * @returns {boolean} whether the write succeeded
   */
  persist(config) {
    try {
      fs.mkdirSync(VIBEMON_HOME, { recursive: true });
      const tempPath = `${VIBEMON_CONFIG_PATH}.${process.pid}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
      try {
        fs.chmodSync(VIBEMON_HOME, 0o700);
        fs.chmodSync(tempPath, 0o600);
      } catch {
        // Best-effort; non-Unix platforms may not support chmod.
      }
      fs.renameSync(tempPath, VIBEMON_CONFIG_PATH);
      return true;
    } catch (err) {
      console.error('[VibemonConfig] failed to save ~/.vibemon/config.json:', err.message);
      return false;
    }
  }
}

module.exports = { VibemonConfigManager, VIBEMON_CONFIG_DEFAULTS };
