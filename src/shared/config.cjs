/**
 * Shared configuration for VibeMon (CommonJS)
 * App settings from constants.json, character registry from characters.cjs
 * (single source: data/characters.json)
 * Rendering data is in src/engine/vibemon-engine.js
 */

const constants = require('./constants.cjs');
const characters = require('./characters.cjs');

// =============================================================================
// WebSocket Configuration (from environment variables)
// =============================================================================
const WS_URL = process.env.VIBEMON_WS_URL || 'wss://ws.vibemon.io';
const WS_TOKEN = process.env.VIBEMON_WS_TOKEN || null;

// =============================================================================
// Hook Installer Configuration (from environment variables)
// =============================================================================
const DOCS_BASE_URL = process.env.VIBEMON_DOCS_URL || 'https://docs.vibemon.io';

module.exports = {
  // App constants (constants.json)
  ...constants,

  // Character registry (data/characters.json):
  // DEFAULT_CHARACTER, CHARACTER_CONFIG, CHARACTER_NAMES, CHARACTER_COLORS
  ...characters,

  // WebSocket
  WS_URL,
  WS_TOKEN,

  // Hook Installer
  DOCS_BASE_URL
};
