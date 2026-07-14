/**
 * Tests for the state registry (src/shared/data/states.json via
 * states.cjs) — guards the invariants every consumer (speech bubble, tray,
 * validation, focus selection, engine rendering) relies on, and that every
 * registry eyeType/effect value is implemented by the engine.
 */

const fs = require('fs');
const path = require('path');
const {
  STATE_CONFIG, VALID_STATES, ACTIVE_STATES, LOADING_STATES,
  STATE_COLORS, STATE_TEXTS
} = require('../src/shared/states.cjs');

describe('state registry', () => {
  test('every entry has the fields consumers rely on', () => {
    for (const name of VALID_STATES) {
      const config = STATE_CONFIG[name];

      expect(config.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(typeof config.text).toBe('string');
      expect(config.text.length).toBeGreaterThan(0);
      expect(typeof config.active).toBe('boolean');
      expect(typeof config.loading).toBe('boolean');
      expect(typeof config.eyeType).toBe('string');
      expect(typeof config.effect).toBe('string');
    }
  });

  test('derived lists and maps cover exactly the registry states', () => {
    expect(Object.keys(STATE_COLORS)).toEqual(VALID_STATES);
    expect(Object.keys(STATE_TEXTS)).toEqual(VALID_STATES);
    for (const name of ACTIVE_STATES) {
      expect(VALID_STATES).toContain(name);
    }
    for (const name of LOADING_STATES) {
      expect(VALID_STATES).toContain(name);
    }
  });

  test('active/loading derivation matches expectations', () => {
    expect(ACTIVE_STATES).toContain('thinking');
    expect(ACTIVE_STATES).toContain('planning');
    expect(ACTIVE_STATES).toContain('working');
    expect(ACTIVE_STATES).toContain('notification');
    expect(ACTIVE_STATES).toContain('alert');
    expect(ACTIVE_STATES).not.toContain('idle');
    expect(ACTIVE_STATES).not.toContain('sleep');

    expect(LOADING_STATES).toEqual(['thinking', 'planning', 'working', 'packing']);
  });

  test('states the app logic hard-codes exist in the registry', () => {
    // state-manager timeouts, focus priority, and window-close logic
    // reference these by name.
    for (const name of ['start', 'idle', 'done', 'sleep', 'alert', 'notification']) {
      expect(VALID_STATES).toContain(name);
    }
  });
});

describe('engine conformance', () => {
  // The engine receives the registry via options (main → preload →
  // renderer), but the drawing branches for each eyeType/effect value live
  // in its source. Extract those branch values so a registry entry naming
  // an unimplemented eyeType/effect fails here instead of rendering
  // nothing at runtime. 'normal' and 'none' intentionally have no branch
  // (they draw no overlay).
  const engineSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'engine', 'vibemon-engine.js'),
    'utf8'
  );

  function extractBranchValues(variable) {
    return new Set(
      [...engineSource.matchAll(new RegExp(`${variable} === '(\\w+)'`, 'g'))].map(m => m[1])
    );
  }

  test('every registry eyeType/effect is implemented by the engine', () => {
    const eyeTypes = extractBranchValues('eyeType');
    const effects = extractBranchValues('effect');
    expect(eyeTypes.size).toBeGreaterThan(0);
    expect(effects.size).toBeGreaterThan(0);

    for (const name of VALID_STATES) {
      const { eyeType, effect } = STATE_CONFIG[name];
      if (eyeType !== 'normal') expect(eyeTypes).toContain(eyeType);
      if (effect !== 'none') expect(effects).toContain(effect);
    }
  });
});
