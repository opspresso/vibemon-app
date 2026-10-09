/**
 * Tests for python-runtime.cjs
 */

jest.mock('child_process');

const { spawnSync } = require('child_process');

const PROBE_OK = { status: 0, stdout: '3\n' };

/**
 * Load the module fresh for a given platform. CANDIDATES is built at load
 * time, so the Windows ordering can't be observed without re-requiring.
 * @param {string} platform - process.platform value to pretend to be
 * @returns {object} the module exports
 */
function loadFor(platform) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  let loaded;
  jest.isolateModules(() => {
    loaded = require('../src/modules/python-runtime.cjs');
  });
  Object.defineProperty(process, 'platform', original);
  return loaded;
}

beforeEach(() => {
  spawnSync.mockReset();
});

describe('findPython', () => {
  test('returns the first candidate that runs code', () => {
    const { findPython } = loadFor('darwin');
    spawnSync.mockReturnValue(PROBE_OK);

    expect(findPython()).toEqual({ command: 'python3', prefixArgs: [] });
  });

  test('probes by executing code, not by a path lookup', () => {
    const { findPython } = loadFor('darwin');
    spawnSync.mockReturnValue(PROBE_OK);

    findPython();

    const [command, args] = spawnSync.mock.calls[0];
    expect(command).toBe('python3');
    expect(args[0]).toBe('-c');
    expect(args[1]).toContain('sys.version_info');
  });

  test('prefers the py launcher on Windows', () => {
    const { findPython } = loadFor('win32');
    spawnSync.mockReturnValue(PROBE_OK);

    expect(findPython()).toEqual({ command: 'py', prefixArgs: ['-3'] });
    expect(spawnSync.mock.calls[0][1]).toEqual([
      '-3', '-c', expect.stringContaining('sys.version_info')
    ]);
  });

  test('rejects a Microsoft Store alias stub and falls through to a real interpreter', () => {
    // The stub is a genuine python.exe on PATH: `where python` finds it, but
    // running it opens the Store and executes nothing.
    const { findPython } = loadFor('win32');
    spawnSync.mockImplementation((command) =>
      command === 'python3' ? PROBE_OK : { status: 9009, stdout: '' }
    );

    expect(findPython()).toEqual({ command: 'python3', prefixArgs: [] });
  });

  test('rejects an exit-0 probe that printed nothing', () => {
    const { findPython } = loadFor('win32');
    spawnSync.mockReturnValue({ status: 0, stdout: '' });

    expect(findPython()).toBeNull();
  });

  test('rejects a Python 2 interpreter', () => {
    const { findPython } = loadFor('darwin');
    spawnSync.mockReturnValue({ status: 0, stdout: '2\n' });

    expect(findPython()).toBeNull();
  });

  test('returns null when no candidate works', () => {
    const { findPython } = loadFor('darwin');
    spawnSync.mockReturnValue({ status: 127 });

    expect(findPython()).toBeNull();
  });

  test('survives a spawn that throws', () => {
    const { findPython } = loadFor('darwin');
    spawnSync.mockImplementation(() => { throw new Error('EACCES'); });

    expect(findPython()).toBeNull();
  });

  test('hides the console window Windows would pop for every probe', () => {
    const { findPython } = loadFor('win32');
    spawnSync.mockReturnValue(PROBE_OK);

    findPython();

    expect(spawnSync.mock.calls[0][2].windowsHide).toBe(true);
  });

  test('is not cached, so installing Python mid-session takes effect', () => {
    const { findPython } = loadFor('darwin');
    spawnSync.mockReturnValue({ status: 127 });
    expect(findPython()).toBeNull();

    spawnSync.mockReturnValue(PROBE_OK);
    expect(findPython()).toEqual({ command: 'python3', prefixArgs: [] });
  });
});

test('terminates an interpreter that never responds', () => {
  const { probePython } = loadFor('darwin');
  spawnSync.mockImplementation(jest.requireActual('child_process').spawnSync);
  const started = Date.now();
  expect(probePython({ command: process.execPath, prefixArgs: ['-e', 'setInterval(() => {}, 1000)', '--'] })).toBe(false);
  expect(Date.now() - started).toBeLessThan(4000);
});
