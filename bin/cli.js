#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(require('../package.json').version);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: vibemon\n\nLaunches the VibeMon desktop app in the background.');
  process.exit(0);
}

const electron = require('electron');
const appPath = path.join(__dirname, '..');

const child = spawn(electron, [appPath], {
  detached: true,
  stdio: 'ignore'
});

// Fire-and-forget by design (detached + unref), but a synchronous launch
// failure (e.g. the electron binary is missing) still emits 'error' on the
// next tick — wait for that before claiming success instead of printing it
// unconditionally.
child.on('error', (err) => {
  console.error('VibeMon failed to start:', err.message);
  process.exitCode = 1;
});

child.unref();

process.nextTick(() => {
  if (process.exitCode !== 1) {
    console.log('VibeMon started (http://127.0.0.1:19280)');
  }
});
