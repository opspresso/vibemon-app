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
const { HookInstaller, TOOLS, verifyInstallerScript } = require('../src/modules/hook-installer.cjs');

test('installer integrity verification rejects a mismatched digest', () => {
  expect(verifyInstallerScript('print(1)', '0'.repeat(64))).toBe(false);
});

test('installer integrity verification accepts a matching digest', () => {
  expect(verifyInstallerScript('print(1)', 'd287bb7f9d15abdc5b6e98536263815744b6ef21c8f3c839fc434ca70d8efe99')).toBe(true);
});

// Makes a tool "present" via its CLI command, with no hook file, so it
// shows up as missing. Other tools stay absent (default mocks).
function mockToolMissing(tool) {
  spawnSync.mockImplementation((which, args) => ({ status: args[0] === tool.command ? 0 : 1 }));
}

// Configures https.get + spawn to simulate a successful install.py run.
// Events fire via setTimeout(..., 0) so this works regardless of how many
// microtask boundaries (dialog awaits, etc.) sit between the mock setup
// and the actual https.get()/spawn() calls.
function mockSuccessfulInstall() {
  const fakeRes = new EventEmitter();
  fakeRes.statusCode = 200;
  fakeRes.setEncoding = jest.fn();
  https.get.mockImplementation((url, opts, cb) => {
    cb(fakeRes);
    setTimeout(() => {
      fakeRes.emit('data', 'script-source');
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
    spawnSync.mockReset().mockReturnValue({ status: 1 });
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

    test('excludes a tool that already has its hook file installed', () => {
      const target = TOOLS[1];
      fs.existsSync.mockImplementation(p => p === target.homeDir || p === target.hookFile);

      const missing = hookInstaller.getMissingTools();
      expect(missing.find(t => t.flag === target.flag)).toBeUndefined();
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

      const resultPromise = hookInstaller.runScript('print(1)', ['--claude'], 'my_token123');
      fakeChild.emit('close', 0);
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      expect(spawn).toHaveBeenCalledWith(
        'python3',
        ['-', '--claude', '--yes'],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
      );
      expect(spawn.mock.calls[0][2].shell).toBeUndefined();
      expect(fakeChild.stdin.write).toHaveBeenCalledWith('print(1)');
      expect(fakeChild.stdin.end).toHaveBeenCalled();
    });

    test('resolves ok:false with exit code when the script fails', async () => {
      const fakeChild = new EventEmitter();
      fakeChild.stdin = { write: jest.fn(), end: jest.fn() };
      fakeChild.stdout = new EventEmitter();
      fakeChild.stderr = new EventEmitter();
      spawn.mockReturnValue(fakeChild);

      const resultPromise = hookInstaller.runScript('script', ['--codex'], null);
      fakeChild.stderr.emit('data', 'traceback');
      fakeChild.emit('close', 1);

      expect(await resultPromise).toEqual({ ok: false, reason: 'exit-code', code: 1, stderr: 'traceback' });
      expect(spawn.mock.calls[0][1]).not.toContain('--token');
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
      spawnSync.mockReturnValue({ status: 1 });

      const results = await hookInstaller.installTools([TOOLS[0], TOOLS[1]], null);

      expect(results.map(r => r.result.reason)).toEqual(['python-not-found', 'python-not-found']);
      expect(https.get).not.toHaveBeenCalled();
      expect(hookInstaller.sessionSuppressed.has(TOOLS[0].flag)).toBe(true);
      expect(hookInstaller.sessionSuppressed.has(TOOLS[1].flag)).toBe(true);
    });

    test('downloads install.py exactly once for a multi-tool batch and spawns once per tool', async () => {
      spawnSync.mockReturnValue({ status: 0 }); // python present
      const children = mockSuccessfulInstall();

      const results = await hookInstaller.installTools([TOOLS[0], TOOLS[1]], 'my_token_123');

      expect(https.get).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(children).toHaveLength(2);
      expect(results.every(r => r.result.ok)).toBe(true);
      expect(spawn.mock.calls[0][1]).toEqual(['-', TOOLS[0].flag, '--token', 'my_token_123', '--yes']);
      expect(spawn.mock.calls[1][1]).toEqual(['-', TOOLS[1].flag, '--token', 'my_token_123', '--yes']);
    });

    test('omits --token when the token is missing or malformed (install.py exits 2 on a bad --token)', async () => {
      spawnSync.mockReturnValue({ status: 0 }); // python present
      mockSuccessfulInstall();

      await hookInstaller.installTools([TOOLS[0]], null);
      expect(spawn.mock.calls[0][1]).toEqual(['-', TOOLS[0].flag, '--yes']);

      await hookInstaller.installTools([TOOLS[0]], 'BAD TOKEN!');
      expect(spawn.mock.calls[1][1]).toEqual(['-', TOOLS[0].flag, '--yes']);
    });

    test('suppresses the whole batch and skips spawning when the download fails', async () => {
      spawnSync.mockReturnValue({ status: 0 }); // python present
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

    test('refreshes the status cache after finishing', async () => {
      spawnSync.mockReturnValue({ status: 0 });
      mockSuccessfulInstall();
      fs.existsSync.mockReturnValue(true); // hook "now installed"

      await hookInstaller.installTools([TOOLS[0]], null);

      const status = hookInstaller.getCachedStatuses().find(t => t.flag === TOOLS[0].flag);
      expect(status.hasHook).toBe(true);
    });

    test('shows a summary dialog when finished', async () => {
      spawnSync.mockReturnValue({ status: 0 });
      mockSuccessfulInstall();

      await hookInstaller.installTools([TOOLS[0]], null);

      expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
        message: 'VibeMon hooks installed'
      }));
    });
  });

  describe('installByFlag', () => {
    test('resolves [] for an unknown flag without touching network/spawn', async () => {
      const result = await hookInstaller.installByFlag('--nope', null);
      expect(result).toEqual([]);
      expect(https.get).not.toHaveBeenCalled();
    });

    test('installs the matching tool', async () => {
      spawnSync.mockReturnValue({ status: 0 });
      mockSuccessfulInstall();

      const results = await hookInstaller.installByFlag(TOOLS[2].flag, null);

      expect(results).toHaveLength(1);
      expect(results[0].tool.flag).toBe(TOOLS[2].flag);
      expect(spawn.mock.calls[0][1]).toContain(TOOLS[2].flag);
    });

    test('shows the result dialog by default', async () => {
      spawnSync.mockReturnValue({ status: 0 });
      mockSuccessfulInstall();

      await hookInstaller.installByFlag(TOOLS[2].flag, null);

      expect(dialog.showMessageBox).toHaveBeenCalled();
    });

    test('skips the result dialog when showSummary is false', async () => {
      spawnSync.mockReturnValue({ status: 0 });
      mockSuccessfulInstall();

      await hookInstaller.installByFlag(TOOLS[2].flag, null, { showSummary: false });

      expect(dialog.showMessageBox).not.toHaveBeenCalled();
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
      // Second call (result summary) uses the default mocked response.
      mockSuccessfulInstall();
      spawnSync.mockImplementation((which, args) => ({
        status: (args[0] === TOOLS[0].command || args[0] === 'python3') ? 0 : 1
      }));

      await hookInstaller.checkAndPrompt('tok');

      expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
        detail: expect.stringContaining(TOOLS[0].name)
      }));
      expect(spawn).toHaveBeenCalledWith(
        'python3',
        ['-', TOOLS[0].flag, '--yes'],
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
