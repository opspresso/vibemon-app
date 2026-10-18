const { execFile } = require('node:child_process');
const { stat } = require('node:fs/promises');
const { performance } = require('node:perf_hooks');
const { promisify } = require('node:util');
const path = require('node:path').posix;
const { WIDGET_RESTART_TIMEOUT_MS, WIDGET_RESTART_POLL_MS, WIDGET_PROCESS_TABLE_MAX_BYTES } = require('../shared/constants.cjs');

const execFileAsync = promisify(execFile);
const run = async (file, args) => (await execFileAsync(file, args, { encoding: 'utf8', timeout: WIDGET_RESTART_TIMEOUT_MS, maxBuffer: WIDGET_PROCESS_TABLE_MAX_BYTES })).stdout;

// ps and lsof exit with status 1 and no output when the process has already exited.
async function unlessExited(read) {
  try {
    return await read();
  } catch (error) {
    if (error.code === 1 && !String(error.stdout || '').trim() && !String(error.stderr || '').trim()) return null;
    throw error;
  }
}

/** `comm` contains the executable path, not command arguments or credentials. */
const processPath = pid => unlessExited(async () => (await run('/bin/ps', ['-ww', '-p', String(pid), '-o', 'comm='])).trim() || null);

/**
 * The inode of the executable that a process runs. lsof lists the main
 * executable as the first `txt` record, also after the file on disk was
 * replaced, because the process keeps the old file open.
 */
const processInode = pid => unlessExited(async () => {
  const line = (await run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-F', 'i'])).split('\n').find(entry => /^i\d+$/.test(entry));
  return line ? Number(line.slice(1)) : null;
});

/**
 * An extension can outlive an App upgrade. Its cached bundle version then
 * fails chronod's archive validation even though timeline generation succeeds.
 * Before the App requests new timelines, it stops this App bundle's extension
 * only when the extension runs another file than the executable installed now:
 * an upgrade writes a new file with a new inode, and the old worker keeps the
 * old inode open. Other workers keep running.
 */
async function prepareWidgetRuntime({
  bundlePath, registerApplication,
  readProcesses = () => run('/bin/ps', ['-axww', '-o', 'pid=,comm=']),
  readPath = processPath,
  readInode = processInode,
  installedInode = async file => (await stat(file)).ino,
  terminate = pid => process.kill(pid, 'SIGTERM'),
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => performance.now()
}) {
  registerApplication();
  const executable = path.join(bundlePath, 'Contents/PlugIns/VibeMonWidgets.appex/Contents/MacOS/VibeMonWidgets');
  const workers = (await readProcesses()).split('\n').flatMap(line => {
    const match = /^\s*([1-9]\d*)\s+(.+?)\s*$/.exec(line);
    return match && match[2] === executable ? [Number(match[1])] : [];
  });
  if (workers.length === 0) return;
  const installed = await installedInode(executable);
  for (const pid of workers) {
    const inode = await readInode(pid);
    // null: the worker has exited.
    if (inode === null || inode === installed) continue;
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
