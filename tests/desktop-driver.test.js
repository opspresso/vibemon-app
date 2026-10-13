const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

// Exercise CLI preconditions only: no app, browser, or display is launched.
test.each(['engine', 'ss', 'ss-raw', 'eval null', 'text', 'windows', 'page character', 'constructor'])('manual driver fails when %s cannot run', command => {
  const directory = mkdtempSync(join(tmpdir(), 'vibemon-driver-cli-'));
  try {
    const result = spawnSync(process.execPath, ['.claude/skills/run-desktop/driver.mjs', command], {
      env: { ...process.env, SCREENSHOT_DIR: directory, VIBEMON_TEST_USER_DATA: directory },
      encoding: 'utf8', timeout: 5000
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/ERROR|unknown:/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
