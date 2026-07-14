/**
 * Shared configuration for Vibe Monitor (CommonJS)
 * App settings from constants.json
 * Rendering data is in vibemon-engine-standalone.js
 *
 * Constants are in constants.cjs - re-exported here for convenience
 */

// Re-export all constants for backward compatibility
const constants = require('./constants.cjs');

// =============================================================================
// WebSocket Configuration (from environment variables)
// =============================================================================
const WS_URL = process.env.VIBEMON_WS_URL || 'wss://ws.vibemon.io';
const WS_TOKEN = process.env.VIBEMON_WS_TOKEN || null;

// =============================================================================
// Hook Installer Configuration (from environment variables)
// =============================================================================
const DOCS_BASE_URL = process.env.VIBEMON_DOCS_URL || 'https://docs.vibemon.io';

// =============================================================================
// State & Character Data (from constants.json)
// =============================================================================

// Directly from constants.json
const {
  VALID_STATES,
  STATE_COLORS,
  CHARACTER_NAMES,
  CHARACTER_COLORS
} = constants;

// Derived CHARACTER_CONFIG for backward compatibility
const CHARACTER_CONFIG = Object.fromEntries(
  CHARACTER_NAMES.map(name => [name, {
    name,
    color: CHARACTER_COLORS[name]
  }])
);

module.exports = {
  // Re-export all constants
  ...constants,

  // State data (from constants.json)
  VALID_STATES,
  STATE_COLORS,

  // Character data (from constants.json)
  CHARACTER_CONFIG,
  CHARACTER_NAMES,

  // WebSocket
  WS_URL,
  WS_TOKEN,

  // Hook Installer
  DOCS_BASE_URL
};
