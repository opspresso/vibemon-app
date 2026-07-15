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
const INSTALLER_SHA256 = process.env.VIBEMON_INSTALLER_SHA256 || '0a7e769f7fa8a06b43dae2cd6d25dc42584de4d558b3047af936feb7f488dd2c';

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
  INSTALLER_SHA256
};
