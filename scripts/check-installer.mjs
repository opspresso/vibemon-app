#!/usr/bin/env node
/**
 * Verifies that the INSTALLER_SHA256 pinned in src/shared/config.cjs matches
 * the install.py actually served from docs.vibemon.io. A stale pin makes
 * every hook (re)install fail with integrity-check-failed.
 *
 * By default install.py is fetched from https://docs.vibemon.io. Set
 * VIBEMON_DOCS_DIR to a local vibemon-docs checkout to compare offline.
 * Pass --fix to rewrite the pinned hash in config.cjs.
 *
 *   node scripts/check-installer.mjs
 *   VIBEMON_DOCS_DIR=../vibemon-docs node scripts/check-installer.mjs --fix
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DOCS_BASE_URL = 'https://docs.vibemon.io';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'src', 'shared', 'config.cjs');
const PIN_PATTERN = /(VIBEMON_INSTALLER_SHA256 \|\| ')([0-9a-f]{64})(')/;

const FIX = process.argv.includes('--fix');

async function loadInstaller() {
  const docsDir = process.env.VIBEMON_DOCS_DIR;
  if (docsDir) {
    return readFile(path.join(docsDir, 'docs', 'install.py'));
  }
  const res = await fetch(`${DOCS_BASE_URL}/install.py`);
  if (!res.ok) {
    throw new Error(`Failed to fetch install.py: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

const deployedHash = createHash('sha256').update(await loadInstaller()).digest('hex');

const config = await readFile(CONFIG_PATH, 'utf8');
const match = config.match(PIN_PATTERN);
if (!match) {
  console.error(`INSTALLER_SHA256 pin not found in ${CONFIG_PATH}`);
  process.exit(1);
}
const pinnedHash = match[2];

if (pinnedHash === deployedHash) {
  console.log(`OK    INSTALLER_SHA256 (${deployedHash})`);
  process.exit(0);
}

if (FIX) {
  await writeFile(CONFIG_PATH, config.replace(PIN_PATTERN, `$1${deployedHash}$3`));
  console.log(`FIXED INSTALLER_SHA256 (${pinnedHash} -> ${deployedHash})`);
  process.exit(0);
}

console.error(`DRIFT INSTALLER_SHA256 (pinned ${pinnedHash}, deployed ${deployedHash})`);
console.error('\nRe-sync with: node scripts/check-installer.mjs --fix');
process.exit(1);
