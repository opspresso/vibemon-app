const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const path = require('node:path').posix;
const { WIDGET_RESTART_TIMEOUT_MS, WIDGET_RESTART_POLL_MS, WIDGET_PROCESS_TABLE_MAX_BYTES } = require('../shared/constants.cjs');

const execute = args => execFileSync('/bin/ps', args, { encoding: 'utf8', timeout: WIDGET_RESTART_TIMEOUT_MS, maxBuffer: WIDGET_PROCESS_TABLE_MAX_BYTES });

/** `comm` contains the executable path, not command arguments or credentials. */
function processPath(pid) {
  try {
    return execute(['-ww', '-p', String(pid), '-o', 'comm=']).trim() || null;
  } catch (error) {
    // ps exits with status 1 and no output when the process has already exited.
    if (error.status === 1 && !String(error.stdout || '').trim() && !String(error.stderr || '').trim()) return null;
    throw error;
  }
}

/**
 * An extension can outlive an App upgrade. Its cached bundle version then
 * fails chronod's archive validation even though timeline generation succeeds.
 * Restart only this App bundle's extension before requesting new timelines.
 */
async function prepareWidgetRuntime({
  bundlePath, registerApplication,
  readProcesses = () => execute(['-axww', '-o', 'pid=,comm=']),
  readPath = processPath,
  terminate = pid => process.kill(pid, 'SIGTERM'),
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => performance.now()
}) {
  registerApplication();
  const executable = path.join(bundlePath, 'Contents/PlugIns/VibeMonWidgets.appex/Contents/MacOS/VibeMonWidgets');
  const matches = readProcesses().split('\n').flatMap(line => {
    const match = /^\s*([1-9]\d*)\s+(.+?)\s*$/.exec(line);
    return match && match[2] === executable ? [Number(match[1])] : [];
  });
  for (const pid of matches) {
    // Recheck identity in case a process exited and its PID was reused.
    if (readPath(pid) !== executable) continue;
    try { terminate(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    const deadline = now() + WIDGET_RESTART_TIMEOUT_MS;
    while (readPath(pid) === executable) {
      if (now() >= deadline) throw new Error('The previous VibeMon widget process did not stop');
      await delay(WIDGET_RESTART_POLL_MS);
    }
  }
}

module.exports = { prepareWidgetRuntime };
