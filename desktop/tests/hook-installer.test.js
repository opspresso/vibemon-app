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
jest.mock('../shared/config.cjs', () => ({
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
const { HookInstaller, TOOLS } = require('../modules/hook-installer.cjs');

describe('HookInstaller', () => {
  let hookInstaller;

  beforeEach(() => {
    fs.existsSync.mockReset().mockReturnValue(false);
    spawnSync.mockReset().mockReturnValue({ status: 1 });
    spawn.mockReset();
    https.get.mockReset();
    hookInstaller = new HookInstaller();
  });

  describe('getMissingTools', () => {
    test('excludes a tool that is not present', () => {
      // No command found, no home dir present
      expect(hookInstaller.getMissingTools()).toEqual([]);
    });

    test('includes a tool that is present (via command) and missing its hook file', () => {
      const target = TOOLS[0];
      spawnSync.mockImplementation((which, args) => ({ status: args[0] === target.command ? 0 : 1 }));

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
      spawnSync.mockImplementation((which, args) => ({ status: args[0] === target.command ? 0 : 1 }));
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

  describe('runInstaller', () => {
    test('resolves python-not-found without downloading or spawning when python3 is unavailable', async () => {
      spawnSync.mockReturnValue({ status: 1 });

      const result = await hookInstaller.runInstaller(['--claude'], null);

      expect(result).toEqual({ ok: false, reason: 'python-not-found' });
      expect(https.get).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });

    test('resolves network-error when the request fails', async () => {
      spawnSync.mockReturnValue({ status: 0 });
      const fakeReq = new EventEmitter();
      https.get.mockImplementation(() => fakeReq);

      const resultPromise = hookInstaller.runInstaller(['--claude'], null);
      fakeReq.emit('error', new Error('boom'));

      expect(await resultPromise).toEqual({ ok: false, reason: 'network-error', error: 'boom' });
    });

    test('downloads the script and spawns python3 with flags/token via stdin (no shell)', async () => {
      spawnSync.mockReturnValue({ status: 0 });

      const fakeRes = new EventEmitter();
      fakeRes.statusCode = 200;
      fakeRes.setEncoding = jest.fn();
      https.get.mockImplementation((url, opts, cb) => {
        expect(url).toBe('https://docs.example.test/install.py');
        cb(fakeRes);
        return new EventEmitter();
      });

      const fakeChild = new EventEmitter();
      fakeChild.stdin = { write: jest.fn(), end: jest.fn() };
      fakeChild.stdout = new EventEmitter();
      fakeChild.stderr = new EventEmitter();
      spawn.mockReturnValue(fakeChild);

      const resultPromise = hookInstaller.runInstaller(['--claude'], 'my_token123');

      fakeRes.emit('data', 'print("hello")');
      fakeRes.emit('end');
      fakeChild.emit('close', 0);

      const result = await resultPromise;

      expect(result.ok).toBe(true);
      expect(spawn).toHaveBeenCalledWith(
        'python3',
        ['-', '--claude', '--yes', '--token', 'my_token123'],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
      );
      expect(spawn.mock.calls[0][2].shell).toBeUndefined();
      expect(fakeChild.stdin.write).toHaveBeenCalledWith('print("hello")');
      expect(fakeChild.stdin.end).toHaveBeenCalled();
    });

    test('resolves ok:false with exit code when the installer script fails', async () => {
      spawnSync.mockReturnValue({ status: 0 });

      const fakeRes = new EventEmitter();
      fakeRes.statusCode = 200;
      fakeRes.setEncoding = jest.fn();
      https.get.mockImplementation((url, opts, cb) => {
        cb(fakeRes);
        return new EventEmitter();
      });

      const fakeChild = new EventEmitter();
      fakeChild.stdin = { write: jest.fn(), end: jest.fn() };
      fakeChild.stdout = new EventEmitter();
      fakeChild.stderr = new EventEmitter();
      spawn.mockReturnValue(fakeChild);

      const resultPromise = hookInstaller.runInstaller(['--codex'], null);

      fakeRes.emit('data', 'script');
      fakeRes.emit('end');
      fakeChild.stderr.emit('data', 'traceback');
      fakeChild.emit('close', 1);

      expect(await resultPromise).toEqual({ ok: false, reason: 'exit-code', code: 1, stderr: 'traceback' });
    });
  });
});
