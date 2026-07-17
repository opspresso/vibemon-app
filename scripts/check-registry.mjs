#!/usr/bin/env node
/**
 * Verifies that the bundled registry fallbacks (src/shared/data/*.json and
 * src/assets/characters/*.png) match the canonical registry in the
 * vibemon-static repository.
 *
 * By default the canonical files are fetched from GitHub (main branch). Set
 * VIBEMON_STATIC_DIR to a local vibemon-static checkout to compare offline.
 * Pass --fix to overwrite the bundled copies with the canonical ones.
 *
 *   node scripts/check-registry.mjs
 *   VIBEMON_STATIC_DIR=../vibemon-static node scripts/check-registry.mjs --fix
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CANONICAL_BASE_URL =
  'https://raw.githubusercontent.com/opspresso/vibemon-static/main/docs';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'src', 'shared', 'data');
const ASSETS_DIR = path.join(ROOT, 'src', 'assets', 'characters');

const FIX = process.argv.includes('--fix');

async function loadCanonical(relPath) {
  const staticDir = process.env.VIBEMON_STATIC_DIR;
  if (staticDir) {
    return readFile(path.join(staticDir, 'docs', relPath));
  }
  const res = await fetch(`${CANONICAL_BASE_URL}/${relPath}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch canonical ${relPath}: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function compare(relPath, localPath, isJson) {
  const canonical = await loadCanonical(relPath);
  let local = null;
  try {
    local = await readFile(localPath);
  } catch {
    // missing locally
  }

  const same = local !== null && (isJson
    ? JSON.stringify(JSON.parse(canonical.toString())) === JSON.stringify(JSON.parse(local.toString()))
    : sha256(canonical) === sha256(local));

  if (same) {
    console.log(`OK    ${relPath}`);
    return true;
  }

  if (FIX) {
    await writeFile(localPath, canonical);
    console.log(`FIXED ${relPath}`);
    return true;
  }

  console.error(`DRIFT ${relPath} (bundled copy differs from vibemon-static)`);
  return false;
}

const canonicalCharacters = JSON.parse((await loadCanonical('data/characters.json')).toString());
const imageFiles = Object.values(canonicalCharacters.characters).map((c) => c.image);

const checks = [
  compare('data/states.json', path.join(DATA_DIR, 'states.json'), true),
  compare('data/characters.json', path.join(DATA_DIR, 'characters.json'), true),
  ...imageFiles.map((img) => compare(`characters/${img}`, path.join(ASSETS_DIR, img), false)),
];

const results = await Promise.all(checks);
if (results.includes(false)) {
  console.error('\nRe-sync with: node scripts/check-registry.mjs --fix');
  process.exit(1);
}
console.log('Bundled registry fallbacks are in sync with vibemon-static.');
