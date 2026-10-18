/**
 * Plan-usage cache refresher for Vibe Monitor
 *
 * Runs the installed ~/.vibemon/usage.py (placed by the vibemon.io/install
 * installer), which refreshes every registered profile in the shared
 * usage cache (~/.vibemon/cache/usage.json) that the AI-tool hooks read.
 * Invoked on app startup and on a schedule so usage data stays fresh even
 * when no Claude Code session is rendering the statusline. The script's
 * --max-age flag and file lock make overlapping refreshes (statusline,
 * concurrent runs) cheap and collision-free.
 *
 * Profile isolation, identity verification and scheduling belong to Python.
 * This process never derives another account ID or receives provider tokens.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { USAGE_REFRESH_MAX_AGE_SECONDS, USAGE_REFRESH_TIMEOUT_MS } = require('../shared/config.cjs');
const { findPython, SPAWN_DEFAULTS } = require('./python-runtime.cjs');
const { getUsageCachePath } = require('./usage-cache-reader.cjs');
const { expandHome } = require('../shared/home-path.cjs');

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
    // Diagnostic provider helpers must not appear as coding activity.
    VIBEMON_SUPPRESS_HOOKS: '1',
    VIBEMON_CACHE_PATH: path.join(path.dirname(getUsageCachePath()), 'projects.json'),
    ...(process.env.CODEX_HOME ? { CODEX_HOME: expandHome(process.env.CODEX_HOME) } : {}),
    ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: expandHome(process.env.CLAUDE_CONFIG_DIR) } : {})
  };
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
    const maxAgeSeconds = USAGE_REFRESH_MAX_AGE_SECONDS;
    return new Promise((resolve) => {
      const args = [
        ...python.prefixArgs,
        USAGE_SCRIPT_PATH,
        '--all-profiles',
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
        // Provider identity probes must not use the filesystem root as a workspace.
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
