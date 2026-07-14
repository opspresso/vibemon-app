/**
 * AI tool hook installer for Vibe Monitor
 *
 * Detects locally installed AI CLI tools (Claude Code, Codex CLI, Kiro IDE,
 * OpenClaw) that are missing the VibeMon hook files, and — after explicit
 * user confirmation — runs the official docs.vibemon.io/install.py installer
 * to set them up. The script is downloaded over HTTPS and piped to
 * `python3 -` via stdin instead of a `curl | python3` shell pipe, so
 * arguments never pass through a shell.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { dialog, shell } = require('electron');
const Store = require('electron-store');
const { DOCS_BASE_URL, INSTALLER_SHA256 } = require('../shared/config.cjs');

// Tolerate an accidental trailing slash on the (env-overridable) base URL.
const DOCS_BASE = DOCS_BASE_URL.replace(/\/+$/, '');
const SETUP_GUIDE_URL = `${DOCS_BASE}/setup.md`;

// install.py is a few KB; this just bounds worst-case memory if the
// response is ever unexpectedly large.
const MAX_SCRIPT_SIZE = 1024 * 1024;

function verifyInstallerScript(script, expectedHash = INSTALLER_SHA256) {
  if (!expectedHash) return true;
  const actualHash = crypto.createHash('sha256').update(script, 'utf8').digest('hex');
  return actualHash === expectedHash;
}

function homePath(...segments) {
  return path.join(os.homedir(), ...segments);
}

const TOOLS = [
  {
    name: 'Claude Code',
    flag: '--claude',
    command: 'claude',
    homeDir: homePath('.claude'),
    hookFile: homePath('.claude', 'hooks', 'vibemon.py')
  },
  {
    name: 'Codex CLI',
    flag: '--codex',
    command: 'codex',
    homeDir: homePath('.codex'),
    hookFile: homePath('.codex', 'hooks', 'vibemon.py')
  },
  {
    name: 'Kiro IDE',
    flag: '--kiro',
    command: 'kiro',
    homeDir: homePath('.kiro'),
    hookFile: homePath('.kiro', 'hooks', 'vibemon.py')
  },
  {
    name: 'OpenClaw',
    flag: '--openclaw',
    command: 'openclaw',
    homeDir: homePath('.openclaw'),
    hookFile: homePath('.openclaw', 'extensions', 'vibemon-bridge', 'index.mjs')
  }
];

const WHICH_COMMAND = process.platform === 'win32' ? 'where' : 'which';
const PYTHON_COMMAND = process.platform === 'win32' ? 'python' : 'python3';

function commandExists(command) {
  const result = spawnSync(WHICH_COMMAND, [command], { stdio: 'ignore' });
  return result.status === 0;
}

function describeFailure(result) {
  switch (result.reason) {
    case 'python-not-found':
      return 'Python3 is not installed';
    case 'download-failed':
      return `Failed to download install script (HTTP ${result.statusCode})`;
    case 'download-too-large':
      return 'Install script response exceeded the size limit';
    case 'integrity-check-failed':
      return 'Install script integrity check failed';
    case 'network-error':
      return `Network error: ${result.error}`;
    case 'spawn-error':
      return `Execution error: ${result.error}`;
    case 'exit-code':
      return `Install script exited with code ${result.code}`;
    default:
      return 'Unknown error';
  }
}

class HookInstaller {
  constructor() {
    this.store = new Store({
      name: 'hook-installer-settings',
      defaults: { dismissed: [] }
    });
    this.isRunning = false;
    // In-memory only (cleared on restart): avoids re-prompting every check
    // cycle for an error that won't resolve itself (e.g. missing python3).
    this.sessionSuppressed = new Set();
    // Detecting tools spawns `which`/`where` per tool, which blocks the
    // main process for tens of ms. Computed once eagerly here (a one-time
    // startup cost) so cheap, frequent reads (e.g. the tray menu, which
    // rebuilds on every status update) never trigger it. Refreshed again
    // by getMissingTools() and after installTools() completes.
    this.cachedStatuses = this.refreshStatuses();
  }

  isPresent(tool) {
    return commandExists(tool.command) || fs.existsSync(tool.homeDir);
  }

  hasHook(tool) {
    return fs.existsSync(tool.hookFile);
  }

  isDismissed(tool) {
    return this.store.get('dismissed').includes(tool.flag);
  }

  dismiss(tools) {
    const dismissed = new Set(this.store.get('dismissed'));
    for (const tool of tools) {
      dismissed.add(tool.flag);
    }
    this.store.set('dismissed', [...dismissed]);
  }

  /**
   * Recompute and cache each tool's status. Blocking (spawns `which`/`where`
   * per tool) — safe to call occasionally (startup, periodic check, after an
   * install), not on every render.
   * @returns {Array} status of every known tool: {..., present, hasHook}
   */
  refreshStatuses() {
    this.cachedStatuses = TOOLS.map(tool => ({
      ...tool,
      present: this.isPresent(tool),
      hasHook: this.hasHook(tool)
    }));
    return this.cachedStatuses;
  }

  /**
   * Non-blocking read of the last refreshStatuses() result, for UI
   * rendering (e.g. the tray menu) that can tolerate slightly stale data.
   * @returns {Array}
   */
  getCachedStatuses() {
    return [...this.cachedStatuses];
  }

  /**
   * @returns {Array} tools that are installed, missing a VibeMon hook, and
   *   not dismissed/suppressed. Always recomputes fresh.
   */
  getMissingTools() {
    return this.refreshStatuses().filter(tool =>
      tool.present &&
      !tool.hasHook &&
      !this.isDismissed(tool) &&
      !this.sessionSuppressed.has(tool.flag)
    );
  }

  /**
   * Download install.py over HTTPS.
   * @returns {Promise<string>} script source
   */
  downloadScript() {
    return new Promise((resolve, reject) => {
      const req = https.get(`${DOCS_BASE}/install.py`, { timeout: 30000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject({ reason: 'download-failed', statusCode: res.statusCode });
          return;
        }

        let script = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          script += chunk;
          if (script.length > MAX_SCRIPT_SIZE) {
            res.destroy();
            reject({ reason: 'download-too-large' });
          }
        });
        res.on('end', () => {
          if (!verifyInstallerScript(script)) {
            reject({ reason: 'integrity-check-failed' });
            return;
          }
          resolve(script);
        });
      });
      req.on('error', (err) => reject({ reason: 'network-error', error: err.message }));
    });
  }

  /**
   * Run already-downloaded install.py source via `python3 -` with the given
   * flags, piping the script over stdin (no shell, no temp file).
   * @param {string} script
   * @param {string[]} flags - e.g. ['--claude']
   * @returns {Promise<{ok: boolean, reason?: string, [key: string]: any}>}
   */
  runScript(script, flags) {
    return new Promise((resolve) => {
      const args = ['-', ...flags, '--yes'];

      const child = spawn(PYTHON_COMMAND, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (err) => resolve({ ok: false, reason: 'spawn-error', error: err.message }));
      child.on('close', (code) => resolve({
        ok: code === 0,
        reason: code === 0 ? null : 'exit-code',
        code,
        stderr
      }));

      child.stdin.write(script);
      child.stdin.end();
    });
  }

  /**
   * Install hooks for the given tools. install.py is downloaded once and
   * reused for every tool in this batch (rather than once per tool); each
   * tool still gets its own `python3` run so per-tool success/failure stays
   * distinguishable in the result summary. A missing python3 or a failed
   * download fails the whole batch (nothing to run); an individual script
   * run failing does not stop the remaining tools.
   * @param {Array} tools
   * @param {string|null} token
   * @param {{showSummary?: boolean}} [options] - showSummary: whether to show
   *   the native result dialog when finished (default true). The Settings
   *   window's Install/Reinstall button passes false since it already shows
   *   the result inline (badge/button state) and doesn't need a popup too.
   */
  async installTools(tools, token, { showSummary = true } = {}) {
    if (this.isRunning) {
      return [];
    }
    this.isRunning = true;

    const results = [];
    try {
      if (!commandExists(PYTHON_COMMAND)) {
        for (const tool of tools) {
          results.push({ tool, result: { ok: false, reason: 'python-not-found' } });
          this.sessionSuppressed.add(tool.flag);
        }
      } else {
        let script = null;
        try {
          script = await this.downloadScript();
        } catch (err) {
          for (const tool of tools) {
            results.push({ tool, result: { ok: false, ...err } });
            this.sessionSuppressed.add(tool.flag);
          }
        }

        if (script !== null) {
          for (const tool of tools) {
            const result = await this.runScript(script, [tool.flag]);
            results.push({ tool, result });
          }
        }
      }
    } finally {
      this.isRunning = false;
    }

    this.refreshStatuses();
    if (showSummary) this.showResultSummary(results);
    return results;
  }

  /**
   * Detect missing tools and, if any, ask the user for confirmation before
   * installing hooks for them. No-op when nothing is missing or an install
   * is already in progress.
   * @param {string|null} token - VibeMon account token (shared with the WebSocket client)
   */
  async checkAndPrompt(token) {
    if (this.isRunning) {
      return;
    }

    const missing = this.getMissingTools();
    if (missing.length === 0) {
      return;
    }

    const toolNames = missing.map(t => t.name).join(', ');
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'VibeMon',
      message: 'VibeMon found AI tools without hooks installed.',
      detail: `${toolNames}\n\nInstall hooks now to show real-time status in VibeMon.`,
      buttons: ['Install', 'Skip', "Don't Ask Again"],
      defaultId: 0,
      cancelId: 1
    });

    if (response === 1) {
      return; // Skip - ask again next check
    }
    if (response === 2) {
      this.dismiss(missing);
      return;
    }

    await this.installTools(missing, token);
  }

  /**
   * Manually install hooks for a single tool (e.g. from the Settings window
   * or tray menu), bypassing the dismissed/suppressed filters used by
   * checkAndPrompt.
   * @param {string} flag - e.g. '--claude'
   * @param {string|null} token
   * @param {{showSummary?: boolean}} [options] - forwarded to installTools()
   */
  installByFlag(flag, token, options) {
    const tool = TOOLS.find(t => t.flag === flag);
    if (!tool) {
      return Promise.resolve([]);
    }
    return this.installTools([tool], token, options);
  }

  showResultSummary(results) {
    const succeeded = results.filter(r => r.result.ok).map(r => r.tool.name);
    const failed = results.filter(r => !r.result.ok);

    if (failed.length === 0) {
      dialog.showMessageBox({
        type: 'info',
        title: 'VibeMon',
        message: 'VibeMon hooks installed',
        detail: succeeded.join(', ')
      }).catch(() => {});
      return;
    }

    const failedLines = failed.map(r => `${r.tool.name}: ${describeFailure(r.result)}`).join('\n');
    dialog.showMessageBox({
      type: 'warning',
      title: 'VibeMon',
      message: succeeded.length > 0 ? 'Some hooks failed to install' : 'VibeMon hook installation failed',
      detail: [
        succeeded.length > 0 ? `Succeeded: ${succeeded.join(', ')}` : null,
        failedLines,
        `See ${SETUP_GUIDE_URL} for manual setup instructions.`
      ].filter(Boolean).join('\n\n'),
      buttons: ['OK', 'Open Setup Guide']
    }).then(({ response }) => {
      if (response === 1) {
        shell.openExternal(SETUP_GUIDE_URL);
      }
    }).catch(() => {});
  }
}

module.exports = { HookInstaller, TOOLS, verifyInstallerScript };
