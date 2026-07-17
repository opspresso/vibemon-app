/**
 * Registry cache (CommonJS)
 *
 * Canonical state/character registries live in the vibemon-static repository
 * and are served from STATIC_BASE_URL (static.vibemon.io). This module
 * resolves the registries synchronously at startup — last cached remote copy
 * (validated) first, bundled data/*.json as fallback — and exposes refresh()
 * to fetch/validate/cache the remote copies in the background. A refreshed
 * registry applies on the next launch; character images are remote-first at
 * render time independently of this cache.
 *
 * Remote payloads are never trusted as-is: states must be a superset of the
 * bundled state names (app logic references them), unknown eyeType/effect
 * values are clamped to ones the engine can draw, and character names/image
 * filenames must match strict patterns so a compromised registry cannot
 * inject URLs or oversized content.
 */

const fs = require('fs');
const path = require('path');

const bundledStates = require('./data/states.json');
const bundledCharacters = require('./data/characters.json');

const STATIC_BASE_URL = (process.env.VIBEMON_STATIC_URL || 'https://static.vibemon.io').replace(/\/+$/, '');

const FETCH_TIMEOUT_MS = 5000;

// Engine drawing capabilities: unknown values are clamped to these.
const EYE_TYPES = new Set(['normal', 'glasses', 'blink', 'happy']);
const EFFECTS = new Set(['none', 'sparkle', 'thinking', 'question', 'zzz', 'exclamation']);

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const REGISTRY_NAME = /^[a-z0-9_-]{1,32}$/;
const IMAGE_FILE = /^[a-z0-9_-]{1,64}\.png$/;
const MAX_TEXT_LENGTH = 32;

const REQUIRED_STATES = Object.keys(bundledStates.states);

/**
 * Cache directory for validated remote registries. Uses Electron's userData
 * when available; VIBEMON_REGISTRY_CACHE_DIR overrides it (tests, scripts).
 * Returns null when neither is available (bundled data only).
 */
function getCacheDir() {
  if (process.env.VIBEMON_REGISTRY_CACHE_DIR) {
    return process.env.VIBEMON_REGISTRY_CACHE_DIR;
  }
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'registry');
    }
  } catch {
    // Not running inside Electron (tests, scripts)
  }
  return null;
}

function isFiniteInRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Validate and sanitize a remote states registry. Returns a `{ states }`
 * object in the bundled file's shape, or null when the payload is not
 * usable (malformed, or missing/corrupting one of the bundled states).
 * Unknown eyeType/effect values are clamped; invalid extra states are
 * dropped.
 */
function sanitizeStatesRegistry(json) {
  if (!json || typeof json !== 'object' || !json.states || typeof json.states !== 'object') {
    return null;
  }

  const states = {};
  for (const [name, entry] of Object.entries(json.states)) {
    const required = REQUIRED_STATES.includes(name);
    const valid =
      REGISTRY_NAME.test(name) &&
      entry && typeof entry === 'object' &&
      typeof entry.color === 'string' && HEX_COLOR.test(entry.color) &&
      typeof entry.text === 'string' && entry.text.length >= 1 && entry.text.length <= MAX_TEXT_LENGTH &&
      typeof entry.active === 'boolean' &&
      typeof entry.loading === 'boolean';

    if (!valid) {
      if (required) return null;
      continue;
    }

    states[name] = {
      color: entry.color,
      text: entry.text,
      active: entry.active,
      loading: entry.loading,
      eyeType: EYE_TYPES.has(entry.eyeType) ? entry.eyeType : 'normal',
      effect: EFFECTS.has(entry.effect) ? entry.effect : 'none'
    };
  }

  for (const name of REQUIRED_STATES) {
    if (!states[name]) return null;
  }

  return { states };
}

function sanitizeEyes(eyes) {
  if (!eyes || typeof eyes !== 'object') return null;
  const point = (p) => (p && isFiniteInRange(p.x, 0, 128) && isFiniteInRange(p.y, 0, 128))
    ? { x: p.x, y: p.y }
    : null;
  const left = point(eyes.left);
  const right = point(eyes.right);
  if (!left || !right) return null;

  if (isFiniteInRange(eyes.size, 1, 64)) {
    return { left, right, size: eyes.size };
  }
  if (isFiniteInRange(eyes.w, 1, 64) && isFiniteInRange(eyes.h, 1, 64)) {
    return { left, right, w: eyes.w, h: eyes.h };
  }
  return null;
}

/**
 * Validate and sanitize a remote characters registry. Returns a
 * `{ default, characters }` object in the bundled file's shape, or null
 * when unusable. Invalid entries are dropped (character removal is a
 * legitimate registry change — see the codex retirement — so no superset
 * rule here); the file is rejected if its default is missing or invalid.
 */
function sanitizeCharactersRegistry(json) {
  if (!json || typeof json !== 'object' || !json.characters || typeof json.characters !== 'object') {
    return null;
  }

  const characters = {};
  for (const [name, entry] of Object.entries(json.characters)) {
    if (!REGISTRY_NAME.test(name) || !entry || typeof entry !== 'object') continue;

    const eyes = sanitizeEyes(entry.eyes);
    const effect = entry.effect && isFiniteInRange(entry.effect.x, 0, 128) && isFiniteInRange(entry.effect.y, 0, 128)
      ? { x: entry.effect.x, y: entry.effect.y }
      : null;

    const valid =
      typeof entry.displayName === 'string' && entry.displayName.length >= 1 && entry.displayName.length <= MAX_TEXT_LENGTH &&
      typeof entry.color === 'string' && HEX_COLOR.test(entry.color) &&
      typeof entry.image === 'string' && IMAGE_FILE.test(entry.image) &&
      eyes && effect;

    if (!valid) continue;

    characters[name] = {
      displayName: entry.displayName,
      color: entry.color,
      image: entry.image,
      eyes,
      effect
    };
    // Optional overlay colors (characters whose eyes/glasses shouldn't be
    // drawn in the default near-black — e.g. a dark screen face); invalid
    // values are dropped, falling back to the defaults.
    if (typeof entry.eyeColor === 'string' && HEX_COLOR.test(entry.eyeColor)) {
      characters[name].eyeColor = entry.eyeColor;
    }
    if (typeof entry.glassesColor === 'string' && HEX_COLOR.test(entry.glassesColor)) {
      characters[name].glassesColor = entry.glassesColor;
    }
  }

  if (typeof json.default !== 'string' || !characters[json.default]) {
    return null;
  }

  return { default: json.default, characters };
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolve the registries synchronously: validated cached remote copy first,
 * bundled data second. Called once at module load.
 */
function loadRegistries() {
  const dir = getCacheDir();
  let states = null;
  let characters = null;

  if (dir) {
    states = sanitizeStatesRegistry(readJsonSafe(path.join(dir, 'states.json')));
    characters = sanitizeCharactersRegistry(readJsonSafe(path.join(dir, 'characters.json')));
  }

  return {
    statesRegistry: states || bundledStates,
    charactersRegistry: characters || bundledCharacters
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/**
 * Fetch the canonical registries from STATIC_BASE_URL, validate/sanitize
 * them, and persist the sanitized copies to the cache directory. The
 * refreshed registry is picked up on the next launch. Returns true when the
 * cache was updated.
 */
async function refresh() {
  const dir = getCacheDir();
  if (!dir) return false;

  try {
    const [statesJson, charactersJson] = await Promise.all([
      fetchJson(`${STATIC_BASE_URL}/data/states.json`),
      fetchJson(`${STATIC_BASE_URL}/data/characters.json`)
    ]);

    const states = sanitizeStatesRegistry(statesJson);
    const characters = sanitizeCharactersRegistry(charactersJson);
    if (!states || !characters) {
      console.warn('Registry refresh: remote registry failed validation, keeping current cache');
      return false;
    }

    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(path.join(dir, 'states.json'), JSON.stringify(states, null, 2));
    writeFileAtomic(path.join(dir, 'characters.json'), JSON.stringify(characters, null, 2));
    console.log(`Registry cache refreshed from ${STATIC_BASE_URL}`);
    return true;
  } catch (error) {
    console.warn('Registry refresh failed:', error.message);
    return false;
  }
}

const { statesRegistry, charactersRegistry } = loadRegistries();

module.exports = {
  STATIC_BASE_URL,
  statesRegistry,
  charactersRegistry,
  refresh,
  // Exported for tests
  sanitizeStatesRegistry,
  sanitizeCharactersRegistry
};
