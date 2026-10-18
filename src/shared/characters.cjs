/**
 * Character registry (CommonJS)
 *
 * Single source of truth: the canonical registry in the public App distribution
 * (vibemon.io/static/data/characters.json), resolved at startup by
 * registry-cache.cjs (cached remote copy → bundled data/characters.json).
 * To add a character, add its square PNG (CHARACTER_IMAGE_SIZES) and one registry entry to
 * the public App distribution — the rendering engine, tray icon, menus, and validation
 * all derive from the registry (bundled copies remain as offline fallback).
 */

const registry = require('./registry-cache.cjs').charactersRegistry;

const DEFAULT_CHARACTER = registry.default;

// `name` is injected into each entry so consumers can pass an entry around
// without carrying its registry key separately.
const CHARACTER_CONFIG = Object.fromEntries(
  Object.entries(registry.characters).map(([name, config]) => [name, { name, ...config }])
);

const CHARACTER_NAMES = Object.keys(CHARACTER_CONFIG);

module.exports = {
  DEFAULT_CHARACTER,
  CHARACTER_CONFIG,
  CHARACTER_NAMES
};
