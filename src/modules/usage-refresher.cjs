/**
 * Plan-usage cache refresher for Vibe Monitor
 *
 * Runs the installed ~/.vibemon/usage.py (placed by the docs.vibemon.io
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
const { USAGE_REFRESH_MAX_AGE_SECONDS } = require('../shared/config.cjs');

const PYTHON_COMMAND = process.platform === 'win32' ? 'python' : 'python3';
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
    VIBEMON_SUPPRESS_HOOKS: '1'
  };
}

class UsageRefresher {
  constructor() {
    this.inFlight = false;
  }

  /**
   * Run usage.py to refresh the shared usage cache. Resolves with
   * { ok, reason?, code?, stderr?, error? }; never rejects — a stale cache
   * is harmless and the next scheduled run retries.
   * @returns {Promise<{ok: boolean, reason?: string, code?: number, stderr?: string, error?: string}>}
   */
  refresh() {
    if (this.inFlight) {
      return Promise.resolve({ ok: false, reason: 'in-flight' });
    }
    if (!fs.existsSync(USAGE_SCRIPT_PATH)) {
      return Promise.resolve({ ok: false, reason: 'not-installed' });
    }
    this.inFlight = true;
    return new Promise((resolve) => {
      const args = [USAGE_SCRIPT_PATH, '--max-age', String(USAGE_REFRESH_MAX_AGE_SECONDS)];
      const child = spawn(PYTHON_COMMAND, args, {
        // Launched from Finder/Dock the app's cwd is `/`, which the spawned
        // `claude` CLI would treat as its workspace — its file enumeration
        // can then descend into TCC-protected folders (Documents, Desktop,
        // ...) and macOS attributes that to this app as a folder-access
        // permission prompt. Pin the workspace to a harmless directory.
        cwd: path.dirname(USAGE_SCRIPT_PATH),
        stdio: ['ignore', 'ignore', 'pipe'],
        env: buildEnv()
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (err) => {
        this.inFlight = false;
        console.warn('[UsageRefresher] failed to spawn usage.py:', err.message);
        resolve({ ok: false, reason: 'spawn-error', error: err.message });
      });
      child.on('close', (code) => {
        this.inFlight = false;
        if (code !== 0) {
          console.warn(`[UsageRefresher] usage.py exited with ${code}:`, stderr.trim());
        }
        resolve({
          ok: code === 0,
          reason: code === 0 ? null : 'exit-code',
          code,
          stderr
        });
      });
    });
  }
}

module.exports = { UsageRefresher, USAGE_SCRIPT_PATH };
