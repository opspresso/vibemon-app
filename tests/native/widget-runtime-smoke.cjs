// Exercise the real macOS ps/SIGTERM boundary with disposable workers. The
// fixtures have no Info.plist and are never registered with Launch Services.
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareWidgetRuntime } = require('../../src/widgets/runtime.cjs');

async function main() {
  assert.equal(process.platform, 'darwin');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibemon-widget-runtime-'));
  const workers = [];
  const fixture = path.join(root, 'worker');
  const executableIn = bundlePath => path.join(bundlePath, 'Contents/PlugIns/VibeMonWidgets.appex/Contents/MacOS/VibeMonWidgets');
  // Like an upgrade: a new file with a new inode replaces the executable.
  function install(bundlePath) {
    const executable = executableIn(bundlePath);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync(fixture, `${executable}.new`);
    fs.chmodSync(`${executable}.new`, 0o755);
    fs.renameSync(`${executable}.new`, executable);
  }
  async function worker(name) {
    const bundlePath = path.join(root, name);
    const executable = executableIn(bundlePath);
    install(bundlePath);
    const child = spawn(executable, [], { stdio: ['ignore', 'pipe', 'ignore'] });
    const done = once(child, 'exit');
    workers.push({ child, done });
    await once(child, 'spawn');
    const [ready] = await Promise.race([
      once(child.stdout, 'data'),
      done.then(() => { throw new Error('Fixture exited before it was ready'); })
    ]);
    assert.equal(ready.toString(), 'ready\n');
    return { bundlePath, child, done };
  }
  try {
    const source = path.join(root, 'worker.c');
    fs.writeFileSync(source, '#include <unistd.h>\nint main(void) { write(1, "ready\\n", 6); for (;;) pause(); }\n');
    execFileSync('xcrun', ['clang', source, '-o', fixture], { stdio: 'pipe' });
    const own = await worker('VibeMon test.app');
    const other = await worker('Other VibeMon.app');
    let registered = 0;
    await prepareWidgetRuntime({ bundlePath: own.bundlePath, registerApplication: () => registered++ });
    assert.equal(registered, 1);
    assert.equal(own.child.exitCode, null);
    assert.equal(own.child.signalCode, null);
    install(own.bundlePath);
    await prepareWidgetRuntime({ bundlePath: own.bundlePath, registerApplication: () => registered++ });
    assert.equal(registered, 2);
    assert.equal((await own.done)[1], 'SIGTERM');
    assert.equal(other.child.exitCode, null);
    assert.equal(other.child.signalCode, null);
    assert(process.kill(other.child.pid, 0));
    console.log('PASS: only a worker that runs a replaced executable restarts; the other App keeps its worker, including paths with spaces');
  } finally {
    for (const { child } of workers) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.allSettled(workers.map(({ done }) => done));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
