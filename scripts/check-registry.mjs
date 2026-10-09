#!/usr/bin/env node
/**
 * Verifies that the bundled registry fallbacks (src/shared/data/*.json and
 * src/assets/characters/*.png) and the vendored rendering modules
 * (src/engine/, src/bubble/) match the canonical copies in the
 * vibemon-web repository.
 *
 * By default files are fetched from the pinned Web commit. Set
 * VIBEMON_WEB_DIR to a local vibemon-web checkout to compare offline.
 * Pass --fix to overwrite the bundled copies with the canonical ones.
 *
 *   node scripts/check-registry.mjs
 *   VIBEMON_WEB_DIR=../vibemon-web node scripts/check-registry.mjs --fix
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const revision = JSON.parse(await readFile(new URL('../web-assets.json', import.meta.url), 'utf8')).revision;
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('web-assets.json requires a pinned commit SHA');
const CANONICAL_BASE_URL =
  `https://api.github.com/repos/opspresso/vibemon-web/contents/public/static`;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'src', 'shared', 'data');
const ASSETS_DIR = path.join(ROOT, 'src', 'assets', 'characters');
const ENGINE_DIR = path.join(ROOT, 'src', 'engine');
const BUBBLE_DIR = path.join(ROOT, 'src', 'bubble');

const FIX = process.argv.includes('--fix');

async function loadCanonical(relPath) {
  const staticDir = process.env.VIBEMON_WEB_DIR;
  if (staticDir) {
    return execFileSync('git', ['-C', staticDir, 'show', `${revision}:public/static/${relPath}`]);
  }
  const token = process.env.VIBEMON_WEB_READ_TOKEN;
  if (!token) throw new Error('Set VIBEMON_WEB_DIR for an offline pinned checkout, or VIBEMON_WEB_READ_TOKEN with read-only contents access to private opspresso/vibemon-web');
  const res = await fetch(`${CANONICAL_BASE_URL}/${relPath}?ref=${revision}`, {
    headers: { Accept: 'application/vnd.github.raw+json', Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(15000)
  });
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

  console.error(`DRIFT ${relPath} (bundled copy differs from vibemon-web)`);
  return false;
}

const canonicalCharacters = JSON.parse((await loadCanonical('data/characters.json')).toString());
const imageFiles = Object.values(canonicalCharacters.characters).map((c) => c.image);

const checks = [
  compare('js/resource-schema.cjs', path.join(ROOT, 'src', 'shared', 'resource-schema.cjs'), false),
  compare('data/states.json', path.join(DATA_DIR, 'states.json'), true),
  compare('data/characters.json', path.join(DATA_DIR, 'characters.json'), true),
  compare('js/vibemon-engine.js', path.join(ENGINE_DIR, 'vibemon-engine.js'), false),
  compare('js/vibemon-engine-3d.js', path.join(ENGINE_DIR, 'vibemon-engine-3d.js'), false),
  compare('js/monster-states.js', path.join(ENGINE_DIR, 'monster-states.js'), false),
  compare('js/vibemon-bubble.js', path.join(BUBBLE_DIR, 'vibemon-bubble.js'), false),
  compare('css/vibemon-bubble.css', path.join(BUBBLE_DIR, 'vibemon-bubble.css'), false),
  ...imageFiles.map((img) => compare(`characters/${img}`, path.join(ASSETS_DIR, img), false)),
];

const results = await Promise.all(checks);
if (results.includes(false)) {
  console.error('\nRe-sync with: node scripts/check-registry.mjs --fix');
  process.exit(1);
}
console.log('Bundled registry fallbacks are in sync with vibemon-web.');
