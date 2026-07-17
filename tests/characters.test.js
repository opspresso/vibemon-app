/**
 * Tests for the character registry (src/shared/data/characters.json via
 * characters.cjs) — guards the invariants every consumer (engine, tray
 * icon, menus, validation) relies on, so a new character entry that breaks
 * one fails here instead of at runtime.
 */

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_CHARACTER, CHARACTER_CONFIG, CHARACTER_NAMES, CHARACTER_COLORS
} = require('../src/shared/characters.cjs');

describe('character registry', () => {
  test('the default character exists in the registry', () => {
    expect(CHARACTER_NAMES).toContain(DEFAULT_CHARACTER);
  });

  test('every entry has the fields consumers rely on', () => {
    for (const name of CHARACTER_NAMES) {
      const config = CHARACTER_CONFIG[name];

      expect(config.name).toBe(name);
      expect(typeof config.displayName).toBe('string');
      expect(config.displayName.length).toBeGreaterThan(0);
      expect(config.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      if (config.eyeColor !== undefined) {
        expect(config.eyeColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
      if (config.glassesColor !== undefined) {
        expect(config.glassesColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
      expect(config.image).toMatch(/\.png$/);

      // Engine eye/effect coordinates
      expect(typeof config.eyes.left.x).toBe('number');
      expect(typeof config.eyes.left.y).toBe('number');
      expect(typeof config.eyes.right.x).toBe('number');
      expect(typeof config.eyes.right.y).toBe('number');
      const hasSize = typeof config.eyes.size === 'number';
      const hasWH = typeof config.eyes.w === 'number' && typeof config.eyes.h === 'number';
      expect(hasSize || hasWH).toBe(true);
      expect(typeof config.effect.x).toBe('number');
      expect(typeof config.effect.y).toBe('number');
    }
  });

  test('every entry\'s image file exists in src/assets/characters', () => {
    for (const name of CHARACTER_NAMES) {
      const imagePath = path.join(__dirname, '..', 'src', 'assets', 'characters', CHARACTER_CONFIG[name].image);
      expect(fs.existsSync(imagePath)).toBe(true);
    }
  });

  test('CHARACTER_COLORS is derived from the registry', () => {
    for (const name of CHARACTER_NAMES) {
      expect(CHARACTER_COLORS[name]).toBe(CHARACTER_CONFIG[name].color);
    }
  });
});
