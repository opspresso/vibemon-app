/**
 * Shared configuration for Vibe Monitor (CommonJS)
 * App settings from constants.json
 * Rendering data is in vibemon-engine-standalone.js
 *
 * Constants are in constants.cjs - re-exported here for convenience
 */

const path = require('path');
const os = require('os');

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
// Paths
// =============================================================================
const STATS_CACHE_PATH = path.join(os.homedir(), '.claude', 'stats-cache.json');

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

  // Paths
  STATS_CACHE_PATH,

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
