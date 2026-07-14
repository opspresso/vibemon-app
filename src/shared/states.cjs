/**
 * State registry (CommonJS)
 *
 * Single source of truth: data/states.json. Each entry defines a state's
 * speech-bubble color/text, focus behavior (active), loading-dot animation
 * (loading), and engine rendering (eyeType/effect) — the lists and maps
 * below are derived from it, and the engine receives the same registry via
 * IPC (main → preload → renderer). To add or change a state, edit one
 * entry there.
 */

const registry = require('./data/states.json');

const STATE_CONFIG = registry.states;

const VALID_STATES = Object.keys(STATE_CONFIG);

const ACTIVE_STATES = VALID_STATES.filter(name => STATE_CONFIG[name].active);

const LOADING_STATES = VALID_STATES.filter(name => STATE_CONFIG[name].loading);

const STATE_COLORS = Object.fromEntries(
  VALID_STATES.map(name => [name, STATE_CONFIG[name].color])
);

const STATE_TEXTS = Object.fromEntries(
  VALID_STATES.map(name => [name, STATE_CONFIG[name].text])
);

module.exports = {
  STATE_CONFIG,
  VALID_STATES,
  ACTIVE_STATES,
  LOADING_STATES,
  STATE_COLORS,
  STATE_TEXTS
};
