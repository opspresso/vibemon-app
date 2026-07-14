#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const electron = require('electron');
const appPath = path.join(__dirname, '..');

const child = spawn(electron, [appPath], {
  detached: true,
  stdio: 'ignore'
});

child.unref();

console.log('VibeMon started (http://127.0.0.1:19280)');
