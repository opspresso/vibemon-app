/**
 * VibeMon rendering engine
 *
 * Canonical shared module for drawing the floating pixel-art character onto
 * a 128x128 canvas: the character sprite image, state-driven eyes/effects,
 * the idle blink cycle, and a cosine/sine floating offset. The canvas
 * background stays fully transparent — state color and status/metric text
 * live in the speech bubble module (vibemon-bubble.js), not here.
 *
 * This file is the source of truth. vibemon-app and vibemon vendor a copy
 * at build time (see each repo's check-registry script). No page on this
 * site imports it at runtime.
 *
 * Character definitions (colors, eye/effect coordinates, image files) and
 * state definitions (eyeType/effect per state) come from the shared
 * registries (data/characters.json and data/states.json) and are
 * passed in via options — the engine itself is data-agnostic.
 *
 * Usage:
 *   const engine = createVibeMonEngine(container, {
 *     characters,          // registry entries: { [name]: { color, eyes, effect, ... } }
 *                          // eye/effect anchors are in canvas pixels (0..128)
 *     defaultCharacter,    // registry default: fallback for unknown names
 *     characterImageUrls,  // { [name]: url }
 *     states               // registry entries: { [name]: { eyeType, effect, ... } }
 *   });
 *   await engine.init();
 *   engine.setState({ state: 'working', character: 'vibemon' });
 *   engine.render();
 *   engine.startAnimation();
 */

// =============================================================================
// CONSTANTS
// =============================================================================

const CONSTANTS = {
  CHAR_SIZE: 128,
  SCALE: 2,
  COLOR_EYE: '#000000',
  COLOR_WHITE: '#FFFFFF',
  FLOAT_AMPLITUDE_X: 3,
  FLOAT_AMPLITUDE_Y: 5,
  CHAR_X_BASE: 22,
  CHAR_Y_BASE: 20,
  FRAME_INTERVAL: 100,
  FLOAT_CYCLE_FRAMES: 32,
  BLINK_START_FRAME: 30,
  BLINK_END_FRAME: 31
};

// =============================================================================
// ANIMATION HELPERS
// =============================================================================

function getFloatOffset(animFrame) {
  const angle = (animFrame % CONSTANTS.FLOAT_CYCLE_FRAMES) * (2 * Math.PI / CONSTANTS.FLOAT_CYCLE_FRAMES);
  return { x: Math.cos(angle) * CONSTANTS.FLOAT_AMPLITUDE_X, y: Math.sin(angle) * CONSTANTS.FLOAT_AMPLITUDE_Y };
}

// Effects whose drawing depends on animFrame. Deriving the redraw gate from
// the state's effect (instead of a hardcoded state-name list) means a new
// registry state with an animated effect animates without an engine change.
const ANIMATED_EFFECTS = ['sparkle', 'thinking', 'zzz', 'exclamation'];

function needsAnimationRedraw(state, stateDef, blinkFrame) {
  if (stateDef && ANIMATED_EFFECTS.includes(stateDef.effect)) return true;
  // The idle blink cycle is the one state-name special case the engine keeps.
  if (state === 'idle') return blinkFrame === CONSTANTS.BLINK_START_FRAME || blinkFrame === CONSTANTS.BLINK_END_FRAME;
  return false;
}

// =============================================================================
// EYES AND EFFECTS
// =============================================================================

const COLOR_EFFECT_ALT = '#FFA500';
const COLOR_GLASSES_FRAME = '#111111';

// Registry eye/effect anchors are authored in canvas pixels (0..CHAR_SIZE)
// so characters can be aligned with 1px precision, while the drawing
// functions work on the SCALE-wide pixel-art grid. Convert the anchors once
// here — fractional art units scale back to whole pixels in drawRect.
function toArtUnits(char) {
  if (!char || !char.eyes || !char.effect) return char;
  const s = CONSTANTS.SCALE;
  const eyes = {
    ...char.eyes,
    left: { x: char.eyes.left.x / s, y: char.eyes.left.y / s },
    right: { x: char.eyes.right.x / s, y: char.eyes.right.y / s }
  };
  if (eyes.w !== undefined) eyes.w = char.eyes.w / s;
  if (eyes.h !== undefined) eyes.h = char.eyes.h / s;
  if (eyes.size !== undefined) eyes.size = char.eyes.size / s;
  return { ...char, eyes, effect: { x: char.effect.x / s, y: char.effect.y / s } };
}

function getEyeCoverPosition(char) {
  const eyeW = char.eyes.w || char.eyes.size || 6;
  const eyeH = char.eyes.h || char.eyes.size || 6;
  const lensW = eyeW + 4;
  const lensH = eyeH + 2;
  const lensY = char.eyes.left.y - 1;
  const leftLensX = char.eyes.left.x - 2;
  const rightLensX = char.eyes.right.x - 2;
  return { lensW, lensH, lensY, leftLensX, rightLensX };
}

function drawGlasses(char, drawRect) {
  const { lensW, lensH, lensY, leftLensX, rightLensX } = getEyeCoverPosition(char);
  // Frame color: per-character glassesColor (e.g. codex's light frame on a
  // dark screen), near-black by default.
  const frameColor = char.glassesColor || COLOR_GLASSES_FRAME;

  // Frame only - lenses stay clear so the eyes underneath remain visible
  drawRect(leftLensX - 1, lensY - 1, lensW + 2, 1, frameColor);
  drawRect(rightLensX - 1, lensY - 1, lensW + 2, 1, frameColor);
  drawRect(leftLensX - 1, lensY + lensH, lensW + 2, 1, frameColor);
  drawRect(rightLensX - 1, lensY + lensH, lensW + 2, 1, frameColor);
  drawRect(leftLensX - 1, lensY, 1, lensH, frameColor);
  drawRect(leftLensX + lensW, lensY, 1, lensH, frameColor);
  drawRect(rightLensX - 1, lensY, 1, lensH, frameColor);
  drawRect(rightLensX + lensW, lensY, 1, lensH, frameColor);

  // Bridge
  const bridgeY = lensY + Math.floor(lensH / 2) - 2;
  drawRect(leftLensX + lensW, bridgeY, rightLensX - leftLensX - lensW, 1, frameColor);
}

function drawBlinkEyes(char, drawRect) {
  const { lensW, lensH, lensY, leftLensX, rightLensX } = getEyeCoverPosition(char);
  // Stroke color for the closed-eye line: per-character eyeColor (e.g. codex's
  // light eyes on a dark screen), black by default.
  const eyeColor = char.eyeColor || CONSTANTS.COLOR_EYE;

  drawRect(leftLensX, lensY, lensW, lensH, char.color);
  drawRect(rightLensX, lensY, lensW, lensH, char.color);

  const closedEyeY = lensY + Math.floor(lensH / 2);
  drawRect(leftLensX + 1, closedEyeY, lensW - 2, 2, eyeColor);
  drawRect(rightLensX + 1, closedEyeY, lensW - 2, 2, eyeColor);
}

function drawHappyEyes(char, drawRect) {
  const { lensW, lensH, lensY, leftLensX, rightLensX } = getEyeCoverPosition(char);
  const eyeColor = char.eyeColor || CONSTANTS.COLOR_EYE;

  drawRect(leftLensX, lensY, lensW, lensH, char.color);
  drawRect(rightLensX, lensY, lensW, lensH, char.color);

  const centerY = lensY + Math.floor(lensH / 2);
  const leftCX = leftLensX + Math.floor(lensW / 2);
  const rightCX = rightLensX + Math.floor(lensW / 2);

  // Left eye >
  drawRect(leftCX - 2, centerY - 2, 2, 2, eyeColor);
  drawRect(leftCX, centerY, 2, 2, eyeColor);
  drawRect(leftCX - 2, centerY + 2, 2, 2, eyeColor);

  // Right eye <
  drawRect(rightCX, centerY - 2, 2, 2, eyeColor);
  drawRect(rightCX - 2, centerY, 2, 2, eyeColor);
  drawRect(rightCX, centerY + 2, 2, 2, eyeColor);
}

function drawEyeType(eyeType, char, drawRect) {
  if (eyeType === 'glasses') drawGlasses(char, drawRect);
  else if (eyeType === 'blink') drawBlinkEyes(char, drawRect);
  else if (eyeType === 'happy') drawHappyEyes(char, drawRect);
  // 'normal' means the sprite's own eyes: intentionally draws nothing.
  else if (eyeType !== 'normal') console.warn(`VibeMon engine: unknown eyeType "${eyeType}" - nothing drawn`);
}

// Draw rects expanded by 1px in outlineColor first (halo pass), then the
// bodies on top, so the mark stays visible on any backdrop.
function drawOutlinedRects(rects, bodyColor, outlineColor, drawRect) {
  for (const [x, y, w, h] of rects) drawRect(x - 1, y - 1, w + 2, h + 2, outlineColor);
  for (const [x, y, w, h] of rects) drawRect(x, y, w, h, bodyColor);
}

function drawEffect(effect, char, animFrame, drawRect) {
  const { x: effectX, y: effectY } = char.effect;
  const effectColor = char.color === CONSTANTS.COLOR_WHITE ? COLOR_EFFECT_ALT : CONSTANTS.COLOR_WHITE;
  const outlineColor = '#000000';

  if (effect === 'sparkle') {
    const frame = animFrame % 4;
    const rects = [[effectX + 2, effectY + 2, 2, 2]];
    if (frame === 0 || frame === 2) {
      rects.push(
        [effectX + 2, effectY, 2, 2],
        [effectX + 2, effectY + 4, 2, 2],
        [effectX, effectY + 2, 2, 2],
        [effectX + 4, effectY + 2, 2, 2]
      );
    } else {
      rects.push(
        [effectX, effectY, 2, 2],
        [effectX + 4, effectY, 2, 2],
        [effectX, effectY + 4, 2, 2],
        [effectX + 4, effectY + 4, 2, 2]
      );
    }
    drawOutlinedRects(rects, effectColor, outlineColor, drawRect);
  } else if (effect === 'thinking') {
    const rects = [
      [effectX, effectY + 6, 2, 2],
      [effectX + 2, effectY + 3, 2, 2]
    ];
    if ((animFrame % 12) < 6) {
      rects.push(
        [effectX + 3, effectY - 2, 6, 2],
        [effectX + 2, effectY, 8, 3],
        [effectX + 3, effectY + 3, 6, 1]
      );
    } else {
      rects.push(
        [effectX + 4, effectY - 1, 4, 2],
        [effectX + 3, effectY + 1, 6, 2]
      );
    }
    drawOutlinedRects(rects, effectColor, outlineColor, drawRect);
  } else if (effect === 'question') {
    drawOutlinedRects([
      [effectX + 1, effectY, 4, 2],
      [effectX + 4, effectY + 2, 2, 2],
      [effectX + 2, effectY + 4, 2, 2],
      [effectX + 2, effectY + 6, 2, 2],
      [effectX + 2, effectY + 10, 2, 2]
    ], '#000000', CONSTANTS.COLOR_WHITE, drawRect);
  } else if (effect === 'zzz') {
    if ((animFrame % 20) < 10) {
      drawOutlinedRects([
        [effectX, effectY, 6, 1],
        [effectX + 4, effectY + 1, 2, 1],
        [effectX + 3, effectY + 2, 2, 1],
        [effectX + 2, effectY + 3, 2, 1],
        [effectX + 1, effectY + 4, 2, 1],
        [effectX, effectY + 5, 6, 1]
      ], effectColor, outlineColor, drawRect);
    }
  } else if (effect === 'exclamation') {
    // Draw exclamation mark (white with red border)
    const shakeOffset = (Math.floor(animFrame / 2) % 4 < 2) ? 2 : -2;
    const markY = effectY + shakeOffset;

    // Exclamation body (white rectangle)
    drawRect(effectX + 1, markY, 4, 10, CONSTANTS.COLOR_WHITE);

    // Red border around body
    drawRect(effectX, markY - 1, 6, 1, '#DD0000');
    drawRect(effectX, markY + 10, 6, 1, '#DD0000');
    drawRect(effectX, markY, 1, 10, '#DD0000');
    drawRect(effectX + 5, markY, 1, 10, '#DD0000');

    // Exclamation dot (white square)
    drawRect(effectX + 1, markY + 12, 4, 2, CONSTANTS.COLOR_WHITE);

    // Red border around dot
    drawRect(effectX, markY + 11, 6, 1, '#DD0000');
    drawRect(effectX, markY + 14, 6, 1, '#DD0000');
    drawRect(effectX, markY + 12, 1, 2, '#DD0000');
    drawRect(effectX + 5, markY + 12, 1, 2, '#DD0000');
  } else if (effect !== 'none') {
    // 'none' intentionally draws nothing; anything else is a registry typo.
    console.warn(`VibeMon engine: unknown effect "${effect}" - nothing drawn`);
  }
}

// =============================================================================
// CHARACTER RENDERER
// =============================================================================

class CharacterRenderer {
  constructor(ctx) {
    this.ctx = ctx;
    this.characterImages = {};
    this.imagesLoaded = false;
    this.boundDrawRect = this.drawRect.bind(this);
  }

  async preloadImages(imageUrls) {
    if (this.imagesLoaded) return;

    // Each value is a URL or an ordered list of candidate URLs (e.g. remote
    // CDN first, bundled asset as offline fallback).
    const loadOne = (src) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load: ${src}`));
      img.src = src;
    });

    const promises = Object.entries(imageUrls).map(async ([name, url]) => {
      const candidates = Array.isArray(url) ? url : [url];
      for (const src of candidates) {
        try {
          this.characterImages[name] = await loadOne(src);
          return;
        } catch (error) {
          console.warn(error.message);
        }
      }
    });

    await Promise.all(promises);
    this.imagesLoaded = true;
  }

  drawRect(x, y, w, h, color) {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x * CONSTANTS.SCALE, y * CONSTANTS.SCALE, w * CONSTANTS.SCALE, h * CONSTANTS.SCALE);
  }

  drawCharacter(eyeType, effect, characterName, char, animFrame) {
    // Transparent backdrop — only the sprite and its overlays are painted.
    this.ctx.clearRect(0, 0, CONSTANTS.CHAR_SIZE, CONSTANTS.CHAR_SIZE);

    const img = this.characterImages[characterName];
    if (img) this.ctx.drawImage(img, 0, 0, CONSTANTS.CHAR_SIZE, CONSTANTS.CHAR_SIZE);

    if (!char) return;
    drawEyeType(eyeType, char, this.boundDrawRect);
    drawEffect(effect, char, animFrame, this.boundDrawRect);
  }
}

// =============================================================================
// VIBEMON ENGINE
// =============================================================================

export class VibeMonEngine {
  constructor(container, options = {}) {
    this.container = container;
    this.characters = Object.fromEntries(
      Object.entries(options.characters || {}).map(([name, char]) => [name, toArtUnits(char)])
    );
    this.defaultCharacter = options.defaultCharacter || Object.keys(this.characters)[0] || null;
    this.characterImageUrls = options.characterImageUrls || {};
    this.states = options.states || {};

    this.canvas = null;
    this.ctx = null;

    this.currentState = 'start';
    this.currentCharacter = this.defaultCharacter;

    this.animFrame = 0;
    this.blinkFrame = 0;
    this.lastFrameTime = 0;
    this.animationRunning = false;
    this.animationFrameId = null;
    this.characterRenderer = null;

    // Pre-bind animation loop for performance
    this.boundAnimationLoop = this._animationLoop.bind(this);
  }

  _buildDOM() {
    const canvas = document.createElement('canvas');
    canvas.className = 'vibemon-canvas';
    canvas.width = CONSTANTS.CHAR_SIZE;
    canvas.height = CONSTANTS.CHAR_SIZE;
    this.container.appendChild(canvas);

    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  async init() {
    if (this.container && !this.container.querySelector('.vibemon-canvas')) {
      this._buildDOM();
    }

    if (this.ctx) {
      this.characterRenderer = new CharacterRenderer(this.ctx);
      await this.characterRenderer.preloadImages(this.characterImageUrls);
    }
    return this;
  }

  setState(data) {
    if (!data || typeof data !== 'object') return;

    const prevState = this.currentState;
    if (data.state !== undefined) this.currentState = data.state;
    if (data.character !== undefined) {
      this.currentCharacter = this.characters[data.character] ? data.character : this.defaultCharacter;
    }

    if (this.currentState === 'idle' && prevState !== 'idle') {
      this.blinkFrame = 0;
    }
  }

  render() {
    if (!this.characterRenderer) return;
    const state = this.states[this.currentState] || this.states.idle || { eyeType: 'normal', effect: 'none' };
    const char = this.characters[this.currentCharacter] || this.characters[this.defaultCharacter];
    // Idle blink: needsAnimationRedraw triggers a redraw at BLINK_START_FRAME
    // (closed eyes for one 100ms frame) and at BLINK_END_FRAME (open again).
    const eyeType = this.currentState === 'idle' && this.blinkFrame === CONSTANTS.BLINK_START_FRAME
      ? 'blink'
      : state.eyeType;
    this.characterRenderer.drawCharacter(eyeType, state.effect, this.currentCharacter, char, this.animFrame);
  }

  _updateFloatingPosition() {
    if (!this.canvas) return;
    const offset = getFloatOffset(this.animFrame);
    this.canvas.style.left = (CONSTANTS.CHAR_X_BASE + offset.x) + 'px';
    this.canvas.style.top = (CONSTANTS.CHAR_Y_BASE + offset.y) + 'px';
  }

  _animationLoop(timestamp) {
    if (!this.animationRunning) return;

    if (timestamp - this.lastFrameTime < CONSTANTS.FRAME_INTERVAL) {
      this.animationFrameId = requestAnimationFrame(this.boundAnimationLoop);
      return;
    }

    this.lastFrameTime = timestamp;
    this.animFrame++;
    this._updateFloatingPosition();

    if (this.currentState === 'idle') {
      this.blinkFrame++;
      if (this.blinkFrame > CONSTANTS.BLINK_END_FRAME) this.blinkFrame = 0;
    }

    if (needsAnimationRedraw(this.currentState, this.states[this.currentState], this.blinkFrame)) {
      this.render();
    }

    this.animationFrameId = requestAnimationFrame(this.boundAnimationLoop);
  }

  startAnimation() {
    if (this.animationRunning) return;
    this.animationRunning = true;
    this.animationFrameId = requestAnimationFrame(this.boundAnimationLoop);
  }

  stopAnimation() {
    this.animationRunning = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  cleanup() {
    this.stopAnimation();
  }
}

// =============================================================================
// FACTORY AND EXPORTS
// =============================================================================

export function createVibeMonEngine(container, options = {}) {
  return new VibeMonEngine(container, options);
}

export { CONSTANTS };
