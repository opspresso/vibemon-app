/**
 * Tests for the 3D engine's state/theme definitions
 * (src/engine/monster-states.js) — guards that every registry state has an
 * animation, every referenced move/joint/eye mode is part of the declared
 * vocabulary, and every bundled character has a color theme.
 *
 * Like tests/engine.test.js, the module is an ES module the renderer loads
 * in the browser, so it is read, export-stripped, and evaluated in a vm
 * sandbox instead of require()d.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { VALID_STATES } = require('../src/shared/states.cjs');
const { CHARACTER_NAMES } = require('../src/shared/characters.cjs');

function loadMonsterStates() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'engine', 'monster-states.js'),
    'utf8'
  )
    .replace(/^export /gm, '')
    + '\nmodule.exports = { JOINTS, MOVES, EYE_MODES, STATE_ANIMATIONS, ' +
      'CHARACTER_THEMES, DEFAULT_THEME, getCharacterTheme, getStateAnimation, lerp, dampFactor };';

  const mod = { exports: {} };
  vm.runInNewContext(src, { module: mod, exports: mod.exports, console });
  return mod.exports;
}

const {
  JOINTS, MOVES, EYE_MODES, STATE_ANIMATIONS,
  CHARACTER_THEMES, DEFAULT_THEME,
  getCharacterTheme, getStateAnimation, lerp, dampFactor
} = loadMonsterStates();

const HEX_COLOR = /^#[0-9A-F]{6}$/i;

describe('state animation coverage', () => {
  test('every registry state has an animation definition', () => {
    for (const state of VALID_STATES) {
      expect(STATE_ANIMATIONS[state]).toBeDefined();
    }
  });

  test('animations only reference declared moves, joints, and eye modes', () => {
    for (const [state, anim] of Object.entries(STATE_ANIMATIONS)) {
      expect(EYE_MODES).toContain(anim.eye);
      expect(typeof anim.blink).toBe('boolean');
      expect(anim.speed).toBeGreaterThan(0);
      expect(anim.tailSpeed).toBeGreaterThan(0);
      expect(anim.eyeScale).toBeGreaterThan(0);
      for (const move of anim.moves) {
        expect(MOVES).toContain(move);
      }
      for (const joint of Object.keys(anim.pose)) {
        expect(JOINTS).toContain(joint);
      }
      expect(state).toBeTruthy();
    }
  });

  test('unknown states fall back to idle', () => {
    expect(getStateAnimation('nope')).toBe(STATE_ANIMATIONS.idle);
    expect(getStateAnimation('working')).toBe(STATE_ANIMATIONS.working);
  });
});

describe('character themes', () => {
  test('every bundled character has a theme with valid hex colors', () => {
    for (const name of CHARACTER_NAMES) {
      const theme = CHARACTER_THEMES[name];
      expect(theme).toBeDefined();
      for (const key of ['body', 'belly', 'accent', 'eye', 'blush']) {
        expect(theme[key]).toMatch(HEX_COLOR);
      }
    }
  });

  test('unknown characters derive a theme from their registry entry', () => {
    const theme = getCharacterTheme('newmon', { color: '#123456', eyeColor: '#ABCDEF' });
    expect(theme.body).toBe('#123456');
    expect(theme.eye).toBe('#ABCDEF');
  });

  test('unknown characters without a registry entry use the default theme', () => {
    expect(getCharacterTheme('newmon', undefined)).toBe(DEFAULT_THEME);
  });
});

describe('math helpers', () => {
  test('lerp interpolates linearly', () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(2, 2, 0.3)).toBe(2);
  });

  test('dampFactor stays within (0, 1) and grows with dt', () => {
    const slow = dampFactor(9, 0.01);
    const fast = dampFactor(9, 0.1);
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeLessThan(1);
    expect(fast).toBeGreaterThan(slow);
  });
});
