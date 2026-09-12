/**
 * AI tool hook installer for Vibe Monitor
 *
 * Detects locally installed AI CLI tools (Claude Code, Codex CLI, Kiro IDE,
 * OpenClaw, OpenCode) that are missing the VibeMon hook files, and — after explicit
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
const { findPython, SPAWN_DEFAULTS, IS_WINDOWS } = require('./python-runtime.cjs');

// Tolerate an accidental trailing slash on the (env-overridable) base URL.
const DOCS_BASE = DOCS_BASE_URL.replace(/\/+$/, '');
const SETUP_GUIDE_URL = `${DOCS_BASE}/setup.md`;

// install.py is a few KB; this just bounds worst-case memory if the
// response is ever unexpectedly large.
const MAX_SCRIPT_SIZE = 1024 * 1024;

// install.py's own output is bounded (it caps each file diff at 50 lines),
// but its streams still have to be drained: an unread pipe stalls the child
// once the OS buffer fills. Only the tail is kept — failures are reported at
// the end of a run.
const MAX_OUTPUT_SIZE = 64 * 1024;

// install.py always emits ANSI color codes (it doesn't check isatty), and
// prints its own failures to stdout rather than stderr.
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;
const MAX_DETAIL_LINES = 3;

function appendCapped(buffer, chunk) {
  const next = buffer + chunk;
  return next.length > MAX_OUTPUT_SIZE ? next.slice(-MAX_OUTPUT_SIZE) : next;
}

/**
 * The most informative lines of a failed install.py run, for the error dialog.
 * Prefers the script's own '✗' failure lines (e.g. an integrity-check abort,
 * which it reports on stdout) and falls back to the tail of its output.
 * @param {{stdout?: string, stderr?: string}} result
 * @returns {string} empty when the script produced no usable output
 */
function scriptErrorDetail({ stdout = '', stderr = '' }) {
  const lines = `${stdout}\n${stderr}`
    .replace(ANSI_ESCAPE, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const failures = lines.filter(line => line.startsWith('✗'));
  return (failures.length > 0 ? failures : lines).slice(-MAX_DETAIL_LINES).join('\n');
}

function verifyInstallerScript(script, expectedHash) {
  if (!expectedHash) return true;
  const actualHash = crypto.createHash('sha256').update(script, 'utf8').digest('hex');
  return actualHash === expectedHash;
}

/**
 * sha256 of a local file's bytes, or null when it can't be read.
 * @param {string} filePath
 * @param {function(string): string} [normalize] - Undo known installer adaptations
 * @returns {string|null}
 */
function fileSha256(filePath, normalize) {
  try {
    const bytes = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(normalize ? normalize(bytes.toString('utf8')) : bytes).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Parse a JSON file, or null when it is missing or malformed.
 * @param {string} filePath
 * @returns {any|null}
 */
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Every {command, args} pair anywhere in a parsed config document.
 *
 * Walked generically rather than per-tool because the four configs put their
 * commands in four different places (Claude's hooks map and statusLine,
 * Codex's hooks map plus its commandWindows override, and Kiro's v1 hook
 * action blocks) and only agree on the key names.
 * @param {any} node
 * @param {Array<{command: string, args: string[]}>} [out]
 * @returns {Array<{command: string, args: string[]}>}
 */
function collectCommands(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectCommands(item, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  if (typeof node.command === 'string') {
    out.push({ command: node.command, args: Array.isArray(node.args) ? node.args : [] });
  }
  if (typeof node.commandWindows === 'string') {
    out.push({ command: node.commandWindows, args: [] });
  }
  for (const value of Object.values(node)) collectCommands(value, out);
  return out;
}

function isVibemonEntry({ command, args }) {
  return [command, ...args].some(part => typeof part === 'string' && part.includes('vibemon.py'));
}

/**
 * Split a shell-form command into tokens, honouring double quotes and the
 * PowerShell call operator install.py emits for a quoted interpreter path.
 * @param {string} command
 * @returns {string[]}
 */
function tokenizeCommand(command) {
  const tokens = command.trim().replace(/^&\s+/, '').match(/"[^"]*"|\S+/g) || [];
  return tokens.map(token => token.replace(/^"|"$/g, ''));
}

// Only absolute paths get checked. A bare `python3` is resolved through PATH
// at run time and a leading `~` is expanded by the shell — neither is ours to
// second-guess. An absolute path is exactly the case that rots: install.py
// bakes the interpreter and script paths in on Windows, and a Python upgrade
// moves the interpreter out from under them.
const ABSOLUTE_PATH_RE = /^([a-zA-Z]:[\\/]|[\\/])/;

/**
 * First absolute path in a registered command that no longer exists, or null.
 * @param {{command: string, args: string[]}} entry
 * @returns {string|null}
 */
function brokenPathIn(entry) {
  const tokens = entry.args.length > 0
    ? [entry.command, ...entry.args]
    : tokenizeCommand(entry.command);
  return tokens.find(
    token => typeof token === 'string' && ABSOLUTE_PATH_RE.test(token) && !fs.existsSync(token)
  ) || null;
}

/**
 * How a tool's hook registration actually looks on disk.
 *
 * The hook script being present says nothing about whether the tool will ever
 * run it: the registration lives in a config file the installer merges into,
 * and a user who removes just the VibeMon entries leaves the script behind.
 * @param {object} tool
 * @returns {{registered: boolean, brokenPath: string|null}}
 */
function inspectRegistration(tool) {
  if (tool.inspectRegistration) return tool.inspectRegistration();
  const docs = (tool.configPaths || []).map(readJson).filter(Boolean);
  if (tool.isRegistered) {
    return { registered: tool.isRegistered(docs), brokenPath: null };
  }

  const entries = docs.flatMap(doc => collectCommands(doc)).filter(isVibemonEntry);
  if (entries.length === 0) {
    return { registered: false, brokenPath: null };
  }
  const brokenPath = entries.map(brokenPathIn).find(Boolean) || null;
  return { registered: true, brokenPath };
}

/**
 * Whether a parsed manifest.json has the expected shape:
 * { installer?: "<sha256 hex>", files: { "<docs path>": "<sha256 hex>" } }.
 * `installer` (the sha256 of install.py itself) is optional for backward
 * compatibility with manifests published before it existed. A malformed
 * manifest is rejected wholesale rather than partially trusted.
 * @param {any} manifest
 * @returns {boolean}
 */
function isValidManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false;
  if (manifest.installer !== undefined &&
      !(typeof manifest.installer === 'string' && /^[0-9a-f]{64}$/.test(manifest.installer))) {
    return false;
  }
  const files = manifest.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) return false;
  return Object.values(files).every(
    hash => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)
  );
}

function homePath(...segments) {
  return path.join(os.homedir(), ...segments);
}

/**
 * Resolve an AI tool's user config root, honoring the same environment
 * override as the tool and install.py. Relative paths resolve from this
 * process's working directory, matching normal CLI environment semantics.
 * @param {string} envName
 * @param {string} defaultDir
 * @returns {string}
 */
function resolveToolHome(envName, defaultDir) {
  const configured = String(process.env[envName] || '').trim();
  if (!configured) return homePath(defaultDir);
  if (configured === '~') return os.homedir();
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return path.join(os.homedir(), configured.slice(2));
  }
  return path.resolve(configured);
}

function resolveOpenCodeHome() {
  if (String(process.env.OPENCODE_CONFIG_DIR || '').trim()) {
    return resolveToolHome('OPENCODE_CONFIG_DIR', '.config/opencode');
  }
  return path.join(resolveToolHome('XDG_CONFIG_HOME', '.config'), 'opencode');
}

// Read only the JSON string literals install.py writes. Never evaluate a
// locally installed plugin to inspect its interpreter or adapter paths.
function openCodePluginPaths(source) {
  const python = source.match(/^const PYTHON = ("(?:\\.|[^"\\])*");$/m);
  const script = source.match(/^const HOOK_SCRIPT = path\.join\(("(?:\\.|[^"\\])*")\);$/m);
  return {
    python: python ? JSON.parse(python[1]) : null,
    script: script ? JSON.parse(script[1]) : null
  };
}

function inspectOpenCodePlugin() {
  try {
    const source = fs.readFileSync(OPENCODE_PLUGIN, 'utf8');
    const paths = Object.values(openCodePluginPaths(source));
    const brokenPath = paths.find(value => value && ABSOLUTE_PATH_RE.test(value) && !fs.existsSync(value)) || null;
    return { registered: true, brokenPath };
  } catch {
    return { registered: false, brokenPath: null };
  }
}

function normalizeOpenCodePlugin(source) {
  const { python, script } = openCodePluginPaths(source);
  // Restore only install.py's known adaptations before comparing the source
  // checksum. All other plugin changes still trigger an update on every OS.
  if (python && ABSOLUTE_PATH_RE.test(python)) {
    source = source.replace(/^const PYTHON = .*;$/m, 'const PYTHON = "python3";');
  }
  if (script && path.normalize(script) === path.normalize(OPENCODE_HOOK)) {
    source = source.replace(/^const HOOK_SCRIPT = .*;$/m, 'const HOOK_SCRIPT = path.join(OPENCODE_HOME, "hooks", "vibemon.py");');
  }
  return source;
}

// Per tool, `files` lists every file install.py copies verbatim (local
// install path ↔ path under docs.vibemon.io), used to detect drift against
// the published manifest.json. OpenCode's plugin supplies a normalizer for
// its installer-adapted path literals. Merged config files (settings.json,
// hooks.json, ...) and platform-adapted configs are excluded — their installed
// form never matches the source hash. The `sharedAssets` entry covers the
// shared ~/.vibemon
// scripts: always considered "present" (they belong to every installation)
// and excluded from the missing-tools install prompt.
//
// `configPaths` lists those merged configs anyway, for the opposite question:
// whether the tool is actually wired up to run the hook script. A present
// script file says nothing on its own — the registration lives here, and it
// is what rots when a user prunes it or a Windows Python upgrade invalidates
// the absolute interpreter path baked into the command.
const KIRO_HOOK_CONFIG = 'vibemon.json';
const CLAUDE_HOME = resolveToolHome('CLAUDE_CONFIG_DIR', '.claude');
const CODEX_HOME = resolveToolHome('CODEX_HOME', '.codex');
const KIRO_HOME = resolveToolHome('KIRO_HOME', '.kiro');
const KIRO_CONFIG_IS_ADAPTED = IS_WINDOWS || KIRO_HOME !== homePath('.kiro');
const OPENCODE_HOME = resolveOpenCodeHome();
const OPENCODE_HOOK = path.join(OPENCODE_HOME, 'hooks', 'vibemon.py');
const OPENCODE_PLUGIN = path.join(OPENCODE_HOME, 'plugins', 'vibemon.js');

const TOOLS = [
  {
    name: 'Claude Code',
    flag: '--claude',
    command: 'claude',
    homeDir: CLAUDE_HOME,
    hookFile: path.join(CLAUDE_HOME, 'hooks', 'vibemon.py'),
    configPaths: [path.join(CLAUDE_HOME, 'settings.json')],
    files: [
      { local: path.join(CLAUDE_HOME, 'hooks', 'vibemon.py'), remote: 'claude/hooks/vibemon.py' },
      { local: path.join(CLAUDE_HOME, 'statusline.py'), remote: 'claude/statusline.py' }
    ]
  },
  {
    name: 'Codex CLI',
    flag: '--codex',
    command: 'codex',
    homeDir: CODEX_HOME,
    hookFile: path.join(CODEX_HOME, 'hooks', 'vibemon.py'),
    configPaths: [path.join(CODEX_HOME, 'hooks.json')],
    files: [
      { local: path.join(CODEX_HOME, 'hooks', 'vibemon.py'), remote: 'codex/hooks/vibemon.py' }
    ]
  },
  {
    name: 'Kiro IDE',
    flag: '--kiro',
    command: 'kiro',
    commandAliases: ['kiro-cli'],
    homeDir: KIRO_HOME,
    hookFile: path.join(KIRO_HOME, 'hooks', 'vibemon.py'),
    configPaths: [path.join(KIRO_HOME, 'hooks', KIRO_HOOK_CONFIG)],
    files: [
      { local: path.join(KIRO_HOME, 'hooks', 'vibemon.py'), remote: 'kiro/hooks/vibemon.py' },
      // The Kiro v1 global hook config holds a shell command string, which
      // install.py rewrites with an absolute script path on Windows and when
      // KIRO_HOME overrides ~/.kiro. Adapted files cannot match the published
      // default-home hash, so only a default POSIX install tracks this file.
      ...(KIRO_CONFIG_IS_ADAPTED ? [] : [{
        local: path.join(KIRO_HOME, 'hooks', KIRO_HOOK_CONFIG),
        remote: `kiro/hooks/${KIRO_HOOK_CONFIG}`
      }])
    ]
  },
  {
    name: 'OpenClaw',
    flag: '--openclaw',
    command: 'openclaw',
    homeDir: homePath('.openclaw'),
    hookFile: homePath('.openclaw', 'extensions', 'vibemon-bridge', 'index.mjs'),
    configPaths: [homePath('.openclaw', 'openclaw.json')],
    // No command to inspect: the bridge is a Node plugin OpenClaw loads
    // itself, so registration means the entry exists and is enabled.
    isRegistered: docs => docs.some(
      doc => doc?.plugins?.entries?.['vibemon-bridge']?.enabled === true
    ),
    files: [
      { local: homePath('.openclaw', 'extensions', 'vibemon-bridge', 'index.mjs'), remote: 'openclaw/extensions/index.mjs' },
      { local: homePath('.openclaw', 'extensions', 'vibemon-bridge', 'openclaw.plugin.json'), remote: 'openclaw/extensions/openclaw.plugin.json' }
    ]
  },
  {
    name: 'OpenCode',
    flag: '--opencode',
    command: 'opencode',
    homeDir: OPENCODE_HOME,
    hookFile: OPENCODE_HOOK,
    // OpenCode discovers plugins at startup; there is no JSON registration.
    inspectRegistration: inspectOpenCodePlugin,
    files: [
      { local: OPENCODE_HOOK, remote: 'opencode/hooks/vibemon.py' },
      { local: OPENCODE_PLUGIN, remote: 'opencode/plugin/vibemon.js', normalize: normalizeOpenCodePlugin }
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

const WHICH_COMMAND = IS_WINDOWS ? 'where' : 'which';

function commandExists(command) {
  const result = spawnSync(WHICH_COMMAND, [command], { stdio: 'ignore', ...SPAWN_DEFAULTS });
  return result.status === 0;
}

function describeFailure(result) {
  switch (result.reason) {
    case 'python-not-found':
      return IS_WINDOWS
        ? 'No working Python 3 found. Install it from python.org (tick "Add python.exe to PATH").\n'
          + 'If `python` opens the Microsoft Store, turn off the python.exe app execution alias.'
        : 'Python3 is not installed';
    case 'download-failed':
      return `Failed to download install script (HTTP ${result.statusCode})`;
    case 'download-too-large':
      return 'Install script response exceeded the size limit';
    case 'integrity-check-failed':
      return 'Install script integrity check failed';
    case 'integrity-reference-missing':
      return 'Installer checksum unavailable (manifest.json has no installer hash)';
    case 'invalid-manifest':
      return 'Published manifest.json is malformed';
    case 'network-error':
      return `Network error: ${result.error}`;
    case 'spawn-error':
      return `Execution error: ${result.error}`;
    case 'exit-code': {
      // install.py reports *why* it stopped (a failed integrity check, a file
      // it couldn't write) on stdout, so the bare exit code alone is useless.
      const detail = scriptErrorDetail(result);
      const summary = `Install script exited with code ${result.code}`;
      return detail ? `${summary}\n${detail}` : summary;
    }
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
    const commands = [tool.command, ...(tool.commandAliases || [])].filter(Boolean);
    return commands.some(commandExists) || fs.existsSync(tool.homeDir);
  }

  /**
   * Whether the tool's VibeMon script files are on disk. Says nothing about
   * whether the tool is configured to run them — see inspectRegistration().
   * @param {object} tool
   * @returns {boolean}
   */
  hasHookFiles(tool) {
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
    return tool.files.some(({ local, remote, normalize }) => {
      const expected = this.manifest.files[remote];
      if (!expected) return false;
      return fileSha256(local, normalize) !== expected;
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
   * Whether "Don't Ask Again" is silencing any tool's automatic prompt.
   * @returns {boolean}
   */
  hasDismissed() {
    return this.store.get('dismissed').length > 0 || this.sessionSuppressed.size > 0;
  }

  /**
   * Undo every "Don't Ask Again", so the periodic check offers those tools
   * again. Without this the choice is permanent — it is stored on disk and
   * nothing ever removed a flag from it — and a user who picks it by mistake
   * has no way back to the automatic prompt.
   *
   * Also clears the in-memory suppression a failed install sets, so retrying
   * after installing Python doesn't require restarting the app.
   */
  clearDismissed() {
    this.store.set('dismissed', []);
    this.sessionSuppressed.clear();
    this.refreshStatuses();
  }

  /**
   * Recompute and cache each tool's status. Blocking (spawns `which`/`where`
   * per tool and reads its config files) — safe to call occasionally (startup,
   * periodic check, after an install), not on every render.
   *
   * `hasHook` means installed *and wired up*: a script file whose registration
   * has been removed from the tool's config would otherwise read as installed
   * forever, and never be offered for reinstall.
   * @returns {Array} status of every known tool:
   *   {..., present, hasHook, broken, brokenPath, dismissed, changed}
   */
  refreshStatuses() {
    this.cachedStatuses = TOOLS.map(tool => {
      const present = this.isPresent(tool);
      const filesPresent = this.hasHookFiles(tool);
      const { registered, brokenPath } = present && filesPresent && !tool.sharedAssets
        ? inspectRegistration(tool)
        : { registered: false, brokenPath: null };
      // The shared ~/.vibemon scripts are imported by the per-tool hooks
      // rather than registered anywhere, so their files are the whole story.
      const hasHook = filesPresent && (tool.sharedAssets || registered);
      return {
        ...tool,
        present,
        hasHook,
        broken: Boolean(brokenPath),
        brokenPath,
        dismissed: this.isDismissed(tool),
        changed: present && hasHook && this.isChanged(tool)
      };
    });
    return this.cachedStatuses;
  }

  /**
   * Whether any installed tool needs attention — drifted from the manifest or
   * points at a path that no longer exists — per the last refreshStatuses().
   * Non-blocking, for badge rendering.
   * @returns {boolean}
   */
  hasChanges() {
    return this.cachedStatuses.some(tool => tool.changed || tool.broken);
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
   * Download install.py over HTTPS and verify it against expectedHash.
   * @param {string} [expectedHash] - sha256 the script must match (from
   *   resolveInstallerHash()); when omitted, verification is skipped
   * @returns {Promise<string>} script source
   */
  downloadScript(expectedHash) {
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
          if (!verifyInstallerScript(script, expectedHash)) {
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
   * The sha256 the downloaded install.py must match. The env pin
   * (VIBEMON_INSTALLER_SHA256) wins when set; otherwise the manifest is
   * fetched fresh — a stale cached manifest right after a docs deploy would
   * fail verification against the newly published script — falling back to
   * the last fetched copy only when the fetch fails.
   * @returns {Promise<string>} sha256 hex
   * @throws {{reason: string}} when no hash source is available
   */
  async resolveInstallerHash() {
    if (INSTALLER_SHA256) return INSTALLER_SHA256;
    try {
      this.manifest = await this.downloadManifest();
    } catch (err) {
      if (!this.manifest) throw err;
      console.error('[HookInstaller] manifest fetch failed, using cached copy:', err.reason || err.error || err);
    }
    if (!this.manifest.installer) throw { reason: 'integrity-reference-missing' };
    return this.manifest.installer;
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
   *
   * `--yes` is deliberately not passed. A platform flag alone already makes
   * install.py run unattended, and since the installer separated the two,
   * `--yes` additionally means "replace settings the user owns" — most visibly
   * an existing Claude Code `statusLine`. Without it, VibeMon's own scripts are
   * still upgraded in place, so drift is repaired and only user-owned settings
   * are left alone. Older published installers treated any platform flag as
   * auto-approve, so omitting the flag is safe against those too.
   * @param {string} script
   * @param {{command: string, prefixArgs: string[]}} python - from findPython()
   * @param {string[]} flags - e.g. ['--claude']
   * @returns {Promise<{ok: boolean, reason?: string, [key: string]: any}>}
   */
  runScript(script, python, flags) {
    return new Promise((resolve) => {
      const child = spawn(python.command, [...python.prefixArgs, '-', ...flags], {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...SPAWN_DEFAULTS
      });
      let stdout = '';
      let stderr = '';
      // Both streams are drained, not merely sampled for diagnostics: a piped
      // stream nobody reads blocks the child as soon as the OS buffer fills.
      child.stdout.on('data', (chunk) => { stdout = appendCapped(stdout, chunk); });
      child.stderr.on('data', (chunk) => { stderr = appendCapped(stderr, chunk); });
      child.on('error', (err) => resolve({ ok: false, reason: 'spawn-error', error: err.message }));
      child.on('close', (code) => resolve({
        ok: code === 0,
        reason: code === 0 ? null : 'exit-code',
        code,
        stdout,
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
      const python = findPython();
      if (!python) {
        for (const tool of tools) {
          results.push({ tool, result: { ok: false, reason: 'python-not-found' } });
          this.sessionSuppressed.add(tool.flag);
        }
      } else {
        let script = null;
        try {
          const expectedHash = await this.resolveInstallerHash();
          script = await this.downloadScript(expectedHash);
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
            const result = await this.runScript(script, python, [tool.flag, ...tokenFlags]);
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

    // Nothing to say when it worked: the install is already visible in the
    // tray submenu and the Settings AI Tools rows, so a dialog here is a modal
    // interruption confirming what the user just asked for.
    if (failed.length === 0) {
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

module.exports = {
  HookInstaller, TOOLS, verifyInstallerScript, describeFailure, resolveToolHome
};
