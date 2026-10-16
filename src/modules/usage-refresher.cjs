/**
 * Plan-usage cache refresher for Vibe Monitor
 *
 * Runs the installed ~/.vibemon/usage.py (placed by the vibemon.io/install
 * installer), which fetches `claude -p "/usage"` and refreshes the shared
 * usage cache (~/.vibemon/cache/usage.json) that the AI-tool hooks read.
 * Invoked on app startup and on a schedule so usage data stays fresh even
 * when no Claude Code session is rendering the statusline. The script's
 * --max-age flag and file lock make overlapping refreshes (statusline,
 * concurrent runs) cheap and collision-free.
 *
 * `claude -p "/usage"` is itself a real Claude Code session, so its own
 * hooks are suppressed via VIBEMON_SUPPRESS_HOOKS (see buildEnv()) to keep
 * it from reporting status back to this app as a phantom project.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { USAGE_REFRESH_MAX_AGE_SECONDS, USAGE_REFRESH_TIMEOUT_MS } = require('../shared/config.cjs');
const { findPython, SPAWN_DEFAULTS } = require('./python-runtime.cjs');
const { getUsageCachePath, providerCacheKey, expandHome } = require('./usage-cache-reader.cjs');

const USAGE_SCRIPT_PATH = path.join(os.homedir(), '.vibemon', 'usage.py');

// Electron launched from Finder/Dock gets a minimal PATH, and usage.py
// resolves the `claude` CLI via PATH — append the common install locations.
const EXTRA_PATH_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.claude', 'local'),
  '/opt/homebrew/bin',
  '/usr/local/bin'
];

function buildEnv() {
  const parts = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const missing = EXTRA_PATH_DIRS.filter((dir) => !parts.includes(dir));
  return {
    ...process.env,
    PATH: [...parts, ...missing].join(path.delimiter),
    // usage.py runs `claude -p "/usage"`, a real Claude Code session whose
    // own hooks would otherwise report status back to this app under a
    // ".vibemon" project (the cwd we spawn usage.py in). This env var is
    // inherited down to that subprocess so the Claude Code hook adapter can
    // skip reporting for it.
    VIBEMON_SUPPRESS_HOOKS: '1',
    VIBEMON_CACHE_PATH: path.join(path.dirname(getUsageCachePath()), 'projects.json'),
    ...(process.env.CODEX_HOME ? { CODEX_HOME: expandHome(process.env.CODEX_HOME) } : {}),
    ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: expandHome(process.env.CLAUDE_CONFIG_DIR) } : {})
  };
}

function shouldForceCodexRefresh() {
  try {
    const authMtimeMs = fs.statSync(path.join(expandHome(process.env.CODEX_HOME || '~/.codex'), 'auth.json')).mtimeMs;
    const cache = JSON.parse(fs.readFileSync(getUsageCachePath(), 'utf8'));
    const codexUpdatedAtMs = Number(cache[providerCacheKey('codex')]?.updated_at ?? cache.ts ?? 0) * 1000;
    return codexUpdatedAtMs > 0 && authMtimeMs > codexUpdatedAtMs;
  } catch {
    return false;
  }
}

class UsageRefresher {
  constructor() {
    this.inFlight = false;
  }

  /**
   * Run usage.py to refresh the shared usage cache. Resolves with
   * { ok, reason?, code? }; never rejects — a stale cache
   * is harmless and the next scheduled run retries.
   * @returns {Promise<{ok: boolean, reason?: string, code?: number}>}
   */
  async refresh() {
    if (this.inFlight) {
      return { ok: false, reason: 'in-flight' };
    }
    if (!fs.existsSync(USAGE_SCRIPT_PATH)) {
      return { ok: false, reason: 'not-installed' };
    }
    this.inFlight = true;
    const python = await findPython();
    if (!python) {
      this.inFlight = false;
      return { ok: false, reason: 'python-not-found' };
    }
    const maxAgeSeconds = shouldForceCodexRefresh() ? 0 : USAGE_REFRESH_MAX_AGE_SECONDS;
    return new Promise((resolve) => {
      const args = [
        ...python.prefixArgs,
        USAGE_SCRIPT_PATH,
        '--max-age',
        String(maxAgeSeconds)
      ];
      let settled = false;
      let timer;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.inFlight = false;
        resolve(result);
      };
      let child;
      try { child = spawn(python.command, args, {
        ...SPAWN_DEFAULTS,
        // Launched from Finder/Dock the app's cwd is `/`, which the spawned
        // `claude` CLI would treat as its workspace — its file enumeration
        // can then descend into TCC-protected folders (Documents, Desktop,
        // ...) and macOS attributes that to this app as a folder-access
        // permission prompt. Pin the workspace to a harmless directory.
        cwd: path.dirname(USAGE_SCRIPT_PATH),
        stdio: ['ignore', 'ignore', 'ignore'],
        env: buildEnv()
      }); } catch {
        finish({ ok: false, reason: 'spawn-error' });
        return;
      }
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ ok: false, reason: 'timeout' });
      }, USAGE_REFRESH_TIMEOUT_MS);
      timer.unref();
      child.on('error', () => finish({ ok: false, reason: 'spawn-error' }));
      child.on('close', (code) => finish({
        ok: code === 0,
        reason: code === 0 ? null : 'exit-code',
        code
      }));
    });
  }
}

module.exports = { UsageRefresher, USAGE_SCRIPT_PATH };
