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

/**
 * sha256 of a local file's bytes, or null when it can't be read.
 * @param {string} filePath
 * @returns {string|null}
 */
function fileSha256(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Whether a parsed manifest.json has the expected shape:
 * { files: { "<docs path>": "<sha256 hex>" } }. Detection-only data — a
 * malformed manifest is rejected wholesale rather than partially trusted.
 * @param {any} manifest
 * @returns {boolean}
 */
function isValidManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false;
  const files = manifest.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) return false;
  return Object.values(files).every(
    hash => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)
  );
}

function homePath(...segments) {
  return path.join(os.homedir(), ...segments);
}

// Per tool, `files` lists every file install.py copies verbatim (local
// install path ↔ path under docs.vibemon.io), used to detect drift against
// the published manifest.json. Merged config files (settings.json,
// hooks.json, ...) are excluded — their installed form never matches the
// source hash. The `sharedAssets` entry covers the shared ~/.vibemon
// scripts: always considered "present" (they belong to every installation)
// and excluded from the missing-tools install prompt.
const KIRO_HOOK_FILES = [
  'vibemon-prompt-submit.kiro.hook',
  'vibemon-agent-stop.kiro.hook',
  'vibemon-file-created.kiro.hook',
  'vibemon-file-edited.kiro.hook',
  'vibemon-file-deleted.kiro.hook'
];

const TOOLS = [
  {
    name: 'Claude Code',
    flag: '--claude',
    command: 'claude',
    homeDir: homePath('.claude'),
    hookFile: homePath('.claude', 'hooks', 'vibemon.py'),
    files: [
      { local: homePath('.claude', 'hooks', 'vibemon.py'), remote: 'claude/hooks/vibemon.py' },
      { local: homePath('.claude', 'statusline.py'), remote: 'claude/statusline.py' }
    ]
  },
  {
    name: 'Codex CLI',
    flag: '--codex',
    command: 'codex',
    homeDir: homePath('.codex'),
    hookFile: homePath('.codex', 'hooks', 'vibemon.py'),
    files: [
      { local: homePath('.codex', 'hooks', 'vibemon.py'), remote: 'codex/hooks/vibemon.py' }
    ]
  },
  {
    name: 'Kiro IDE',
    flag: '--kiro',
    command: 'kiro',
    homeDir: homePath('.kiro'),
    hookFile: homePath('.kiro', 'hooks', 'vibemon.py'),
    files: [
      { local: homePath('.kiro', 'hooks', 'vibemon.py'), remote: 'kiro/hooks/vibemon.py' },
      ...KIRO_HOOK_FILES.map(name => ({
        local: homePath('.kiro', 'hooks', name),
        remote: `kiro/hooks/${name}`
      }))
    ]
  },
  {
    name: 'OpenClaw',
    flag: '--openclaw',
    command: 'openclaw',
    homeDir: homePath('.openclaw'),
    hookFile: homePath('.openclaw', 'extensions', 'vibemon-bridge', 'index.mjs'),
    files: [
      { local: homePath('.openclaw', 'extensions', 'vibemon-bridge', 'index.mjs'), remote: 'openclaw/extensions/index.mjs' },
      { local: homePath('.openclaw', 'extensions', 'vibemon-bridge', 'openclaw.plugin.json'), remote: 'openclaw/extensions/openclaw.plugin.json' }
    ]
  },
  {
    name: 'VibeMon Scripts',
    flag: '--vibemon',
    command: null,
    homeDir: homePath('.vibemon'),
    sharedAssets: true,
    files: [
      { local: homePath('.vibemon', 'usage.py'), remote: 'vibemon/usage.py' },
      { local: homePath('.vibemon', 'usage_cache.py'), remote: 'vibemon/usage_cache.py' },
      { local: homePath('.vibemon', 'vibemon_core.py'), remote: 'vibemon/vibemon_core.py' }
    ]
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
    // Last successfully fetched manifest.json ({files: {path: sha256}}).
    // Null until checkForChanges() succeeds once; without it, statuses
    // report changed: false (existence-only checking).
    this.manifest = null;
    // Detecting tools spawns `which`/`where` per tool, which blocks the
    // main process for tens of ms. Computed once eagerly here (a one-time
    // startup cost) so cheap, frequent reads (e.g. the tray menu, which
    // rebuilds on every status update) never trigger it. Refreshed again
    // by getMissingTools() and after installTools() completes.
    this.cachedStatuses = this.refreshStatuses();
  }

  isPresent(tool) {
    if (tool.sharedAssets) return true;
    return commandExists(tool.command) || fs.existsSync(tool.homeDir);
  }

  hasHook(tool) {
    if (tool.sharedAssets) return tool.files.every(f => fs.existsSync(f.local));
    return fs.existsSync(tool.hookFile);
  }

  /**
   * Whether any of the tool's verbatim-installed files differs from the
   * published manifest (missing files count as changed). Always false until
   * a manifest has been fetched.
   * @param {object} tool
   * @returns {boolean}
   */
  isChanged(tool) {
    if (!this.manifest) return false;
    return tool.files.some(({ local, remote }) => {
      const expected = this.manifest.files[remote];
      if (!expected) return false;
      return fileSha256(local) !== expected;
    });
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
   * @returns {Array} status of every known tool: {..., present, hasHook, changed}
   */
  refreshStatuses() {
    this.cachedStatuses = TOOLS.map(tool => {
      const present = this.isPresent(tool);
      const hasHook = this.hasHook(tool);
      return {
        ...tool,
        present,
        hasHook,
        changed: present && hasHook && this.isChanged(tool)
      };
    });
    return this.cachedStatuses;
  }

  /**
   * Whether any installed tool's files drifted from the manifest, per the
   * last refreshStatuses(). Non-blocking — for badge rendering.
   * @returns {boolean}
   */
  hasChanges() {
    return this.cachedStatuses.some(tool => tool.changed);
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
      !tool.sharedAssets &&
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
   * Download and validate manifest.json (the sha256 map of every file
   * install.py copies verbatim), published next to install.py.
   * @returns {Promise<{files: Object<string, string>}>}
   */
  downloadManifest() {
    return new Promise((resolve, reject) => {
      const req = https.get(`${DOCS_BASE}/manifest.json`, { timeout: 30000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject({ reason: 'download-failed', statusCode: res.statusCode });
          return;
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > MAX_SCRIPT_SIZE) {
            res.destroy();
            reject({ reason: 'download-too-large' });
          }
        });
        res.on('end', () => {
          let manifest;
          try {
            manifest = JSON.parse(body);
          } catch {
            reject({ reason: 'invalid-manifest' });
            return;
          }
          if (!isValidManifest(manifest)) {
            reject({ reason: 'invalid-manifest' });
            return;
          }
          resolve(manifest);
        });
      });
      req.on('error', (err) => reject({ reason: 'network-error', error: err.message }));
    });
  }

  /**
   * Fetch the latest manifest and re-evaluate every tool's changed flag.
   * A failed fetch keeps the previously fetched manifest (if any) and only
   * logs — detection quietly degrades to existence-only checking offline.
   * @returns {Promise<boolean>} whether any installed tool has drifted
   */
  async checkForChanges() {
    try {
      this.manifest = await this.downloadManifest();
    } catch (err) {
      console.error('[HookInstaller] manifest fetch failed:', err.reason || err.error || err);
    }
    this.refreshStatuses();
    return this.hasChanges();
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
   * @param {string|null} token - VibeMon account token; when set (and
   *   well-formed), passed to install.py as `--token` so a fresh install
   *   seeds ~/.vibemon/config.json with the same token the app reports with
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
          // Guard the format locally: install.py rejects a malformed --token
          // at argparse level (exit 2), which would fail the whole install.
          const tokenFlags = typeof token === 'string' && /^[a-z0-9_-]{8,64}$/.test(token)
            ? ['--token', token]
            : [];
          for (const tool of tools) {
            const result = await this.runScript(script, [tool.flag, ...tokenFlags]);
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
