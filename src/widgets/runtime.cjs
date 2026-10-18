const { execFile } = require('node:child_process');
const { stat } = require('node:fs/promises');
const { performance } = require('node:perf_hooks');
const { promisify } = require('node:util');
const path = require('node:path').posix;
const { WIDGET_RESTART_TIMEOUT_MS, WIDGET_RESTART_POLL_MS, WIDGET_PROCESS_TABLE_MAX_BYTES } = require('../shared/constants.cjs');

const execFileAsync = promisify(execFile);
const ps = async args => (await execFileAsync('/bin/ps', args, { encoding: 'utf8', timeout: WIDGET_RESTART_TIMEOUT_MS, maxBuffer: WIDGET_PROCESS_TABLE_MAX_BYTES })).stdout;
// `ps` reports the elapsed time in whole seconds.
const ELAPSED_RESOLUTION_MS = 1000;

/** `comm` contains the executable path, not command arguments or credentials. */
async function processPath(pid) {
  try {
    return (await ps(['-ww', '-p', String(pid), '-o', 'comm='])).trim() || null;
  } catch (error) {
    // ps exits with status 1 and no output when the process has already exited.
    if (error.code === 1 && !String(error.stdout || '').trim() && !String(error.stderr || '').trim()) return null;
    throw error;
  }
}

/** `ps` elapsed time, `[[dd-]hh:]mm:ss`, in milliseconds; null when malformed. */
function elapsedMs(text) {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text);
  if (!match) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map(value => Number(value || 0));
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/**
 * An extension can outlive an App upgrade. Its cached bundle version then
 * fails chronod's archive validation even though timeline generation succeeds.
 * Before the App requests new timelines, it stops this App bundle's extension
 * only when the extension started before its executable was installed: an
 * upgrade writes a new file, which sets a later change time (ctime), and
 * archive tools cannot preserve ctime. Other workers keep running.
 */
async function prepareWidgetRuntime({
  bundlePath, registerApplication,
  readProcesses = () => ps(['-axww', '-o', 'pid=,etime=,comm=']),
  readPath = processPath,
  installedAt = async file => (await stat(file)).ctimeMs,
  terminate = pid => process.kill(pid, 'SIGTERM'),
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  wallNow = Date.now,
  now = () => performance.now()
}) {
  registerApplication();
  const executable = path.join(bundlePath, 'Contents/PlugIns/VibeMonWidgets.appex/Contents/MacOS/VibeMonWidgets');
  const workers = (await readProcesses()).split('\n').flatMap(line => {
    const match = /^\s*([1-9]\d*)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    return match && match[3] === executable ? [{ pid: Number(match[1]), elapsed: elapsedMs(match[2]) }] : [];
  });
  if (workers.length === 0) return;
  const installed = await installedAt(executable);
  const listedAt = wallNow();
  for (const { pid, elapsed } of workers) {
    // A worker that started within the resolution window of the install may run either version.
    if (elapsed !== null && listedAt - elapsed >= installed + ELAPSED_RESOLUTION_MS) continue;
    // Recheck identity in case a process exited and its PID was reused.
    if (await readPath(pid) !== executable) continue;
    try { terminate(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    const deadline = now() + WIDGET_RESTART_TIMEOUT_MS;
    while (await readPath(pid) === executable) {
      if (now() >= deadline) throw new Error('The previous VibeMon widget process did not stop');
      await delay(WIDGET_RESTART_POLL_MS);
    }
  }
}

module.exports = { prepareWidgetRuntime };
