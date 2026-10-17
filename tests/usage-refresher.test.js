/**
 * Tests for usage-refresher.cjs
 */

const { EventEmitter } = require('events');
const os = require('os');
const path = require('path');

jest.mock('fs');
jest.mock('child_process');
jest.mock('../src/shared/config.cjs', () => ({
  USAGE_REFRESH_MAX_AGE_SECONDS: 90,
  USAGE_REFRESH_TIMEOUT_MS: 60000
}));

const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { setImmediate } = require('node:timers');
const flush = () => new Promise(setImmediate);
const { UsageRefresher, USAGE_SCRIPT_PATH } = require('../src/modules/usage-refresher.cjs');

// findPython() probes candidates by running `-c 'print(sys.version_info[0])'`,
// so a usable interpreter has to answer with its major version.
function mockPythonPresent() {
  execFile.mockImplementation((_command, _args, _options, callback) => callback(null, '3\n'));
}

// Returns a fake child whose exit is controlled by the test via close(code).
function mockSpawnedChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  spawn.mockReturnValue(child);
  return child;
}

describe('UsageRefresher', () => {
  let refresher;

  beforeEach(() => {
    fs.existsSync.mockReset().mockReturnValue(true);
    fs.readFileSync.mockReset();
    fs.statSync.mockReset();
    spawn.mockReset();
    execFile.mockReset();
    mockPythonPresent();
    refresher = new UsageRefresher();
  });

  test('resolves USAGE_SCRIPT_PATH to ~/.vibemon/usage.py', () => {
    expect(USAGE_SCRIPT_PATH).toBe(path.join(os.homedir(), '.vibemon', 'usage.py'));
  });

  test('skips without spawning when usage.py is not installed', async () => {
    fs.existsSync.mockReturnValue(false);

    const result = await refresher.refresh();

    expect(result).toEqual({ ok: false, reason: 'not-installed' });
    expect(spawn).not.toHaveBeenCalled();
  });

  test('spawns python with the script path and --max-age flag', async () => {
    const child = mockSpawnedChild();

    const promise = refresher.refresh();
    await flush();
    child.emit('close', 0);
    const result = await promise;

    expect(result).toMatchObject({ ok: true, code: 0 });
    const [command, args] = spawn.mock.calls[0];
    expect(command).toBe(process.platform === 'win32' ? 'py' : 'python3');
    expect(args.slice(-4)).toEqual([USAGE_SCRIPT_PATH, '--all-profiles', '--max-age', '90']);
  });

  test('delegates active account selection to Python without reading credentials', async () => {
    fs.statSync.mockReturnValue({ mtimeMs: 200000 });
    fs.readFileSync.mockReturnValue(JSON.stringify({ codex: { updated_at: 100 } }));
    const child = mockSpawnedChild();

    const promise = refresher.refresh();
    await flush();
    child.emit('close', 0);
    await promise;

    const args = spawn.mock.calls[0][1];
    expect(args.slice(-4)).toEqual([USAGE_SCRIPT_PATH, '--all-profiles', '--max-age', '90']);
    expect(fs.statSync).not.toHaveBeenCalled();
  });

  test('passes the selected profile and cache paths to the account refresher', async () => {
    const previous = { ...process.env };
    try {
      process.env.CODEX_HOME = '~/codex-work';
      process.env.VIBEMON_ACCOUNT_ID = 'work';
      delete process.env.VIBEMON_CODEX_ACCOUNT_ID;
      process.env.VIBEMON_CACHE_PATH = '~/cache-work/projects.json';
      fs.statSync.mockReturnValue({ mtimeMs: 200000 });
      fs.readFileSync.mockReturnValue(JSON.stringify({ 'codex:work': { updated_at: 100 } }));
      const child = mockSpawnedChild();
      const pending = refresher.refresh();
      await flush();
      child.emit('close', 0);
      await pending;
      expect(fs.statSync).not.toHaveBeenCalled();
      expect(spawn.mock.calls[0][1].slice(-1)).toEqual(['90']);
      expect(spawn.mock.calls[0][2].env.CODEX_HOME).toBe(path.join(os.homedir(), 'codex-work'));
      expect(spawn.mock.calls[0][2].env.VIBEMON_CACHE_PATH).toBe(path.join(os.homedir(), 'cache-work', 'projects.json'));
    } finally { process.env = previous; }
  });

  test('skips without spawning when no working Python 3 is found', async () => {
    execFile.mockImplementation((_command, _args, _options, callback) => callback(new Error('unavailable'), ''));

    const result = await refresher.refresh();

    expect(result).toEqual({ ok: false, reason: 'python-not-found' });
    expect(spawn).not.toHaveBeenCalled();
  });

  test('hides the console window Windows would otherwise pop for every refresh', async () => {
    const child = mockSpawnedChild();

    const promise = refresher.refresh();
    await flush();
    child.emit('close', 0);
    await promise;

    expect(spawn.mock.calls[0][2].windowsHide).toBe(true);
  });

  test('extends PATH with the common claude CLI install locations', async () => {
    const child = mockSpawnedChild();

    const promise = refresher.refresh();
    await flush();
    child.emit('close', 0);
    await promise;

    const options = spawn.mock.calls[0][2];
    const pathDirs = options.env.PATH.split(path.delimiter);
    expect(pathDirs).toContain(path.join(os.homedir(), '.local', 'bin'));
    expect(pathDirs).toContain(path.join(os.homedir(), '.claude', 'local'));
    expect(pathDirs).toContain('/opt/homebrew/bin');
    expect(pathDirs).toContain('/usr/local/bin');
  });

  test('sets VIBEMON_SUPPRESS_HOOKS so the spawned claude session stays silent', async () => {
    const child = mockSpawnedChild();

    const promise = refresher.refresh();
    await flush();
    child.emit('close', 0);
    await promise;

    const options = spawn.mock.calls[0][2];
    expect(options.env.VIBEMON_SUPPRESS_HOOKS).toBe('1');
  });

  test('does not spawn a second refresh while one is in flight', async () => {
    const child = mockSpawnedChild();

    const first = refresher.refresh();
    await flush();
    const second = await refresher.refresh();

    expect(second).toEqual({ ok: false, reason: 'in-flight' });
    expect(spawn).toHaveBeenCalledTimes(1);

    child.emit('close', 0);
    await first;
  });

  test('a pending interpreter probe also prevents overlapping refreshes', async () => {
    let completeProbe;
    execFile.mockImplementation((_command, _args, _options, callback) => { completeProbe = callback; });
    const child = mockSpawnedChild();
    const first = refresher.refresh();
    expect(await refresher.refresh()).toEqual({ ok: false, reason: 'in-flight' });
    expect(spawn).not.toHaveBeenCalled();
    completeProbe(null, '3\n');
    await flush();
    child.emit('close', 0);
    expect(await first).toMatchObject({ ok: true });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('allows a new refresh after the previous one finishes', async () => {
    const child = mockSpawnedChild();
    const first = refresher.refresh();
    await flush();
    child.emit('close', 1);
    const firstResult = await first;
    expect(firstResult).toMatchObject({ ok: false, reason: 'exit-code', code: 1 });

    const nextChild = mockSpawnedChild();
    const second = refresher.refresh();
    await flush();
    nextChild.emit('close', 0);
    const secondResult = await second;

    expect(secondResult).toMatchObject({ ok: true });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  test('resolves with spawn-error when the process cannot start', async () => {
    const child = mockSpawnedChild();

    const promise = refresher.refresh();
    await flush();
    child.emit('error', new Error('ENOENT'));
    const result = await promise;

    expect(result).toEqual({ ok: false, reason: 'spawn-error' });
  });

  test('terminates a stalled refresh and allows the next scheduled run', async () => {
    jest.useFakeTimers();
    try {
      const child = mockSpawnedChild();
      const first = refresher.refresh();
      await flush();
      jest.advanceTimersByTime(60000);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(await first).toMatchObject({ ok: false, reason: 'timeout' });
      const next = mockSpawnedChild();
      const second = refresher.refresh();
      await flush();
      child.emit('close', 1);
      expect(await refresher.refresh()).toEqual({ ok: false, reason: 'in-flight' });
      next.emit('close', 0);
      expect(await second).toMatchObject({ ok: true });
    } finally { jest.useRealTimers(); }
  });

  test('does not capture or log provider diagnostics', async () => {
    const child = mockSpawnedChild();
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pending = refresher.refresh();
      await flush();
      child.stderr.emit('data', 'private-provider-response');
      child.emit('close', 1);
      const result = await pending;
      expect(result).not.toHaveProperty('stderr');
      expect(spawn.mock.calls[0][2].stdio).toEqual(['ignore', 'ignore', 'ignore']);
      expect(JSON.stringify(warning.mock.calls)).not.toContain('private-provider-response');
    } finally { warning.mockRestore(); }
  });
});
