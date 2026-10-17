#!/usr/bin/env node
// Validate the App-owned registry and character images before publication.

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'src/shared/data');
const CHARACTERS = join(ROOT, 'src/assets/characters');

// Values with an engine drawing branch (vibemon-engine.js drawEyeType/drawEffect).
const EYE_TYPES = new Set(['normal', 'glasses', 'blink', 'happy']);
const EFFECTS = new Set(['none', 'sparkle', 'thinking', 'question', 'zzz', 'exclamation']);
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const CANVAS = 128;
const { CHARACTER_IMAGE_SIZES } = JSON.parse(readFileSync(join(DATA, 'constants.json'), 'utf8'));
// Palette slots the 3D rig paints (DEFAULT_THEME in monster-states.js).
const THEME_KEYS = ['body', 'belly', 'accent', 'eye', 'blush', 'flame'];

const errors = [];
const check = (ok, message) => { if (!ok) errors.push(message); };

function loadJson(name) {
  try {
    return JSON.parse(readFileSync(join(DATA, name), 'utf8'));
  } catch (error) {
    errors.push(`data/${name}: ${error.message}`);
    return null;
  }
}

// --- states.json ---
const statesDoc = loadJson('states.json');
const states = statesDoc?.states;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
check(isRecord(states) && Object.keys(states).length > 0, 'states.json: states must be a non-empty object');
if (isRecord(states)) {
  for (const [name, state] of Object.entries(states)) {
    const at = `states.json ${name}`;
    check(HEX_COLOR.test(state?.color ?? ''), `${at}: color must be #RRGGBB, got ${state?.color}`);
    check(typeof state?.text === 'string' && state.text.length > 0, `${at}: text must be a non-empty string`);
    check(typeof state?.active === 'boolean', `${at}: active must be a boolean`);
    check(typeof state?.loading === 'boolean', `${at}: loading must be a boolean`);
    check(EYE_TYPES.has(state?.eyeType), `${at}: eyeType "${state?.eyeType}" has no engine drawing branch`);
    check(EFFECTS.has(state?.effect), `${at}: effect "${state?.effect}" has no engine drawing branch`);
  }
}

// --- characters.json ---
const charsDoc = loadJson('characters.json');
check(Number.isSafeInteger(charsDoc?.revision) && charsDoc.revision >= 0, 'characters.json revision must be a non-negative integer');
const characters = charsDoc?.characters;
check(isRecord(characters) && Object.keys(characters).length > 0, 'characters.json: characters must be a non-empty object');
if (charsDoc) {
  check(typeof charsDoc.default === 'string' && isRecord(characters) && Object.hasOwn(characters, charsDoc.default),
    `characters.json: default "${charsDoc.default}" must name a defined character`);
}
const anchorInRange = (value) => Number.isFinite(value) && value >= 0 && value <= CANVAS;
if (isRecord(characters)) {
  for (const [name, ch] of Object.entries(characters)) {
    const at = `characters.json ${name}`;
    check(/^[a-z0-9-]+$/.test(name), `${at}: name must be lowercase alphanumeric`);
    check(typeof ch?.displayName === 'string' && ch.displayName.length > 0, `${at}: displayName required`);
    check(HEX_COLOR.test(ch?.color ?? ''), `${at}: color must be #RRGGBB, got ${ch?.color}`);
    for (const key of ['eyeColor', 'glassesColor']) {
      if (ch?.[key] !== undefined) check(HEX_COLOR.test(ch[key]), `${at}: ${key} must be #RRGGBB, got ${ch[key]}`);
    }
    check(typeof ch?.image === 'string' && /^[a-z0-9-]+\.png$/.test(ch?.image ?? ''),
      `${at}: image must be a simple .png filename, got ${ch?.image}`);
    const eyes = ch?.eyes;
    check(!!eyes && anchorInRange(eyes?.left?.x) && anchorInRange(eyes?.left?.y)
      && anchorInRange(eyes?.right?.x) && anchorInRange(eyes?.right?.y),
      `${at}: eyes.left/right anchors must be within 0..${CANVAS}`);
    // Eye size comes as w/h or the square shorthand `size`.
    check(!!eyes && (anchorInRange(eyes?.size) || (anchorInRange(eyes?.w) && anchorInRange(eyes?.h))),
      `${at}: eyes needs w/h (or size) within 0..${CANVAS}`);
    check(anchorInRange(ch?.effect?.x) && anchorInRange(ch?.effect?.y),
      `${at}: effect anchor must be within 0..${CANVAS}`);
    // 3D palette: required so a character added here renders in the 3D
    // engine without a code change in the consuming app.
    const theme = ch?.theme;
    check(!!theme && typeof theme === 'object', `${at}: theme required (3D palette)`);
    if (theme && typeof theme === 'object') {
      for (const key of THEME_KEYS) {
        check(HEX_COLOR.test(theme[key] ?? ''), `${at}: theme.${key} must be #RRGGBB, got ${theme[key]}`);
      }
      for (const key of Object.keys(theme)) {
        check(THEME_KEYS.includes(key), `${at}: theme has unknown key "${key}"`);
      }
    }
  }

  // Image files and registry entries must match 1:1.
  const pngs = new Set(readdirSync(CHARACTERS).filter((f) => f.endsWith('.png')));
  for (const [name, ch] of Object.entries(characters)) {
    if (typeof ch?.image === 'string') {
      check(pngs.has(ch.image), `characters.json ${name}: image ${ch.image} not found in src/assets/characters/`);
      if (pngs.has(ch.image)) {
        const png = readFileSync(join(CHARACTERS, ch.image));
        check(png.length >= 24 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && CHARACTER_IMAGE_SIZES.includes(png.readUInt32BE(16)) && png.readUInt32BE(20) === png.readUInt32BE(16),
          `characters.json ${name}: image must be a square PNG of ${CHARACTER_IMAGE_SIZES.join(', ')} px`);
      }
      pngs.delete(ch.image);
    }
  }
  for (const orphan of pngs) errors.push(`src/assets/characters/${orphan}: no characters.json entry references it`);
}

if (errors.length > 0) {
  for (const message of errors) console.error(`FAIL  ${message}`);
  process.exit(1);
}
console.log('Registry is valid: states, characters, and images all check out.');
