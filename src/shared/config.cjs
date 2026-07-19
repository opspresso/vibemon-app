/**
 * Shared configuration for VibeMon (CommonJS)
 * App settings from constants.json, character registry from characters.cjs
 * (single source: data/characters.json)
 * Rendering data is in src/engine/vibemon-engine.js
 */

const constants = require('./constants.cjs');
const characters = require('./characters.cjs');
const states = require('./states.cjs');

// =============================================================================
// WebSocket Configuration (from environment variables)
// =============================================================================
const WS_URL = process.env.VIBEMON_WS_URL || 'wss://ws.vibemon.io';
const WS_TOKEN = process.env.VIBEMON_WS_TOKEN || null;

// =============================================================================
// Hook Installer Configuration (from environment variables)
// =============================================================================
const DOCS_BASE_URL = process.env.VIBEMON_DOCS_URL || 'https://docs.vibemon.io';
// Optional strict pin for custom installer deployments. Normally null: the
// installer hash comes from the published manifest.json, so install.py
// updates ship with a docs deploy alone (no app release needed).
const INSTALLER_SHA256 = process.env.VIBEMON_INSTALLER_SHA256 || null;

// =============================================================================
// Canonical Registry (vibemon-static)
// =============================================================================
const { STATIC_BASE_URL } = require('./registry-cache.cjs');

module.exports = {
  // App constants (constants.json)
  ...constants,

  // Character registry (data/characters.json):
  // DEFAULT_CHARACTER, CHARACTER_CONFIG, CHARACTER_NAMES, CHARACTER_COLORS
  ...characters,

  // State registry (data/states.json):
  // STATE_CONFIG, VALID_STATES, ACTIVE_STATES, LOADING_STATES,
  // STATE_COLORS, STATE_TEXTS
  ...states,

  // WebSocket
  WS_URL,
  WS_TOKEN,

  // Hook Installer
  DOCS_BASE_URL,
  INSTALLER_SHA256,

  // Canonical registry base URL (vibemon-static)
  STATIC_BASE_URL
};
