const { describeFailure } = require('../shared/install-result.cjs');
/**
 * AI tool hook installer for Vibe Monitor
 *
 * Detects locally installed AI CLI tools (Claude Code, Codex CLI, Kiro IDE,
 * OpenClaw, OpenCode) that are missing the VibeMon hook files, and — after explicit
 * user confirmation — runs the official vibemon.io/install/install.py installer
 * to set them up. The script is downloaded over HTTPS and piped to
 * `python3 -` via stdin instead of a `curl | python3` shell pipe, so
 * arguments never pass through a shell.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { dialog, shell } = require('electron');
const Store = require('electron-store');
const { DOCS_BASE_URL, INSTALLER_SHA256 } = require('../shared/config.cjs');
const { findPython, SPAWN_DEFAULTS, IS_WINDOWS } = require('./python-runtime.cjs');

// Tolerate an accidental trailing slash on the (env-overridable) base URL.
const DOCS_BASE = DOCS_BASE_URL.replace(/\/+$/, '');
const SETUP_GUIDE_URL = `${DOCS_BASE}/setup.md`;

// Bound the installer and manifest before buffering their full contents.
const MAX_SCRIPT_SIZE = 1024 * 1024;

// install.py's own output is bounded (it caps each file diff at 50 lines),
// but its streams still have to be drained: an unread pipe stalls the child
// once the OS buffer fills. Only the tail is kept — failures are reported at
// the end of a run.
const MAX_OUTPUT_SIZE = 64 * 1024;

function appendCapped(buffer, chunk) {
  const next = buffer + chunk;
  return next.length > MAX_OUTPUT_SIZE ? next.slice(-MAX_OUTPUT_SIZE) : next;
}

function verifyInstallerScript(script, expectedHash) {
  if (typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash)) return false;
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
 * Walked generically rather than per-tool because the configs put their
 * commands in different places (Claude's hooks map and statusLine,
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
  const windowsOverride = IS_WINDOWS && typeof node.commandWindows === 'string';
  const command = windowsOverride ? node.commandWindows : node.command;
  if (typeof command === 'string') {
    out.push({ command, args: !windowsOverride && Array.isArray(node.args) ? node.args : [] });
  }
  for (const value of Object.values(node)) collectCommands(value, out);
  return out;
}

function isVibemonEntry({ command, args }) {
  return [...tokenizeCommand(command), ...args].some(part =>
    typeof part === 'string' && part.split(/[\\/]/).at(-1) === 'vibemon.py'
  );
}

/**
 * Split installer shell commands, honoring POSIX single/double quotes and the
 * PowerShell call operator install.py emits for a quoted interpreter path.
 * @param {string} command
 * @returns {string[]}
 */
function tokenizeCommand(command) {
  const prefix = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ';
  if (command.startsWith(prefix)) {
    const encoded = command.slice(prefix.length);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return [];
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    const start = "$ErrorActionPreference='Stop'; & ", end = '; exit $LASTEXITCODE';
    if (!script.startsWith(start) || !script.endsWith(end)) return [];
    const args = script.slice(start.length, -end.length);
    const literals = args.match(/'(?:''|[^'])*'/g) || [];
    // Inspect only our literal invocation; never evaluate installed commands.
    if (literals.length < 2 || args !== literals.join(' ')) return [];
    return literals.map(literal => literal.slice(1, -1).replaceAll("''", "'"));
  }
  const tokens = command.trim().replace(/^&\s+/, '').match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) || [];
  return tokens.map(token => token.replace(/"([^"]*)"|'([^']*)'/g, (_match, double, single) => double ?? single));
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

function isOpenClawRegistered(docs) {
  // The canonical install location is also an auto-discovered global root.
  // load.paths records provenance, but is not required for discovery there.
  if (!fs.existsSync(homePath('.openclaw', 'extensions', 'vibemon-bridge', 'openclaw.plugin.json'))) return false;
  return docs.some(doc => {
    const plugins = doc?.plugins;
    if (plugins?.enabled === false || plugins?.entries?.['vibemon-bridge']?.enabled !== true) return false;
    if (Array.isArray(plugins.deny) && plugins.deny.includes('vibemon-bridge')) return false;
    return !Array.isArray(plugins.allow) || plugins.allow.length === 0 || plugins.allow.includes('vibemon-bridge');
  });
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

function isOpenCodeHookPath(script) {
  if (path.normalize(script) === path.normalize(OPENCODE_HOOK)) return true;
  // Path.resolve() in install.py also resolves symlinks (e.g. /tmp on macOS).
  // Compare the existing files so those paths do not look like plugin drift.
  try {
    return fs.realpathSync(script) === fs.realpathSync(OPENCODE_HOOK);
  } catch {
    return false;
  }
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
  if (script && isOpenCodeHookPath(script)) {
    source = source.replace(/^const HOOK_SCRIPT = .*;$/m, 'const HOOK_SCRIPT = path.join(OPENCODE_HOME, "hooks", "vibemon.py");');
  }
  return source;
}

// Per tool, `files` lists every file install.py copies verbatim (local
// install path ↔ path under vibemon.io/install), used to detect drift against
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
    // itself. The docs installer both enables it and registers its load path.
    isRegistered: isOpenClawRegistered,
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
      { local: homePath('.vibemon', 'http_client.py'), remote: 'vibemon/http_client.py' },
      { local: homePath('.vibemon', 'cache_io.py'), remote: 'vibemon/cache_io.py' },
      { local: homePath('.vibemon', 'account_context.py'), remote: 'vibemon/account_context.py' },
      { local: homePath('.vibemon', 'usage_cache.py'), remote: 'vibemon/usage_cache.py' },
      { local: homePath('.vibemon', 'project_context.py'), remote: 'vibemon/project_context.py' },
      { local: homePath('.vibemon', 'session_activity.py'), remote: 'vibemon/session_activity.py' },
      { local: homePath('.vibemon', 'vibemon_core.py'), remote: 'vibemon/vibemon_core.py' }
    ]
  }
];

function commandExists(command) {
  const extensions = IS_WINDOWS ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')] : [''];
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean).some(directory =>
    extensions.some(extension => {
      const filename = path.join(directory.replace(/^"|"$/g, ''), command + extension);
      try {
        if (!fs.statSync(filename).isFile()) return false;
        fs.accessSync(filename, IS_WINDOWS ? fs.constants.F_OK : fs.constants.X_OK);
        return true;
      } catch { return false; }
    })
  );
}


class HookInstaller {
  constructor() {
    this.store = new Store({
      name: 'hook-installer-settings',
      defaults: { dismissed: [] }
    });
    this.isRunning = false;
    this.onStateChanged = null;
    // In-memory only (cleared on restart): avoids re-prompting every check
    // cycle for an error that won't resolve itself (e.g. missing python3).
    this.sessionSuppressed = new Set();
    // Last successfully fetched manifest.json ({files: {path: sha256}}).
    // Null until checkForChanges() succeeds once; without it, statuses
    // report changed: false (existence-only checking).
    this.manifest = null;
    // Workspace snapshots reuse this cache instead of scanning tool files.
    this.cachedStatuses = this.refreshStatuses();
  }

  isPresent(tool) {
    if (tool.sharedAssets || fs.existsSync(tool.homeDir)) return true;
    const commands = [tool.command, ...(tool.commandAliases || [])].filter(Boolean);
    return commands.some(commandExists);
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

  /** Download bounded text and settle stalled or interrupted requests. */
  downloadText(relativePath) {
    return new Promise((resolve, reject) => {
      const req = https.get(`${DOCS_BASE}/${relativePath}`, { timeout: 30000 }, res => {
        if (res.statusCode !== 200) {
          res.resume();
          reject({ reason: 'download-failed', statusCode: res.statusCode });
          return;
        }
        let text = '';
        let bytes = 0;
        let failed = false;
        res.setEncoding('utf8');
        res.on('data', chunk => {
          if (failed) return;
          bytes += Buffer.byteLength(chunk, 'utf8');
          if (bytes > MAX_SCRIPT_SIZE) {
            failed = true;
            res.destroy();
            reject({ reason: 'download-too-large' });
          } else text += chunk;
        });
        res.on('error', () => reject({ reason: 'network-error', error: 'Download stream failed' }));
        res.on('aborted', () => reject({ reason: 'network-error', error: 'Download interrupted' }));
        res.on('end', () => { if (!failed) resolve(text); });
      });
      req.on('timeout', () => req.destroy(new Error('Download timed out')));
      req.on('error', error => reject({ reason: 'network-error', error: error.message }));
    });
  }

  /** Download install.py only with a valid integrity reference. */
  async downloadScript(expectedHash) {
    if (typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash)) throw { reason: 'integrity-reference-missing' };
    const script = await this.downloadText('install.py');
    if (!verifyInstallerScript(script, expectedHash)) throw { reason: 'integrity-check-failed' };
    return script;
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
  async downloadManifest() {
    const body = await this.downloadText('manifest.json');
    let manifest;
    try { manifest = JSON.parse(body); }
    catch { throw { reason: 'invalid-manifest' }; }
    if (!isValidManifest(manifest)) throw { reason: 'invalid-manifest' };
    return manifest;
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
   * Repair installed integrations whose files drifted from the published
   * manifest. Fixes to hooks and shared scripts otherwise stay on each machine
   * only as a badge until someone reinstalls by hand. The unattended installer
   * replaces VibeMon-owned files only; user-owned settings are left alone.
   * Broken registrations still need the user, so they are not touched here.
   * @returns {Promise<Array>} install results, empty when nothing drifted
   */
  async updateChanged() {
    await this.checkForChanges();
    const changed = this.cachedStatuses.filter(tool => tool.changed && !tool.broken);
    if (this.isRunning || changed.length === 0) return [];
    return this.installTools(changed, null, { showSummary: false });
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
  runScript(script, python, flags, token) {
    return new Promise((resolve) => {
      const child = spawn(python.command, [...python.prefixArgs, '-', ...flags], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, VIBEMON_DOCS_URL: DOCS_BASE, ...(token ? { VIBEMON_WRITE_TOKEN: token } : {}) },
        ...SPAWN_DEFAULTS
      });
      let stdout = '';
      let stderr = '';
      let inputFailed = false;
      // Both streams are drained, not merely sampled for diagnostics: a piped
      // stream nobody reads blocks the child as soon as the OS buffer fills.
      child.stdout.on('data', (chunk) => { stdout = appendCapped(stdout, chunk); });
      child.stderr.on('data', (chunk) => { stderr = appendCapped(stderr, chunk); });
      child.stdin.on('error', () => { inputFailed = true; });
      child.on('error', (err) => resolve({ ok: false, reason: 'spawn-error', error: err.message }));
      child.on('close', (code) => resolve({
        ok: code === 0 && !inputFailed,
        reason: code !== 0 ? 'exit-code' : inputFailed ? 'input-error' : null,
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
   * @param {string|null} token - Optional generated hook write credential,
   *   passed only through the child environment. Never use the App read token.
   * @param {{showSummary?: boolean}} [options] - showSummary: whether to show
   *   the native result dialog when finished (default true). The Settings
   *   window's Install/Reinstall button passes false since it already shows
   *   the result inline (badge/button state) and doesn't need a popup too.
   */
  async installTools(tools, token, { showSummary = true } = {}) {
    if (this.isRunning) {
      throw new Error('Another integration installation is already running');
    }
    this.isRunning = true;
    this.onStateChanged?.();

    const results = [];
    try {
      const python = await findPython();
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
          const writeToken = typeof token === 'string' && /^vm_[a-f0-9]{60}$/.test(token) ? token : undefined;
          for (const tool of tools) {
            const result = await this.runScript(script, python, [tool.flag], writeToken);
            results.push({ tool, result });
          }
        }
      }
    } finally {
      this.isRunning = false;
      this.onStateChanged?.();
    }

    this.refreshStatuses();
    if (showSummary) this.showResultSummary(results);
    return results;
  }

  /**
   * Detect missing tools and, if any, ask the user for confirmation before
   * installing hooks for them. No-op when nothing is missing or an install
   * is already in progress.
   * @param {string|null} token - Optional hook write token; never use the cloud read token
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
    // Settings > Integrations cards, so a dialog here is a modal
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
