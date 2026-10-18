/** Registry values the engines can draw. The runtime cache and the publication check share them. */

// Values with an engine drawing branch (vibemon-engine.js drawEyeType/drawEffect).
const EYE_TYPES = new Set(['normal', 'glasses', 'blink', 'happy']);
const EFFECTS = new Set(['none', 'sparkle', 'thinking', 'question', 'zzz', 'exclamation']);
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
// Palette slots the 3D engine paints (monster-states.js DEFAULT_THEME).
const THEME_SLOTS = ['body', 'belly', 'accent', 'eye', 'blush', 'flame'];

module.exports = { EYE_TYPES, EFFECTS, HEX_COLOR, THEME_SLOTS };
