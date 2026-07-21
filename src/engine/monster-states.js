/**
 * VibeMon state/theme definitions for the 3D engine (vibemon-engine-3d.js).
 *
 * Pure data + math — no three.js import — so jest can load it with the same
 * vm-sandbox technique as tests/engine.test.js and guard the invariants:
 * every registry state has an animation, every move name is implemented,
 * every bundled character has a color theme.
 *
 * The character is a digital vibe monster: a squishy horned creature with a
 * spade tail and a "vibe flame" burning above its head. The flame is the
 * session's energy made visible — each state sets a `vibe` level that
 * drives the flame's size and flicker plus the tail sway. State motion is
 * creature behavior (gazing around, waving, tail-tapping, scanning,
 * circling, bouncing, pulsing, coiling, popping up, pirouetting, nodding
 * off, sinking, shivering, darting glances) — never human-tool mimicry.
 *
 * Pose values are sparse Euler rotations (radians) per joint, applied on
 * top of the rig's rest pose. Moves are named procedural oscillators the
 * engine implements (MOVE vocabulary below); they layer additive motion
 * over the blended pose each frame.
 */

// Joints the rig exposes for posing. The vibe flame and tail also animate
// continuously per state (vibe level) independent of posing.
export const JOINTS = [
  'root', 'body',
  'armL', 'armR',
  'tail1', 'tail2',
  'flame'
];

// Procedural motion vocabulary. STATE_ANIMATIONS may only reference these;
// the engine maps each name to an implementation.
export const MOVES = [
  'breathe',    // resting breathing swell
  'lookAround', // slow curious gaze left and right
  'ponder',     // tilting up and sideways, mulling something over
  'orbitDrift', // drifting in a slow circle, leaning into the drift, surveying
  'pulseFocus', // fast heartbeat pulse, energy gathering
  'coil',       // rhythmic inward squeeze, arms pulled in, tail curling in
  'popUp',      // springing upward to get attention, squashing before each hop
  'twirl',      // joyful full 360-degree pirouette with a beat between spins
  'hopJoy',     // happy hopping in place
  'wiggle',     // playful side-to-side wobble
  'shiver',     // hackles-up high-frequency trembling
  'swell',      // puffing up big
  'sink',       // drooping low, settling down
  'stretch',    // waking-up stretch, arms reaching
  'wave',       // raised-paw greeting wave
  'tailTap',    // tail tip tapping a thinking rhythm
  'scan',       // deliberate sweep side to side, dwelling at each end
  'bounceWork', // quick busy bounces with squash-and-stretch landings
  'dartGlance', // sharp watchful glances snapping side to side
  'nod'         // drowsy head slowly nodding off and drifting back up
];

// Eye rendering modes: 'open' shows the eyes, 'closed' shuts them to lines,
// 'happy' swaps in the ^ ^ arcs.
export const EYE_MODES = ['open', 'closed', 'happy'];

/**
 * Per-state animation definitions, keyed by the 10 registry state names.
 *   eye      - EYE_MODES entry
 *   eyeScale - relative eye size (wide-eyed alert vs normal)
 *   blink    - whether the periodic blink cycle runs
 *   speed    - global oscillator time scale for this state
 *   vibe     - energy level: vibe-flame size/flicker + tail sway speed
 *   pose     - sparse joint rotation targets (radians), blended smoothly
 *   moves    - MOVES entries layered on top
 * Unknown states fall back to `idle`.
 */
export const STATE_ANIMATIONS = {
  // Waking up: a big stretch, then a one-paw greeting wave (asymmetric on
  // purpose so it reads differently from notification's both-arms-up).
  start: {
    eye: 'open', eyeScale: 1, blink: false, speed: 1.3, vibe: 1.6,
    pose: { armR: { z: -2.2 } },
    moves: ['stretch', 'wave']
  },
  // Loafing around: breathing, gazing about, idly tapping the tail tip.
  idle: {
    eye: 'open', eyeScale: 1, blink: true, speed: 1, vibe: 1,
    pose: {},
    moves: ['breathe', 'lookAround', 'tailTap']
  },
  // Mulling it over: chin lifted, tilting side to side, tail tapping a
  // thinking rhythm.
  thinking: {
    eye: 'open', eyeScale: 1, blink: true, speed: 0.9, vibe: 1.3,
    pose: { body: { x: -0.12 } },
    moves: ['ponder', 'tailTap']
  },
  // Surveying the terrain: circling slowly while sweeping its gaze,
  // dwelling at each end of the sweep.
  planning: {
    eye: 'open', eyeScale: 1, blink: true, speed: 1.1, vibe: 1.5,
    pose: {},
    moves: ['orbitDrift', 'scan']
  },
  // Head-down busy: leaning in, bouncing quickly with the effort, heart
  // pounding.
  working: {
    eye: 'open', eyeScale: 1, blink: false, speed: 1.5, vibe: 2.2,
    pose: { body: { x: 0.18 } },
    moves: ['bounceWork', 'pulseFocus']
  },
  // Compressing itself: arms hugged in, squeezing down rhythmically, tail
  // curling tight.
  packing: {
    eye: 'open', eyeScale: 1, blink: true, speed: 1.1, vibe: 0.9,
    pose: { armL: { z: 0.15 }, armR: { z: -0.15 } },
    moves: ['coil']
  },
  // "Over here!": both arms up, springing off the ground, wobbling eagerly.
  notification: {
    eye: 'open', eyeScale: 1.15, blink: false, speed: 1.5, vibe: 2,
    pose: { armL: { z: 2.2 }, armR: { z: -2.2 } },
    moves: ['popUp', 'wiggle']
  },
  // Celebrating: full pirouettes with happy hops, arms thrown up.
  done: {
    eye: 'happy', eyeScale: 1, blink: false, speed: 1.3, vibe: 2.4,
    pose: { armL: { z: 2.5 }, armR: { z: -2.5 } },
    moves: ['twirl', 'hopJoy']
  },
  // Dozing: sunk low, head drooped, slow deep breaths, nodding off.
  sleep: {
    eye: 'closed', eyeScale: 1, blink: false, speed: 0.35, vibe: 0.25,
    pose: { body: { x: 0.3 } },
    moves: ['sink', 'breathe', 'nod']
  },
  // Hackles up: puffed and trembling, snapping sharp glances side to side.
  alert: {
    eye: 'open', eyeScale: 1.35, blink: false, speed: 1.9, vibe: 2.6,
    pose: { armL: { z: 1.2 }, armR: { z: -1.2 } },
    moves: ['shiver', 'swell', 'dartGlance']
  }
};

/**
 * Character color themes for the vibe monster, tinted per character after
 * each character's established identity (vibemon purple, clawd orange,
 * codex dark blue, kiro white, claw red, daangni peach).
 *   body   - slime body color
 *   belly  - belly patch / paws
 *   accent - horns / spade tail tip
 *   eye    - eye / happy-arc / mouth color
 *   blush  - cheek patches
 *   flame  - vibe flame glow color
 */
export const CHARACTER_THEMES = {
  vibemon: { body: '#8B7CF6', belly: '#EDE9FF', accent: '#C4B5FD', eye: '#241B3A', blush: '#FF9EC4', flame: '#7DF9FF' },
  clawd:   { body: '#D97757', belly: '#F5C9B0', accent: '#A8442A', eye: '#2B1A12', blush: '#FF9E80', flame: '#FFC26B' },
  codex:   { body: '#2C3E6B', belly: '#46598F', accent: '#6E8BFF', eye: '#EAF6FF', blush: '#6E8BFF', flame: '#9DB8FF' },
  kiro:    { body: '#F4F4F5', belly: '#FFFFFF', accent: '#C9C9D4', eye: '#27272A', blush: '#FFC2CE', flame: '#A5E8FF' },
  claw:    { body: '#DD5555', belly: '#FFC9C9', accent: '#C24444', eye: '#331111', blush: '#FF9494', flame: '#FFB4A0' },
  daangni: { body: '#F2CAB2', belly: '#FDEFE4', accent: '#2AA198', eye: '#46352A', blush: '#F9A08C', flame: '#7FE3D8' }
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
      accent: registryEntry.glassesColor || '#C4B5FD',
      eye: registryEntry.eyeColor || '#241B3A',
      blush: '#FF9EC4',
      flame: '#7DF9FF'
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
