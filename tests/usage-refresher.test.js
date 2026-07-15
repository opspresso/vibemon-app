/**
 * Tests for usage-refresher.cjs
 */

const { EventEmitter } = require('events');
const os = require('os');
const path = require('path');

jest.mock('fs');
jest.mock('child_process');
jest.mock('../src/shared/config.cjs', () => ({
  USAGE_REFRESH_MAX_AGE_SECONDS: 540
}));

const fs = require('fs');
const { spawn } = require('child_process');
const { UsageRefresher, USAGE_SCRIPT_PATH } = require('../src/modules/usage-refresher.cjs');

// Returns a fake child whose exit is controlled by the test via close(code).
function mockSpawnedChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  spawn.mockReturnValue(child);
  return child;
}

describe('UsageRefresher', () => {
  let refresher;

  beforeEach(() => {
    fs.existsSync.mockReset().mockReturnValue(true);
    spawn.mockReset();
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
    child.emit('close', 0);
    const result = await promise;

    expect(result).toMatchObject({ ok: true, code: 0 });
    const [command, args] = spawn.mock.calls[0];
    expect(command).toBe(process.platform === 'win32' ? 'python' : 'python3');
    expect(args).toEqual([USAGE_SCRIPT_PATH, '--max-age', '540']);
  });

  test('extends PATH with the common claude CLI install locations', async () => {
    const child = mockSpawnedChild();

    const promise = refresher.refresh();
    child.emit('close', 0);
    await promise;

    const options = spawn.mock.calls[0][2];
    const pathDirs = options.env.PATH.split(path.delimiter);
    expect(pathDirs).toContain(path.join(os.homedir(), '.local', 'bin'));
    expect(pathDirs).toContain(path.join(os.homedir(), '.claude', 'local'));
    expect(pathDirs).toContain('/opt/homebrew/bin');
    expect(pathDirs).toContain('/usr/local/bin');
  });

  test('does not spawn a second refresh while one is in flight', async () => {
    const child = mockSpawnedChild();

    const first = refresher.refresh();
    const second = await refresher.refresh();

    expect(second).toEqual({ ok: false, reason: 'in-flight' });
    expect(spawn).toHaveBeenCalledTimes(1);

    child.emit('close', 0);
    await first;
  });

  test('allows a new refresh after the previous one finishes', async () => {
    const child = mockSpawnedChild();
    const first = refresher.refresh();
    child.emit('close', 1);
    const firstResult = await first;
    expect(firstResult).toMatchObject({ ok: false, reason: 'exit-code', code: 1 });

    const nextChild = mockSpawnedChild();
    const second = refresher.refresh();
    nextChild.emit('close', 0);
    const secondResult = await second;

    expect(secondResult).toMatchObject({ ok: true });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  test('resolves with spawn-error when the process cannot start', async () => {
    const child = mockSpawnedChild();

    const promise = refresher.refresh();
    child.emit('error', new Error('ENOENT'));
    const result = await promise;

    expect(result).toEqual({ ok: false, reason: 'spawn-error', error: 'ENOENT' });
  });

  test('captures stderr from a failed run', async () => {
    const child = mockSpawnedChild();

    const promise = refresher.refresh();
    child.stderr.emit('data', 'claude CLI not found in PATH');
    child.emit('close', 1);
    const result = await promise;

    expect(result.stderr).toBe('claude CLI not found in PATH');
  });
});
