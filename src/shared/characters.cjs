/**
 * Character registry (CommonJS)
 *
 * Single source of truth: the canonical registry in vibemon-static
 * (static.vibemon.io/data/characters.json), resolved at startup by
 * registry-cache.cjs (cached remote copy → bundled data/characters.json).
 * To add a character, add its 128x128 PNG and one registry entry to
 * vibemon-static — the rendering engine, tray icon, menus, and validation
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

const CHARACTER_COLORS = Object.fromEntries(
  CHARACTER_NAMES.map(name => [name, CHARACTER_CONFIG[name].color])
);

module.exports = {
  DEFAULT_CHARACTER,
  CHARACTER_CONFIG,
  CHARACTER_NAMES,
  CHARACTER_COLORS
};
