/**
 * Tests for hook-installer.cjs
 */

const { EventEmitter } = require('events');

jest.mock('fs');
jest.mock('child_process');
jest.mock('https');
jest.mock('electron', () => ({
  dialog: { showMessageBox: jest.fn().mockResolvedValue({ response: 0 }) },
  shell: { openExternal: jest.fn() }
}));
jest.mock('../src/shared/config.cjs', () => ({
  DOCS_BASE_URL: 'https://docs.example.test'
}));
jest.mock('electron-store', () => {
  return jest.fn().mockImplementation(function (options) {
    let data = { ...(options && options.defaults) };
    this.get = (key) => data[key];
    this.set = (key, value) => { data[key] = value; };
    this.delete = (key) => { delete data[key]; };
  });
});

const fs = require('fs');
const { spawnSync, spawn } = require('child_process');
const https = require('https');
const { dialog, shell } = require('electron');
const {
  HookInstaller, TOOLS, verifyInstallerScript, describeFailure, resolveToolHome
} = require('../src/modules/hook-installer.cjs');

const realCrypto = jest.requireActual('crypto');
const sha256 = (data) => realCrypto.createHash('sha256').update(data).digest('hex');
const path = require('path');
const os = require('os');

function loadInstallerFor({ platform = 'darwin', env = {} } = {}) {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const keys = ['OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    for (const key of keys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    let loaded;
    jest.isolateModules(() => { loaded = require('../src/modules/hook-installer.cjs'); });
    return loaded;
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function openCodeSource({ python = 'python3', script } = {}) {
  return 'const OPENCODE_HOME = path.join(os.homedir(), ".config", "opencode");\n'
    + (script ? `const HOOK_SCRIPT = path.join(${JSON.stringify(script)});\n`
      : 'const HOOK_SCRIPT = path.join(OPENCODE_HOME, "hooks", "vibemon.py");\n')
    + `const PYTHON = ${JSON.stringify(python)};\n`;
}

test('installer integrity verification rejects a mismatched digest', () => {
  expect(verifyInstallerScript('print(1)', '0'.repeat(64))).toBe(false);
});

test('installer integrity verification accepts a matching digest', () => {
  expect(verifyInstallerScript('print(1)', 'd287bb7f9d15abdc5b6e98536263815744b6ef21c8f3c839fc434ca70d8efe99')).toBe(true);
});

test('tool home resolver honors config-root environment overrides', () => {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = './custom-codex-home';
  try {
    expect(resolveToolHome('CODEX_HOME', '.codex')).toBe(
      require('path').resolve('./custom-codex-home')
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

// spawnSync serves two callers: commandExists() runs which/where, and
// findPython() probes an interpreter by executing `-c <code>`. Route by argv
// shape so a test can control tool presence and Python availability apart.
const PROBE_OK = { status: 0, stdout: '3\n' };
// What a Microsoft Store alias stub does: a real python.exe on PATH that runs
// nothing.
const PROBE_FAIL = { status: 9009, stdout: '' };

// What findPython() returns on POSIX; runScript() takes it as a parameter.
const PYTHON = { command: 'python3', prefixArgs: [] };

let pythonAvailable;
let presentCommands;

function mockSpawnSyncRouter() {
  spawnSync.mockImplementation((command, args) => {
    if (args.includes('-c')) return pythonAvailable ? PROBE_OK : PROBE_FAIL;
    return { status: presentCommands.has(args[0]) ? 0 : 1 };
  });
}

// Makes a tool "present" via its CLI command, with no hook file, so it
// shows up as missing. Other tools stay absent (default mocks).
function mockToolMissing(tool) {
  presentCommands = new Set([tool.command]);
}

// A config in the shape each installer writes, registering the hook.
function registeredConfigFor(tool) {
  if (tool.flag === '--openclaw') {
    return JSON.stringify({ plugins: {
      load: { paths: [path.dirname(tool.hookFile)] },
      entries: { 'vibemon-bridge': { enabled: true } }
    } });
  }
  if (tool.flag === '--kiro') {
    return JSON.stringify({
      version: 'v1',
      hooks: [
        {
          name: 'VibeMon Stop',
          trigger: 'Stop',
          action: {
            type: 'command',
            command: `python3 ${tool.hookFile} Stop`
          }
        }
      ]
    });
  }
  return JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: `python3 ${tool.hookFile}` }] }] }
  });
}

// Makes `tool` look fully installed: script files on disk *and* a config that
// registers the hook, which is what refreshStatuses() requires before it will
// call a tool installed.
function mockToolInstalled(tool, { fileContents = 'local-bytes', config, missingFiles = [] } = {}) {
  const missing = new Set(missingFiles);
  const filePaths = new Set(
    [tool.homeDir, tool.hookFile, ...tool.files.map(f => f.local)].filter(p => !missing.has(p))
  );
  const configPaths = new Set(tool.configPaths || []);
  fs.existsSync.mockImplementation(p => filePaths.has(p) || configPaths.has(p));
  fs.readFileSync.mockImplementation(p => {
    if (configPaths.has(p)) return config === undefined ? registeredConfigFor(tool) : config;
    if (filePaths.has(p)) return Buffer.from(fileContents);
    throw new Error('ENOENT');
  });
}

// Configures https.get + spawn to simulate a successful install.py run:
// serves manifest.json (whose installer hash matches the script) and
// install.py by URL. Events fire via setTimeout(..., 0) so this works
// regardless of how many microtask boundaries (dialog awaits, etc.) sit
// between the mock setup and the actual https.get()/spawn() calls.
function mockSuccessfulInstall(script = 'script-source') {
  https.get.mockImplementation((url, opts, cb) => {
    const fakeRes = new EventEmitter();
    fakeRes.statusCode = 200;
    fakeRes.setEncoding = jest.fn();
    cb(fakeRes);
    const body = url.endsWith('/manifest.json')
      ? JSON.stringify({ installer: sha256(script), files: {} })
      : script;
    setTimeout(() => {
      fakeRes.emit('data', body);
      fakeRes.emit('end');
    }, 0);
    return new EventEmitter();
  });

  const spawnedChildren = [];
  spawn.mockImplementation(() => {
    const child = new EventEmitter();
    child.stdin = { write: jest.fn(), end: jest.fn() };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    spawnedChildren.push(child);
    setTimeout(() => child.emit('close', 0), 0);
    return child;
  });

  return spawnedChildren;
}

describe('HookInstaller', () => {
  let hookInstaller;

  beforeEach(() => {
    fs.existsSync.mockReset().mockReturnValue(false);
    pythonAvailable = true;
    presentCommands = new Set();
    spawnSync.mockReset();
    mockSpawnSyncRouter();
    spawn.mockReset();
    https.get.mockReset();
    dialog.showMessageBox.mockReset().mockResolvedValue({ response: 0 });
    shell.openExternal.mockReset();
    // Constructed after mocks are configured: the constructor eagerly
    // computes the initial status cache.
    hookInstaller = new HookInstaller();
  });

  describe('getMissingTools', () => {
    test('excludes a tool that is not present', () => {
      expect(hookInstaller.getMissingTools()).toEqual([]);
    });

    test('includes a tool that is present (via command) and missing its hook file', () => {
      const target = TOOLS[0];
      mockToolMissing(target);

      const missing = hookInstaller.getMissingTools();
      expect(missing.map(t => t.flag)).toEqual([target.flag]);
    });

    test('detects Kiro CLI through the kiro-cli command alias', () => {
      const target = TOOLS.find(t => t.flag === '--kiro');
      presentCommands = new Set(['kiro-cli']);

      expect(hookInstaller.getMissingTools().map(t => t.flag)).toContain(target.flag);
    });

    test('excludes a tool that already has its hook installed', () => {
      const target = TOOLS[1];
      mockToolInstalled(target);

      const missing = hookInstaller.getMissingTools();
      expect(missing.find(t => t.flag === target.flag)).toBeUndefined();
    });

    test('recognizes the Kiro v1 global hook config as registered', () => {
      const target = TOOLS.find(t => t.flag === '--kiro');
      mockToolInstalled(target);

      const status = hookInstaller.refreshStatuses().find(t => t.flag === target.flag);
      expect(status.hasHook).toBe(true);
      expect(hookInstaller.getMissingTools().map(t => t.flag)).not.toContain(target.flag);
    });

    test('reads only the current Kiro global hook config', () => {
      const target = TOOLS.find(t => t.flag === '--kiro');
      const normalizedPaths = target.configPaths.map(p => p.replaceAll('\\', '/'));

      expect(normalizedPaths).toHaveLength(1);
      expect(normalizedPaths[0]).toMatch(/\/\.kiro\/hooks\/vibemon\.json$/);
      expect(normalizedPaths.some(p => p.includes('/.kiro/agents/default.json'))).toBe(false);
      expect(normalizedPaths.some(p => p.endsWith('.kiro.hook'))).toBe(false);
    });

    test('does not accept a Kiro config without a VibeMon command', () => {
      const target = TOOLS.find(t => t.flag === '--kiro');
      mockToolInstalled(target, {
        config: JSON.stringify({ version: 'v1', hooks: [] })
      });

      expect(hookInstaller.getMissingTools().map(t => t.flag)).toContain(target.flag);
    });

    // The script file surviving says nothing: the tool only runs it because
    // of an entry in its config, and pruning that entry used to leave the
    // status stuck on "installed" forever.
    test('includes a tool whose hook file is present but no longer registered', () => {
      const target = TOOLS[1];
      mockToolInstalled(target, { config: JSON.stringify({ hooks: {} }) });

      const missing = hookInstaller.getMissingTools();
      expect(missing.map(t => t.flag)).toContain(target.flag);
    });

    test('includes a tool whose config is missing entirely', () => {
      const target = TOOLS[1];
      const filePaths = new Set([target.homeDir, target.hookFile, ...target.files.map(f => f.local)]);
      fs.existsSync.mockImplementation(p => filePaths.has(p));
      fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

      const missing = hookInstaller.getMissingTools();
      expect(missing.map(t => t.flag)).toContain(target.flag);
    });

    test('excludes a dismissed tool', () => {
      const target = TOOLS[2];
      mockToolMissing(target);
      hookInstaller.dismiss([target]);

      const missing = hookInstaller.getMissingTools();
      expect(missing.find(t => t.flag === target.flag)).toBeUndefined();
    });

    test('a tool present via home dir (no CLI on PATH) is still detected', () => {
      const target = TOOLS[3];
      fs.existsSync.mockImplementation(p => p === target.homeDir);

      const missing = hookInstaller.getMissingTools();
      expect(missing.map(t => t.flag)).toContain(target.flag);
    });

    test('always recomputes (does not rely on the cache)', () => {
      const target = TOOLS[0];
      expect(hookInstaller.getMissingTools()).toEqual([]);

      mockToolMissing(target);
      expect(hookInstaller.getMissingTools().map(t => t.flag)).toEqual([target.flag]);
    });
  });

  describe('getCachedStatuses', () => {
    test('reflects state as of the last refresh without spawning new commands', () => {
      hookInstaller.refreshStatuses(); // baseline call count
      const callsAfterRefresh = spawnSync.mock.calls.length;

      const first = hookInstaller.getCachedStatuses();
      const second = hookInstaller.getCachedStatuses();

      expect(spawnSync.mock.calls.length).toBe(callsAfterRefresh);
      expect(first).toEqual(second);
      expect(first).not.toBe(hookInstaller.cachedStatuses); // defensive copy
    });

    test('is populated eagerly by the constructor', () => {
      expect(hookInstaller.getCachedStatuses()).toHaveLength(TOOLS.length);
    });

    test('reflects tool status after an explicit refreshStatuses() call', () => {
      const target = TOOLS[0];
      mockToolMissing(target);

      hookInstaller.refreshStatuses();
      const status = hookInstaller.getCachedStatuses().find(t => t.flag === target.flag);
      expect(status.present).toBe(true);
      expect(status.hasHook).toBe(false);
    });
  });

  describe('OpenCode integration', () => {
    function setup(options, { source = openCodeSource(), missingFiles = [], extraPaths = [] } = {}) {
      const loaded = loadInstallerFor(options);
      const tool = loaded.TOOLS.find(t => t.flag === '--opencode');
      const files = new Map(tool.files.map(file => [file.local,
        file.remote.endsWith('.js') ? source : 'adapter-bytes']));
      for (const file of missingFiles) files.delete(path.join(tool.homeDir, file));
      fs.existsSync.mockImplementation(p => p === tool.homeDir || files.has(p) || extraPaths.includes(p));
      fs.readFileSync.mockImplementation(p => {
        if (!files.has(p)) throw new Error('ENOENT');
        return files.get(p);
      });
      return { installer: new loaded.HookInstaller(), tool };
    }

    test.each([
      [{}, path.join(os.homedir(), '.config', 'opencode')],
      [{ OPENCODE_CONFIG_DIR: ' ', XDG_CONFIG_HOME: ' ' }, path.join(os.homedir(), '.config', 'opencode')],
      [{ OPENCODE_CONFIG_DIR: './custom opencode' }, path.resolve('custom opencode')],
      [{ OPENCODE_CONFIG_DIR: '~/custom opencode' }, path.join(os.homedir(), 'custom opencode')],
      [{ XDG_CONFIG_HOME: '~/xdg config' }, path.join(os.homedir(), 'xdg config', 'opencode')],
      [{ XDG_CONFIG_HOME: './xdg' }, path.resolve('xdg', 'opencode')],
      [{ OPENCODE_CONFIG_DIR: '/custom/opencode', XDG_CONFIG_HOME: '/ignored' }, '/custom/opencode']
    ])('resolves config paths from %j', (env, expected) => {
      const { tool } = setup({ env });
      expect(tool.homeDir).toBe(expected);
      expect(tool.hookFile).toBe(path.join(expected, 'hooks', 'vibemon.py'));
      expect(tool.files.map(file => file.local)).toContain(path.join(expected, 'plugins', 'vibemon.js'));
    });

    test('detects the CLI even when the config directory has not been created', () => {
      const { TOOLS: tools, HookInstaller: Installer } = loadInstallerFor();
      presentCommands = new Set(['opencode']);
      const installer = new Installer();
      expect(installer.getMissingTools().map(tool => tool.flag)).toEqual(['--opencode']);
      expect(tools.find(tool => tool.flag === '--opencode').command).toBe('opencode');
    });

    test('recognizes an auto-discovered plugin without a JSON config or CLI on PATH', () => {
      const { installer } = setup();
      expect(installer.getCachedStatuses().find(tool => tool.flag === '--opencode')).toMatchObject({
        present: true, hasHook: true, broken: false, changed: false
      });
      expect(installer.getMissingTools()).toEqual([]);
    });

    test.each(['plugins/vibemon.js', 'hooks/vibemon.py'])(
      'offers installation when %s is missing, even without a manifest', missing => {
        const { installer } = setup({}, { missingFiles: [missing] });
        expect(installer.getMissingTools().map(tool => tool.flag)).toEqual(['--opencode']);
      }
    );

    test.each(['opencode/plugin/vibemon.js', 'opencode/hooks/vibemon.py'])(
      'detects published changes to %s', remote => {
        const { installer } = setup();
        installer.manifest = { files: { [remote]: sha256('updated-source') } };
        const status = installer.refreshStatuses().find(tool => tool.flag === '--opencode');
        expect(status.changed).toBe(true);
        expect(installer.hasChanges()).toBe(true);
      }
    );

    test.each(['darwin', 'win32'])(
      'tracks plugin updates after installer path adaptation on %s', platform => {
        const env = { OPENCODE_CONFIG_DIR: path.join(os.homedir(), 'custom "config"') };
        const script = path.join(env.OPENCODE_CONFIG_DIR, 'hooks', 'vibemon.py');
        const python = platform === 'win32' ? 'C:/Program Files/Python/python.exe' : 'python3';
        const { installer } = setup({ platform, env }, {
          source: openCodeSource({ script, python }), extraPaths: [python]
        });
        installer.manifest = { files: {
          'opencode/plugin/vibemon.js': sha256(openCodeSource()),
          'opencode/hooks/vibemon.py': sha256('adapter-bytes')
        } };
        expect(installer.refreshStatuses().find(tool => tool.flag === '--opencode')).toMatchObject({
          hasHook: true, broken: false, changed: false
        });
        installer.manifest.files['opencode/plugin/vibemon.js'] = sha256(openCodeSource() + '// update\n');
        expect(installer.refreshStatuses().find(tool => tool.flag === '--opencode').changed).toBe(true);
      }
    );

    test('reports a Windows interpreter that moved after installation', () => {
      const python = 'C:/Program Files/Python312/python.exe';
      const { installer } = setup({ platform: 'win32' }, { source: openCodeSource({ python }) });
      expect(installer.getCachedStatuses().find(tool => tool.flag === '--opencode')).toMatchObject({
        hasHook: true, broken: true, brokenPath: python
      });
    });

    test('does not normalize an adapter path pointing to a different config directory', () => {
      const script = '/old config/hooks/vibemon.py';
      const { installer } = setup({}, { source: openCodeSource({ script }) });
      installer.manifest = { files: { 'opencode/plugin/vibemon.js': sha256(openCodeSource()) } };
      expect(installer.refreshStatuses().find(tool => tool.flag === '--opencode')).toMatchObject({
        hasHook: true, broken: true, brokenPath: script, changed: true
      });
    });

    test('passes the OpenCode flag to the verified installer', async () => {
      const { installer } = setup();
      mockSuccessfulInstall();
      const results = await installer.installByFlag('--opencode', null);
      expect(results).toHaveLength(1);
      expect(results[0].result.ok).toBe(true);
      expect(spawn).toHaveBeenCalledWith('python3', ['-', '--opencode'], expect.any(Object));
    });
  });

  describe('dismiss / isDismissed', () => {
    test('marks a tool dismissed and persists it across multiple calls', () => {
      const [toolA, toolB] = TOOLS;
      hookInstaller.dismiss([toolA]);
      expect(hookInstaller.isDismissed(toolA)).toBe(true);
      expect(hookInstaller.isDismissed(toolB)).toBe(false);

      hookInstaller.dismiss([toolB]);
      expect(hookInstaller.isDismissed(toolA)).toBe(true);
      expect(hookInstaller.isDismissed(toolB)).toBe(true);
    });

    // Nothing used to remove a flag from the store, so a mis-click silenced
    // the automatic prompt for that tool permanently.
    test('clearDismissed restores the automatic prompt', () => {
      const target = TOOLS[0];
      mockToolMissing(target);
      hookInstaller.dismiss([target]);
      expect(hookInstaller.getMissingTools()).toEqual([]);
      expect(hookInstaller.hasDismissed()).toBe(true);

      hookInstaller.clearDismissed();

      expect(hookInstaller.isDismissed(target)).toBe(false);
      expect(hookInstaller.hasDismissed()).toBe(false);
      expect(hookInstaller.getMissingTools().map(t => t.flag)).toEqual([target.flag]);
    });

    test('clearDismissed also lifts the in-session suppression a failed install set', async () => {
      const target = TOOLS[0];
      mockToolMissing(target);
      pythonAvailable = false;
      await hookInstaller.installTools([target], null);
      expect(hookInstaller.getMissingTools()).toEqual([]);

      hookInstaller.clearDismissed();

      expect(hookInstaller.getMissingTools().map(t => t.flag)).toEqual([target.flag]);
    });

    test('the status view reports which tools are dismissed', () => {
      const target = TOOLS[0];
      mockToolMissing(target);
      hookInstaller.dismiss([target]);

      const status = hookInstaller.refreshStatuses().find(t => t.flag === target.flag);
      expect(status.dismissed).toBe(true);
    });
  });

  describe('broken registrations', () => {
    const claude = TOOLS.find(t => t.flag === '--claude');

    // install.py bakes absolute paths into the Windows hook command; a Python
    // upgrade moves the interpreter and every hook silently stops running,
    // while the script file and its hash both still look fine.
    function mockClaudeRegisteredWith(command) {
      mockToolInstalled(claude, {
        config: JSON.stringify({ hooks: { Stop: [{ hooks: [{ command }] }] } })
      });
    }

    test('flags an absolute interpreter path that no longer exists', () => {
      mockClaudeRegisteredWith(`C:/Python312/python.exe ${claude.hookFile}`);

      const status = hookInstaller.refreshStatuses().find(t => t.flag === claude.flag);
      expect(status.hasHook).toBe(true);
      expect(status.broken).toBe(true);
      expect(status.brokenPath).toBe('C:/Python312/python.exe');
      expect(hookInstaller.hasChanges()).toBe(true);
    });

    test('handles the quoted and call-operator forms install.py emits', () => {
      mockClaudeRegisteredWith(`& "C:/Program Files/Python312/python.exe" "${claude.hookFile}"`);

      const status = hookInstaller.refreshStatuses().find(t => t.flag === claude.flag);
      expect(status.brokenPath).toBe('C:/Program Files/Python312/python.exe');
    });

    test('flags exec form through args, not just the command string', () => {
      mockToolInstalled(claude, {
        config: JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ command: 'python3', args: ['/gone/hooks/vibemon.py'] }] }]
          }
        })
      });

      const status = hookInstaller.refreshStatuses().find(t => t.flag === claude.flag);
      expect(status.brokenPath).toBe('/gone/hooks/vibemon.py');
    });

    test.each([
      ["python3 '/custom config/hooks/vibemon.py'", '/custom config/hooks/vibemon.py'],
      ["python3 '/custom'\"'\"'s config/hooks/vibemon.py'", "/custom's config/hooks/vibemon.py"]
    ])('detects missing POSIX paths in %s', (command, expected) => {
      mockClaudeRegisteredWith(command);
      expect(hookInstaller.refreshStatuses().find(t => t.flag === claude.flag).brokenPath).toBe(expected);
    });

    test('accepts an existing single-quoted POSIX hook path with spaces', () => {
      const script = '/custom config/hooks/vibemon.py';
      mockClaudeRegisteredWith(`python3 '${script}'`);
      const exists = fs.existsSync.getMockImplementation();
      fs.existsSync.mockImplementation(p => p === script || exists(p));
      expect(hookInstaller.refreshStatuses().find(t => t.flag === claude.flag).broken).toBe(false);
    });

    test.each(['darwin', 'win32'])('inspects only the effective Codex command on %s', platform => {
      const loaded = loadInstallerFor({ platform });
      const tool = loaded.TOOLS.find(t => t.flag === '--codex');
      const good = `python3 "${tool.hookFile}"`;
      const bad = 'python3 /gone/vibemon.py';
      mockToolInstalled(tool, { config: JSON.stringify({ hooks: { Stop: [{ hooks: [{
        command: platform === 'win32' ? bad : good,
        commandWindows: platform === 'win32' ? good : bad
      }] }] } }) });
      const status = new loaded.HookInstaller().getCachedStatuses().find(t => t.flag === '--codex');
      expect(status).toMatchObject({ hasHook: true, broken: false });
    });

    // The POSIX form has nothing absolute in it, so there is nothing to verify
    // and it must never be reported as broken.
    test('leaves a PATH name and a tilde path alone', () => {
      mockClaudeRegisteredWith('python3 ~/.claude/hooks/vibemon.py');

      const status = hookInstaller.refreshStatuses().find(t => t.flag === claude.flag);
      expect(status.hasHook).toBe(true);
      expect(status.broken).toBe(false);
      expect(hookInstaller.hasChanges()).toBe(false);
    });

    test('an OpenClaw entry counts as registered without any command', () => {
      const openclaw = TOOLS.find(t => t.flag === '--openclaw');
      mockToolInstalled(openclaw);
      presentCommands = new Set([openclaw.command]);

      const status = hookInstaller.refreshStatuses().find(t => t.flag === openclaw.flag);
      expect(status.hasHook).toBe(true);
      expect(status.broken).toBe(false);
    });

    test('a disabled OpenClaw plugin entry is not registered', () => {
      const openclaw = TOOLS.find(t => t.flag === '--openclaw');
      mockToolInstalled(openclaw, {
        config: JSON.stringify({ plugins: { entries: { 'vibemon-bridge': { enabled: false } } } })
      });
      presentCommands = new Set([openclaw.command]);

      const status = hookInstaller.refreshStatuses().find(t => t.flag === openclaw.flag);
      expect(status.hasHook).toBe(false);
    });

    test.each([
      undefined,
      { paths: [] },
      { paths: 'not-an-array' },
      { paths: [null, 123, '/unrelated/plugin'] }
    ])('rejects an enabled OpenClaw entry without a usable load path: %j', load => {
      const tool = TOOLS.find(t => t.flag === '--openclaw');
      mockToolInstalled(tool, { config: JSON.stringify({ plugins: {
        entries: { 'vibemon-bridge': { enabled: true } }, load
      } }) });
      expect(hookInstaller.getMissingTools().map(t => t.flag)).toContain('--openclaw');
    });

    test.each([
      '~/.openclaw/extensions/vibemon-bridge',
      '~/.openclaw/extensions/vibemon-bridge/index.mjs'
    ])('accepts the OpenClaw load path %s', pluginPath => {
      const tool = TOOLS.find(t => t.flag === '--openclaw');
      mockToolInstalled(tool, { config: JSON.stringify({ plugins: {
        entries: { 'vibemon-bridge': { enabled: true } }, load: { paths: [pluginPath] }
      } }) });
      expect(hookInstaller.refreshStatuses().find(t => t.flag === '--openclaw').hasHook).toBe(true);
    });

    test('does not report installed when OpenClaw plugins are globally disabled', () => {
      const tool = TOOLS.find(t => t.flag === '--openclaw');
      const config = JSON.parse(registeredConfigFor(tool));
      config.plugins.enabled = false;
      mockToolInstalled(tool, { config: JSON.stringify(config) });
      expect(hookInstaller.refreshStatuses().find(t => t.flag === '--openclaw').hasHook).toBe(false);
    });
  });

  describe('downloadScript', () => {
    test('resolves the script body on a 200 response', async () => {
      const fakeRes = new EventEmitter();
      fakeRes.statusCode = 200;
      fakeRes.setEncoding = jest.fn();
      https.get.mockImplementation((url, opts, cb) => {
        expect(url).toBe('https://docs.example.test/install.py');
        cb(fakeRes);
        return new EventEmitter();
      });

      const promise = hookInstaller.downloadScript();
      fakeRes.emit('data', 'print(1)');
      fakeRes.emit('end');

      expect(await promise).toBe('print(1)');
    });

    test('rejects with download-failed on a non-200 response', async () => {
      const fakeRes = new EventEmitter();
      fakeRes.statusCode = 500;
      fakeRes.resume = jest.fn();
      https.get.mockImplementation((url, opts, cb) => {
        cb(fakeRes);
        return new EventEmitter();
      });

      await expect(hookInstaller.downloadScript()).rejects.toEqual({ reason: 'download-failed', statusCode: 500 });
    });

    test('rejects with network-error when the request errors out', async () => {
      const fakeReq = new EventEmitter();
      https.get.mockImplementation(() => fakeReq);

      const promise = hookInstaller.downloadScript();
      fakeReq.emit('error', new Error('boom'));

      await expect(promise).rejects.toEqual({ reason: 'network-error', error: 'boom' });
    });

    test('rejects with download-too-large when the response exceeds the size cap', async () => {
      const fakeRes = new EventEmitter();
      fakeRes.statusCode = 200;
      fakeRes.setEncoding = jest.fn();
      fakeRes.destroy = jest.fn();
      https.get.mockImplementation((url, opts, cb) => {
        cb(fakeRes);
        return new EventEmitter();
      });

      const promise = hookInstaller.downloadScript();
      fakeRes.emit('data', 'x'.repeat(1024 * 1024 + 1));

      await expect(promise).rejects.toEqual({ reason: 'download-too-large' });
      expect(fakeRes.destroy).toHaveBeenCalled();
    });
  });

  describe('runScript', () => {
    test('spawns python3 without exposing the token in process arguments', async () => {
      const fakeChild = new EventEmitter();
      fakeChild.stdin = { write: jest.fn(), end: jest.fn() };
      fakeChild.stdout = new EventEmitter();
      fakeChild.stderr = new EventEmitter();
      spawn.mockReturnValue(fakeChild);

      const resultPromise = hookInstaller.runScript('print(1)', PYTHON, ['--claude'], 'my_token123');
      fakeChild.emit('close', 0);
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      expect(spawn).toHaveBeenCalledWith(
        'python3',
        ['-', '--claude'],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
      );
      expect(spawn.mock.calls[0][2].shell).toBeUndefined();
      expect(fakeChild.stdin.write).toHaveBeenCalledWith('print(1)');
      expect(fakeChild.stdin.end).toHaveBeenCalled();
    });

    // install.py separates "run unattended" (a platform flag) from "replace
    // settings I own" (--yes). Passing --yes would silently overwrite a
    // statusLine the user configured themselves.
    test('does not pass --yes, so user-owned settings survive an install', async () => {
      const fakeChild = new EventEmitter();
      fakeChild.stdin = { write: jest.fn(), end: jest.fn() };
      fakeChild.stdout = new EventEmitter();
      fakeChild.stderr = new EventEmitter();
      spawn.mockReturnValue(fakeChild);

      const resultPromise = hookInstaller.runScript('print(1)', PYTHON, ['--claude']);
      fakeChild.emit('close', 0);
      await resultPromise;

      expect(spawn.mock.calls[0][1]).not.toContain('--yes');
      expect(spawn.mock.calls[0][1]).not.toContain('-y');
    });

    test('resolves ok:false with exit code when the script fails', async () => {
      const fakeChild = new EventEmitter();
      fakeChild.stdin = { write: jest.fn(), end: jest.fn() };
      fakeChild.stdout = new EventEmitter();
      fakeChild.stderr = new EventEmitter();
      spawn.mockReturnValue(fakeChild);

      const resultPromise = hookInstaller.runScript('script', PYTHON, ['--codex'], null);
      fakeChild.stderr.emit('data', 'traceback');
      fakeChild.emit('close', 1);

      expect(await resultPromise).toEqual({
        ok: false, reason: 'exit-code', code: 1, stdout: '', stderr: 'traceback'
      });
      expect(spawn.mock.calls[0][1]).not.toContain('--token');
    });

    // A piped stream nobody reads blocks the child once the OS pipe buffer
    // fills, and install.py prints its failures to stdout, not stderr.
    test('drains stdout and keeps it on the result', async () => {
      const fakeChild = new EventEmitter();
      fakeChild.stdin = { write: jest.fn(), end: jest.fn() };
      fakeChild.stdout = new EventEmitter();
      fakeChild.stderr = new EventEmitter();
      spawn.mockReturnValue(fakeChild);

      const resultPromise = hookInstaller.runScript('script', PYTHON, ['--claude']);
      expect(fakeChild.stdout.listenerCount('data')).toBe(1);
      fakeChild.stdout.emit('data', 'installing...\n');
      fakeChild.stdout.emit('data', 'done\n');
      fakeChild.emit('close', 0);

      expect((await resultPromise).stdout).toBe('installing...\ndone\n');
    });

    test('caps captured output so a runaway script cannot grow it without bound', async () => {
      const fakeChild = new EventEmitter();
      fakeChild.stdin = { write: jest.fn(), end: jest.fn() };
      fakeChild.stdout = new EventEmitter();
      fakeChild.stderr = new EventEmitter();
      spawn.mockReturnValue(fakeChild);

      const resultPromise = hookInstaller.runScript('script', PYTHON, ['--claude']);
      for (let i = 0; i < 40; i++) {
        fakeChild.stdout.emit('data', 'x'.repeat(4 * 1024));
      }
      fakeChild.stdout.emit('data', 'TAIL');
      fakeChild.emit('close', 1);

      const { stdout } = await resultPromise;
      expect(stdout.length).toBe(64 * 1024);
      expect(stdout.endsWith('TAIL')).toBe(true); // the tail is what diagnoses a failure
    });
  });

  describe('failure reporting', () => {
    test('surfaces the script\'s own failure line alongside the exit code', () => {
      const message = describeFailure({
        reason: 'exit-code',
        code: 1,
        stdout: '\u001b[36m  Mode: online\u001b[0m\n'
          + '\u001b[31m✗\u001b[0m Claude Code aborted: claude/statusline.py failed its integrity check\n',
        stderr: ''
      });

      expect(message).toContain('exited with code 1');
      expect(message).toContain('failed its integrity check');
      expect(message).not.toContain('\u001b['); // ANSI stripped for the dialog
      expect(message).not.toContain('Mode: online');
    });

    test('falls back to the tail of the output when nothing is marked as a failure', () => {
      const message = describeFailure({
        reason: 'exit-code', code: 2, stdout: 'usage: install.py\ninstall.py: error: bad --token\n', stderr: ''
      });

      expect(message).toContain('error: bad --token');
    });

    test('reports the bare exit code when the script produced no output', () => {
      expect(describeFailure({ reason: 'exit-code', code: 1, stdout: '', stderr: '' }))
        .toBe('Install script exited with code 1');
    });
  });

  describe('installTools', () => {
    test('does not run concurrently; returns [] without spawning anything', async () => {
      hookInstaller.isRunning = true;

      const result = await hookInstaller.installTools([TOOLS[0]], null);

      expect(result).toEqual([]);
      expect(https.get).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });

    test('fails the whole batch with python-not-found when python3 is missing (no download attempted)', async () => {
      pythonAvailable = false;

      const results = await hookInstaller.installTools([TOOLS[0], TOOLS[1]], null);

      expect(results.map(r => r.result.reason)).toEqual(['python-not-found', 'python-not-found']);
      expect(https.get).not.toHaveBeenCalled();
      expect(hookInstaller.sessionSuppressed.has(TOOLS[0].flag)).toBe(true);
      expect(hookInstaller.sessionSuppressed.has(TOOLS[1].flag)).toBe(true);
    });

    test('downloads install.py exactly once for a multi-tool batch and spawns once per tool', async () => {
      const children = mockSuccessfulInstall();

      const results = await hookInstaller.installTools([TOOLS[0], TOOLS[1]], 'my_token_123');

      const scriptFetches = https.get.mock.calls.filter(c => c[0].endsWith('/install.py'));
      expect(scriptFetches).toHaveLength(1);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(children).toHaveLength(2);
      expect(results.every(r => r.result.ok)).toBe(true);
      expect(spawn.mock.calls[0][1]).toEqual(['-', TOOLS[0].flag, '--token', 'my_token_123']);
      expect(spawn.mock.calls[1][1]).toEqual(['-', TOOLS[1].flag, '--token', 'my_token_123']);
    });

    test('omits --token when the token is missing or malformed (install.py exits 2 on a bad --token)', async () => {
      mockSuccessfulInstall();

      await hookInstaller.installTools([TOOLS[0]], null);
      expect(spawn.mock.calls[0][1]).toEqual(['-', TOOLS[0].flag]);

      await hookInstaller.installTools([TOOLS[0]], 'BAD TOKEN!');
      expect(spawn.mock.calls[1][1]).toEqual(['-', TOOLS[0].flag]);
    });

    test('suppresses the whole batch and skips spawning when the download fails', async () => {
      const fakeReq = new EventEmitter();
      https.get.mockImplementation(() => fakeReq);

      const resultPromise = hookInstaller.installTools([TOOLS[0], TOOLS[1]], null);
      setTimeout(() => fakeReq.emit('error', new Error('offline')), 0);
      const results = await resultPromise;

      expect(results.map(r => r.result.reason)).toEqual(['network-error', 'network-error']);
      expect(spawn).not.toHaveBeenCalled();
      expect(hookInstaller.sessionSuppressed.has(TOOLS[0].flag)).toBe(true);
      expect(hookInstaller.sessionSuppressed.has(TOOLS[1].flag)).toBe(true);
    });

    test('fails the batch with integrity-check-failed when install.py does not match the manifest installer hash', async () => {
      https.get.mockImplementation((url, opts, cb) => {
        const fakeRes = new EventEmitter();
        fakeRes.statusCode = 200;
        fakeRes.setEncoding = jest.fn();
        cb(fakeRes);
        const body = url.endsWith('/manifest.json')
          ? JSON.stringify({ installer: sha256('published-script'), files: {} })
          : 'tampered-script';
        setTimeout(() => {
          fakeRes.emit('data', body);
          fakeRes.emit('end');
        }, 0);
        return new EventEmitter();
      });

      const results = await hookInstaller.installTools([TOOLS[0]], null);

      expect(results.map(r => r.result.reason)).toEqual(['integrity-check-failed']);
      expect(spawn).not.toHaveBeenCalled();
    });

    test('fails the batch with integrity-reference-missing when the manifest has no installer hash', async () => {
      https.get.mockImplementation((url, opts, cb) => {
        const fakeRes = new EventEmitter();
        fakeRes.statusCode = 200;
        fakeRes.setEncoding = jest.fn();
        cb(fakeRes);
        setTimeout(() => {
          fakeRes.emit('data', JSON.stringify({ files: {} }));
          fakeRes.emit('end');
        }, 0);
        return new EventEmitter();
      });

      const results = await hookInstaller.installTools([TOOLS[0]], null);

      expect(results.map(r => r.result.reason)).toEqual(['integrity-reference-missing']);
      expect(spawn).not.toHaveBeenCalled();
    });

    test('a previously fetched manifest verifies the install when the fresh fetch fails', async () => {
      hookInstaller.manifest = { installer: sha256('script-source'), files: {} };
      https.get.mockImplementation((url, opts, cb) => {
        if (url.endsWith('/manifest.json')) {
          const fakeReq = new EventEmitter();
          setTimeout(() => fakeReq.emit('error', new Error('offline')), 0);
          return fakeReq;
        }
        const fakeRes = new EventEmitter();
        fakeRes.statusCode = 200;
        fakeRes.setEncoding = jest.fn();
        cb(fakeRes);
        setTimeout(() => {
          fakeRes.emit('data', 'script-source');
          fakeRes.emit('end');
        }, 0);
        return new EventEmitter();
      });
      spawn.mockImplementation(() => {
        const child = new EventEmitter();
        child.stdin = { write: jest.fn(), end: jest.fn() };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setTimeout(() => child.emit('close', 0), 0);
        return child;
      });

      const results = await hookInstaller.installTools([TOOLS[0]], null);

      expect(results.every(r => r.result.ok)).toBe(true);
    });

    test('refreshes the status cache after finishing', async () => {
      mockSuccessfulInstall();
      mockToolInstalled(TOOLS[0]); // hook "now installed"

      await hookInstaller.installTools([TOOLS[0]], null);

      const status = hookInstaller.getCachedStatuses().find(t => t.flag === TOOLS[0].flag);
      expect(status.hasHook).toBe(true);
    });

    // A dialog confirming what the user just asked for is a modal
    // interruption; the tray submenu and Settings rows already show it.
    test('stays silent when every tool installed', async () => {
      mockSuccessfulInstall();

      await hookInstaller.installTools([TOOLS[0]], null);

      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    });

    test('still reports failures, with the setup guide offered', async () => {
      pythonAvailable = false;

      await hookInstaller.installTools([TOOLS[0]], null);

      expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
        type: 'warning',
        message: 'VibeMon hook installation failed',
        buttons: ['OK', 'Open Setup Guide']
      }));
    });

    test('names the tools that did succeed alongside the ones that failed', async () => {
      mockSuccessfulInstall();
      let call = 0;
      spawn.mockImplementation(() => {
        const child = new EventEmitter();
        child.stdin = { write: jest.fn(), end: jest.fn() };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        const code = call++ === 0 ? 0 : 1;
        setTimeout(() => child.emit('close', code), 0);
        return child;
      });

      await hookInstaller.installTools([TOOLS[0], TOOLS[1]], null);

      const { detail, message } = dialog.showMessageBox.mock.calls[0][0];
      expect(message).toBe('Some hooks failed to install');
      expect(detail).toContain(`Succeeded: ${TOOLS[0].name}`);
      expect(detail).toContain(TOOLS[1].name);
    });
  });

  describe('installByFlag', () => {
    test('resolves [] for an unknown flag without touching network/spawn', async () => {
      const result = await hookInstaller.installByFlag('--nope', null);
      expect(result).toEqual([]);
      expect(https.get).not.toHaveBeenCalled();
    });

    test('installs the matching tool', async () => {
      mockSuccessfulInstall();

      const results = await hookInstaller.installByFlag(TOOLS[2].flag, null);

      expect(results).toHaveLength(1);
      expect(results[0].tool.flag).toBe(TOOLS[2].flag);
      expect(spawn.mock.calls[0][1]).toContain(TOOLS[2].flag);
    });

    test('reports a failure through the result dialog by default', async () => {
      pythonAvailable = false;

      await hookInstaller.installByFlag(TOOLS[2].flag, null);

      expect(dialog.showMessageBox).toHaveBeenCalled();
    });

    test('skips the result dialog when showSummary is false', async () => {
      pythonAvailable = false;

      await hookInstaller.installByFlag(TOOLS[2].flag, null, { showSummary: false });

      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    });
  });

  describe('change detection', () => {
    const claude = TOOLS.find(t => t.flag === '--claude');
    const shared = TOOLS.find(t => t.flag === '--vibemon');

    // Serves a manifest.json body from the mocked https.get.
    function mockManifestResponse(body) {
      const fakeRes = new EventEmitter();
      fakeRes.statusCode = 200;
      fakeRes.setEncoding = jest.fn();
      https.get.mockImplementation((url, opts, cb) => {
        expect(url).toBe('https://docs.example.test/manifest.json');
        cb(fakeRes);
        setTimeout(() => {
          fakeRes.emit('data', body);
          fakeRes.emit('end');
        }, 0);
        return new EventEmitter();
      });
    }

    // Claude present and registered, with every tracked file holding `contents`.
    function mockClaudeInstalled(contents = 'local-bytes') {
      mockToolInstalled(claude, { fileContents: contents });
    }

    function manifestFor(hashByRemote) {
      return JSON.stringify({ files: hashByRemote });
    }

    test('downloadManifest rejects invalid JSON and malformed shapes', async () => {
      mockManifestResponse('not json');
      await expect(hookInstaller.downloadManifest()).rejects.toEqual({ reason: 'invalid-manifest' });

      mockManifestResponse(JSON.stringify({ files: { 'a.py': 'not-a-hash' } }));
      await expect(hookInstaller.downloadManifest()).rejects.toEqual({ reason: 'invalid-manifest' });

      mockManifestResponse(JSON.stringify({ nope: true }));
      await expect(hookInstaller.downloadManifest()).rejects.toEqual({ reason: 'invalid-manifest' });

      mockManifestResponse(JSON.stringify({ installer: 'not-a-hash', files: {} }));
      await expect(hookInstaller.downloadManifest()).rejects.toEqual({ reason: 'invalid-manifest' });
    });

    test('downloadManifest accepts a manifest with a valid installer hash', async () => {
      const installer = sha256('install.py source');
      mockManifestResponse(JSON.stringify({ installer, files: {} }));

      await expect(hookInstaller.downloadManifest()).resolves.toEqual({ installer, files: {} });
    });

    test('checkForChanges flags a tool whose file hash differs from the manifest', async () => {
      mockClaudeInstalled('local-bytes');
      mockManifestResponse(manifestFor({ 'claude/hooks/vibemon.py': sha256('published-bytes') }));

      await expect(hookInstaller.checkForChanges()).resolves.toBe(true);

      const status = hookInstaller.getCachedStatuses().find(t => t.flag === claude.flag);
      expect(status.changed).toBe(true);
      expect(hookInstaller.hasChanges()).toBe(true);
    });

    test('checkForChanges includes the Kiro global hook config on POSIX', async () => {
      if (process.platform === 'win32') return;

      const kiro = TOOLS.find(t => t.flag === '--kiro');
      const configFile = kiro.files.find(f => f.remote === 'kiro/hooks/vibemon.json');
      expect(configFile.local).toBe(kiro.configPaths[0]);
      mockToolInstalled(kiro);
      mockManifestResponse(manifestFor({
        'kiro/hooks/vibemon.py': sha256('local-bytes'),
        'kiro/hooks/vibemon.json': sha256('published-config')
      }));

      await expect(hookInstaller.checkForChanges()).resolves.toBe(true);

      const status = hookInstaller.getCachedStatuses().find(t => t.flag === kiro.flag);
      expect(status.hasHook).toBe(true);
      expect(status.changed).toBe(true);
    });

    test('checkForChanges reports no drift when hashes match', async () => {
      mockClaudeInstalled('local-bytes');
      mockManifestResponse(manifestFor({
        'claude/hooks/vibemon.py': sha256('local-bytes'),
        'claude/statusline.py': sha256('local-bytes')
      }));

      await expect(hookInstaller.checkForChanges()).resolves.toBe(false);
      expect(hookInstaller.hasChanges()).toBe(false);
    });

    test('a missing tracked file counts as changed while the hook itself is installed', async () => {
      const statuslinePath = claude.files.find(f => f.remote === 'claude/statusline.py').local;
      mockToolInstalled(claude, { missingFiles: [statuslinePath] });
      mockManifestResponse(manifestFor({
        'claude/hooks/vibemon.py': sha256('local-bytes'),
        'claude/statusline.py': sha256('local-bytes')
      }));

      await expect(hookInstaller.checkForChanges()).resolves.toBe(true);
    });

    test('a failed manifest fetch keeps changed flags off (existence-only checking)', async () => {
      mockClaudeInstalled('local-bytes');
      const fakeReq = new EventEmitter();
      https.get.mockImplementation(() => fakeReq);

      const promise = hookInstaller.checkForChanges();
      setTimeout(() => fakeReq.emit('error', new Error('offline')), 0);

      await expect(promise).resolves.toBe(false);
      expect(hookInstaller.hasChanges()).toBe(false);
    });

    test('files untracked by the manifest never count as changed', async () => {
      mockClaudeInstalled('local-bytes');
      mockManifestResponse(manifestFor({ 'unrelated/file.py': sha256('whatever') }));

      await expect(hookInstaller.checkForChanges()).resolves.toBe(false);
    });

    test('VibeMon Scripts entry is always present and excluded from the install prompt', () => {
      expect(shared).toBeDefined();
      const status = hookInstaller.getCachedStatuses().find(t => t.flag === '--vibemon');
      expect(status.present).toBe(true);
      expect(status.hasHook).toBe(false); // no files on disk in this mock
      expect(hookInstaller.getMissingTools().map(t => t.flag)).not.toContain('--vibemon');
    });

    test('VibeMon Scripts hasHook requires every shared file to exist', () => {
      const [first, ...rest] = shared.files.map(f => f.local);
      fs.existsSync.mockImplementation(p => rest.includes(p)); // one file missing
      expect(hookInstaller.refreshStatuses().find(t => t.flag === '--vibemon').hasHook).toBe(false);

      fs.existsSync.mockImplementation(p => p === first || rest.includes(p));
      expect(hookInstaller.refreshStatuses().find(t => t.flag === '--vibemon').hasHook).toBe(true);
    });
  });

  describe('checkAndPrompt', () => {
    test('does nothing when no tools are missing', async () => {
      await hookInstaller.checkAndPrompt(null);
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    });

    test('does nothing when an install is already running', async () => {
      mockToolMissing(TOOLS[0]);
      hookInstaller.isRunning = true;

      await hookInstaller.checkAndPrompt(null);

      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    });

    test('installs missing tools when the user confirms (response 0)', async () => {
      mockToolMissing(TOOLS[0]);
      dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
      mockSuccessfulInstall();

      await hookInstaller.checkAndPrompt('tok');

      expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
        detail: expect.stringContaining(TOOLS[0].name)
      }));
      expect(spawn).toHaveBeenCalledWith(
        process.platform === 'win32' ? 'py' : 'python3',
        expect.arrayContaining(['-', TOOLS[0].flag]),
        expect.anything()
      );
    });

    test('does not install or dismiss when the user picks Skip (response 1)', async () => {
      mockToolMissing(TOOLS[1]);
      dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });

      await hookInstaller.checkAndPrompt(null);

      expect(spawn).not.toHaveBeenCalled();
      expect(hookInstaller.isDismissed(TOOLS[1])).toBe(false);
      expect(hookInstaller.getMissingTools().map(t => t.flag)).toContain(TOOLS[1].flag);
    });

    test('persists dismissal when the user picks Don\'t Ask Again (response 2)', async () => {
      mockToolMissing(TOOLS[2]);
      dialog.showMessageBox.mockResolvedValueOnce({ response: 2 });

      await hookInstaller.checkAndPrompt(null);

      expect(spawn).not.toHaveBeenCalled();
      expect(hookInstaller.isDismissed(TOOLS[2])).toBe(true);
      expect(hookInstaller.getMissingTools().map(t => t.flag)).not.toContain(TOOLS[2].flag);
    });
  });
});
