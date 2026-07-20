/**
 * Monster state/theme definitions for the 3D engine (vibemon-engine-3d.js).
 *
 * Pure data + math — no three.js import — so jest can load it with the same
 * vm-sandbox technique as tests/engine.test.js and guard the invariants:
 * every registry state has an animation, every move name is implemented,
 * every bundled character has a color theme.
 *
 * Pose values are sparse Euler rotations (radians) per joint, applied on top
 * of the rig's rest pose. Moves are named procedural oscillators the engine
 * implements (MOVE vocabulary below); they layer additive motion over the
 * blended pose each frame.
 */

// Joints the rig exposes for posing. The tail is always procedural (wave)
// and is not posable per state.
export const JOINTS = [
  'root', 'torso', 'head',
  'armL', 'armR', 'elbowL', 'elbowR',
  'legL', 'legR'
];

// Procedural motion vocabulary. STATE_ANIMATIONS may only reference these;
// the engine maps each name to an implementation.
export const MOVES = [
  'breathe',   // body scale swell
  'bounce',    // springy landing bounce
  'wave',      // raised forearm waving
  'tilt',      // head tilting side to side
  'nod',       // head nodding
  'conduct',   // arm drawing circles, conductor-style
  'typing',    // both forearms hammering fast, alternating
  'squash',    // whole-body squash & stretch
  'gather',    // arms sweeping in and out
  'hop',       // repeated jumps in place
  'tremble'    // high-frequency full-body shiver
];

// Eye rendering modes: 'open' shows pupils, 'closed' shuts the lids,
// 'happy' swaps in the ^ ^ arcs.
export const EYE_MODES = ['open', 'closed', 'happy'];

/**
 * Per-state animation definitions, keyed by the 10 registry state names.
 *   eye      - EYE_MODES entry
 *   eyeScale - relative eye size (wide-eyed alert vs normal)
 *   blink    - whether the periodic blink cycle runs
 *   speed    - global oscillator time scale for this state
 *   tailSpeed- tail wave speed multiplier
 *   pose     - sparse joint rotation targets (radians), blended smoothly
 *   moves    - MOVES entries layered on top
 * Unknown states fall back to `idle`.
 */
export const STATE_ANIMATIONS = {
  start: {
    eye: 'open', eyeScale: 1, blink: false, speed: 1.4, tailSpeed: 1.6,
    pose: { armR: { z: -2.3 }, head: { z: -0.12 } },
    moves: ['wave', 'bounce']
  },
  idle: {
    eye: 'open', eyeScale: 1, blink: true, speed: 1, tailSpeed: 1,
    pose: {},
    moves: ['breathe']
  },
  thinking: {
    eye: 'open', eyeScale: 1, blink: true, speed: 0.9, tailSpeed: 0.6,
    pose: { head: { z: 0.16, x: 0.08 }, armR: { z: -1.7, x: -0.5 }, elbowR: { x: -1.9 } },
    moves: ['tilt']
  },
  planning: {
    eye: 'open', eyeScale: 1, blink: true, speed: 1.1, tailSpeed: 0.9,
    pose: { armR: { z: -1.3 }, elbowR: { x: -0.9 } },
    moves: ['nod', 'conduct']
  },
  working: {
    eye: 'open', eyeScale: 1, blink: false, speed: 1.6, tailSpeed: 1.4,
    pose: { torso: { x: 0.18 }, head: { x: 0.14 }, armL: { z: 0.5, x: -0.7 }, armR: { z: -0.5, x: -0.7 } },
    moves: ['typing']
  },
  packing: {
    eye: 'open', eyeScale: 1, blink: true, speed: 1.1, tailSpeed: 0.8,
    pose: { torso: { x: 0.12 } },
    moves: ['squash', 'gather']
  },
  notification: {
    eye: 'open', eyeScale: 1.1, blink: false, speed: 1.5, tailSpeed: 1.6,
    pose: { armL: { z: 2.4 }, armR: { z: -2.4 } },
    moves: ['hop', 'wave']
  },
  done: {
    eye: 'happy', eyeScale: 1, blink: false, speed: 1.3, tailSpeed: 1.8,
    pose: { armL: { z: 2.5 }, armR: { z: -2.5 }, head: { x: -0.1 } },
    moves: ['hop']
  },
  sleep: {
    eye: 'closed', eyeScale: 1, blink: false, speed: 0.35, tailSpeed: 0.25,
    pose: { head: { x: 0.22 }, torso: { x: 0.1 }, armL: { z: 0.15 }, armR: { z: -0.15 } },
    moves: ['breathe']
  },
  alert: {
    eye: 'open', eyeScale: 1.3, blink: false, speed: 1.8, tailSpeed: 2.2,
    pose: { armL: { z: 1.1 }, armR: { z: -1.1 }, head: { x: -0.08 } },
    moves: ['tremble']
  }
};

/**
 * Character color themes for the 3D pet: one chubby blob body, tinted per
 * character in soft pastel takes on each character's established identity
 * (vibemon purple, clawd orange, codex dark blue, kiro white, claw red,
 * daangni peach).
 *   body   - main fur color
 *   belly  - belly patch / hands / tail tip
 *   accent - inner ears
 *   eye    - eye / happy-arc / mouth color
 *   blush  - cheek patches
 */
export const CHARACTER_THEMES = {
  vibemon: { body: '#B79CFA', belly: '#EFE9FF', accent: '#7C5CD6', eye: '#2B2140', blush: '#FFA7C4' },
  clawd:   { body: '#EFA07F', belly: '#FBE3D4', accent: '#C96F4A', eye: '#3A2318', blush: '#FF9E80' },
  codex:   { body: '#2C3E6B', belly: '#46598F', accent: '#6E8BFF', eye: '#EAF6FF', blush: '#6E8BFF' },
  kiro:    { body: '#F7F7F8', belly: '#FFFFFF', accent: '#C9C9D4', eye: '#2A2A32', blush: '#FFC2CE' },
  claw:    { body: '#E86A6A', belly: '#FFC9C9', accent: '#C24444', eye: '#331111', blush: '#FF9494' },
  daangni: { body: '#F6D3BD', belly: '#FDEFE4', accent: '#46B5AB', eye: '#46352A', blush: '#F9A08C' }
};

export const DEFAULT_THEME = CHARACTER_THEMES.vibemon;

/**
 * Resolve the theme for a character name. Unknown characters (future registry
 * additions) derive a theme from their registry entry's color/eyeColor so
 * they still render distinctly instead of falling back to the default.
 */
export function getCharacterTheme(name, registryEntry) {
  if (CHARACTER_THEMES[name]) return CHARACTER_THEMES[name];
  if (registryEntry && registryEntry.color) {
    return {
      body: registryEntry.color,
      belly: '#FFFFFF',
      accent: registryEntry.glassesColor || '#7C5CD6',
      eye: registryEntry.eyeColor || '#2B2140',
      blush: '#FFA7C4'
    };
  }
  return DEFAULT_THEME;
}

/** Resolve the animation for a state name, falling back to idle. */
export function getStateAnimation(state) {
  return STATE_ANIMATIONS[state] || STATE_ANIMATIONS.idle;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Frame-rate independent smoothing factor: how far to move toward a target
 * this frame given dt seconds and a responsiveness rate (1/s).
 */
export function dampFactor(rate, dt) {
  return 1 - Math.exp(-rate * dt);
}
