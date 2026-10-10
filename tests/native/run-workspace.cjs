// Delete disposable Chromium data only after Electron has released its files.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibemon-workspace-'));
const preview = process.argv.includes('--preview');
const child = spawn(require('electron'), [path.join(__dirname, preview ? 'workspace-preview.cjs' : 'workspace-smoke.cjs')], {
  stdio: 'inherit',
  env: { ...process.env, VIBEMON_TEST_USER_DATA: directory }
});
child.once('error', error => { console.error(error.message); });
child.once('close', (code, signal) => {
  try { fs.rmSync(directory, { recursive: true, force: true }); }
  catch (error) { console.error(`Unable to remove disposable workspace data: ${error.message}`); process.exitCode = 1; return; }
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { child.kill(signal); });
