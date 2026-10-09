/**
 * Python interpreter discovery for the modules that shell out to the
 * vibemon.io/install scripts (install.py, ~/.vibemon/usage.py).
 *
 * Windows makes both halves of this non-obvious: the interpreter is not named
 * `python3`, and the name that does exist may not be an interpreter at all.
 */

const { spawnSync } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';

/**
 * Spawn options every child here shares.
 *
 * windowsHide matters because Electron is a GUI process with no console of its
 * own: Windows allocates a visible console window for each console child
 * unless this is set. These spawns run on timers (tool detection every 30
 * minutes, usage refresh every 2), so without it a black window flashes at
 * the user indefinitely. Node's default is false.
 */
const SPAWN_DEFAULTS = { windowsHide: true };

/**
 * Interpreters to try, best first.
 *
 * `py -3` leads on Windows: the python.org launcher installs to a fixed
 * location and keeps resolving after an interpreter upgrade moves python.exe.
 * The bare `python` / `python3` names come last there because Windows ships
 * app-execution alias stubs under exactly those names.
 */
const CANDIDATES = IS_WINDOWS
  ? [
    { command: 'py', prefixArgs: ['-3'] },
    { command: 'python', prefixArgs: [] },
    { command: 'python3', prefixArgs: [] }
  ]
  : [
    { command: 'python3', prefixArgs: [] },
    { command: 'python', prefixArgs: [] }
  ];

// Probed by executing real code rather than by asking `where`/`python --version`.
// A Microsoft Store alias stub *is* a python.exe on PATH (%LOCALAPPDATA%\
// Microsoft\WindowsApps is on the default PATH), so a path lookup succeeds for
// something that opens the Store instead of running anything. Printing the
// major version is the cheapest thing only a real interpreter can do.
const PROBE_ARGS = ['-c', 'import sys; print(sys.version_info[0])'];

/**
 * Whether a candidate is a working Python 3.
 * @param {{command: string, prefixArgs: string[]}} candidate
 * @returns {boolean}
 */
function probePython(candidate) {
  let result;
  try {
    result = spawnSync(candidate.command, [...candidate.prefixArgs, ...PROBE_ARGS], {
      ...SPAWN_DEFAULTS,
      encoding: 'utf8'
    });
  } catch {
    return false;
  }
  return Boolean(result) && result.status === 0 && String(result.stdout || '').trim() === '3';
}

/**
 * First working Python 3 interpreter, or null when none is usable.
 *
 * Deliberately uncached: resolution costs one spawn on the happy path, and a
 * cached "not found" would stick for the rest of the session even after the
 * user installs Python and retries.
 * @returns {{command: string, prefixArgs: string[]}|null}
 */
function findPython() {
  return CANDIDATES.find(probePython) || null;
}

module.exports = { findPython, probePython, CANDIDATES, SPAWN_DEFAULTS, IS_WINDOWS };
