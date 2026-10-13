/**
 * Tests for python-runtime.cjs
 */

jest.mock('child_process');

const { execFile } = require('child_process');
const { setImmediate } = require('node:timers');

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
  execFile.mockReset();
});

describe('findPython', () => {
  test('returns the first candidate that runs code', async () => {
    const { findPython } = loadFor('darwin');
    execFile.mockImplementation((_command, _args, _options, callback) => callback(null, PROBE_OK.stdout));

    expect(await findPython()).toEqual({ command: 'python3', prefixArgs: [] });
  });

  test('probes by executing code, not by a path lookup', async () => {
    const { findPython } = loadFor('darwin');
    execFile.mockImplementation((_command, _args, _options, callback) => callback(null, PROBE_OK.stdout));

    await findPython();

    const [command, args] = execFile.mock.calls[0];
    expect(command).toBe('python3');
    expect(args[0]).toBe('-c');
    expect(args[1]).toContain('sys.version_info');
  });

  test('prefers the py launcher on Windows', async () => {
    const { findPython } = loadFor('win32');
    execFile.mockImplementation((_command, _args, _options, callback) => callback(null, PROBE_OK.stdout));

    expect(await findPython()).toEqual({ command: 'py', prefixArgs: ['-3'] });
    expect(execFile.mock.calls[0][1]).toEqual([
      '-3', '-c', expect.stringContaining('sys.version_info')
    ]);
  });

  test('rejects a Microsoft Store alias stub and falls through to a real interpreter', async () => {
    // The stub is a genuine python.exe on PATH: `where python` finds it, but
    // running it opens the Store and executes nothing.
    const { findPython } = loadFor('win32');
    execFile.mockImplementation((command, _args, _options, callback) => callback(command === 'python3' ? null : new Error('alias'), command === 'python3' ? '3\n' : ''));

    expect(await findPython()).toEqual({ command: 'python3', prefixArgs: [] });
  });

  test('rejects an exit-0 probe that printed nothing', async () => {
    const { findPython } = loadFor('win32');
    execFile.mockImplementation((_command, _args, _options, callback) => callback(null, ''));

    expect(await findPython()).toBeNull();
  });

  test('rejects a Python 2 interpreter', async () => {
    const { findPython } = loadFor('darwin');
    execFile.mockImplementation((_command, _args, _options, callback) => callback(null, '2\n'));

    expect(await findPython()).toBeNull();
  });

  test('returns null when no candidate works', async () => {
    const { findPython } = loadFor('darwin');
    execFile.mockImplementation((_command, _args, _options, callback) => callback(new Error('unavailable'), ''));

    expect(await findPython()).toBeNull();
  });

  test('survives a spawn that throws', async () => {
    const { findPython } = loadFor('darwin');
    execFile.mockImplementation(() => { throw new Error('EACCES'); });

    expect(await findPython()).toBeNull();
  });

  test('hides the console window Windows would pop for every probe', async () => {
    const { findPython } = loadFor('win32');
    execFile.mockImplementation((_command, _args, _options, callback) => callback(null, PROBE_OK.stdout));

    await findPython();

    expect(execFile.mock.calls[0][2].windowsHide).toBe(true);
  });

  test('is not cached, so installing Python mid-session takes effect', async () => {
    const { findPython } = loadFor('darwin');
    execFile.mockImplementation((_command, _args, _options, callback) => callback(new Error('unavailable'), ''));
    expect(await findPython()).toBeNull();

    execFile.mockImplementation((_command, _args, _options, callback) => callback(null, PROBE_OK.stdout));
    expect(await findPython()).toEqual({ command: 'python3', prefixArgs: [] });
  });
});

test('terminates an interpreter that never responds', async () => {
  const { probePython } = loadFor('darwin');
  execFile.mockImplementation(jest.requireActual('child_process').execFile);
  const started = Date.now();
  expect(await probePython({ command: process.execPath, prefixArgs: ['-e', 'setInterval(() => {}, 1000)', '--'] })).toBe(false);
  expect(Date.now() - started).toBeLessThan(4000);
});


test('slow interpreter discovery leaves the main event loop responsive', async () => {
  const { probePython } = loadFor('darwin');
  execFile.mockImplementation(jest.requireActual('child_process').execFile);
  let settled = false;
  const pending = probePython({ command: process.execPath, prefixArgs: ['-e', 'setTimeout(() => process.stdout.write("3\\n"), 300)', '--'] }).then(value => { settled = true; return value; });
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  expect(await pending).toBe(true);
});
