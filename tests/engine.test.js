/**
 * Tests for the rendering engine (src/engine/vibemon-engine.js).
 *
 * The engine is an ES module the renderer loads in the browser, so it can't
 * be require()d under jest's CommonJS/node environment. Rather than add a
 * Babel or jsdom toolchain just for this, we read its source, strip the
 * `export` keywords, and evaluate it in a vm sandbox — enough to exercise the
 * pure drawing/state logic (which never touches the DOM) against a fake 2D
 * context.
 */

const { loadBrowserModule } = require('./helpers/browser-module.cjs');
const path = require('path');
const { STATE_CONFIG, VALID_STATES } = require('../src/shared/states.cjs');
const charactersRegistry = require('../src/shared/data/characters.json');

function loadEngine(globals = {}) {
  return loadBrowserModule('src/engine/vibemon-engine.js', ['VibeMonEngine', 'CONSTANTS', 'CharacterRenderer'], globals);
}

const { VibeMonEngine, CONSTANTS, CharacterRenderer } = loadEngine();

function fakeCtx() {
  return {
    fillStyle: '',
    clearRect: jest.fn(),
    fillRect: jest.fn(),
    drawImage: jest.fn()
  };
}

// container=null: the constructor doesn't touch the DOM; init()/_buildDOM
// (which do) are deliberately never called here.
function makeEngine() {
  return new VibeMonEngine(null, {
    characters: charactersRegistry.characters,
    defaultCharacter: charactersRegistry.default,
    states: STATE_CONFIG
  });
}

describe('engine state selection', () => {
  test('reduced motion resets floating and blinking while still rendering status changes', () => {
    const engine = makeEngine();
    engine.canvas = { style: {} };
    engine.characterRenderer = { drawCharacter: jest.fn() };
    engine.animFrame = 12; engine.blinkFrame = CONSTANTS.BLINK_START_FRAME;
    engine.setReducedMotion(true);
    engine.setState({ state: 'working' }); engine.render();
    expect(engine.canvas.style).toEqual({ left: CONSTANTS.CHAR_X_BASE + 'px', top: CONSTANTS.CHAR_Y_BASE + 'px' });
    expect(engine.animFrame).toBe(0); expect(engine.blinkFrame).toBe(0);
    expect(engine.characterRenderer.drawCharacter.mock.calls[0].slice(0, 2)).toEqual([STATE_CONFIG.working.eyeType, STATE_CONFIG.working.effect]);
  });
  test('reduced motion stops effect animation and blinking in the frame loop', () => {
    const frames = [];
    const { VibeMonEngine: Engine } = loadEngine({ requestAnimationFrame: (callback) => frames.push(callback) });
    const engine = new Engine(null, { characters: charactersRegistry.characters, defaultCharacter: charactersRegistry.default, states: STATE_CONFIG });
    engine.canvas = { style: {} };
    engine.characterRenderer = { drawCharacter: jest.fn() };
    engine.setReducedMotion(true);
    engine.setState({ state: 'sleep' });
    engine.startAnimation();
    for (let i = 1; i <= 40; i++) frames.shift()(i * CONSTANTS.FRAME_INTERVAL);
    expect(engine.animFrame).toBe(0);
    expect(engine.characterRenderer.drawCharacter).not.toHaveBeenCalled();
    engine.setReducedMotion(false);
    frames.shift()(41 * CONSTANTS.FRAME_INTERVAL);
    expect(engine.animFrame).toBe(1);
    expect(engine.characterRenderer.drawCharacter).toHaveBeenCalledTimes(1);
  });
  test('idle injects the blink eyeType on the blink frame only', () => {
    const engine = makeEngine();
    engine.characterRenderer = { drawCharacter: jest.fn() };

    engine.setState({ state: 'idle', character: 'vibemon' });

    engine.blinkFrame = CONSTANTS.BLINK_START_FRAME;
    engine.render();
    engine.blinkFrame = 0;
    engine.render();

    const [blinkCall, openCall] = engine.characterRenderer.drawCharacter.mock.calls;
    expect(blinkCall[0]).toBe('blink');   // eyeType arg on the blink frame
    expect(openCall[0]).toBe('normal');   // idle's registry eyeType otherwise
  });

  test("forwards each state's registry eyeType/effect to the renderer", () => {
    const engine = makeEngine();
    engine.characterRenderer = { drawCharacter: jest.fn() };

    engine.setState({ state: 'working', character: 'vibemon' });
    engine.render();

    const [eyeType, effect] = engine.characterRenderer.drawCharacter.mock.calls[0];
    expect(eyeType).toBe(STATE_CONFIG.working.eyeType); // 'glasses'
    expect(effect).toBe(STATE_CONFIG.working.effect);   // 'sparkle'
  });

  test('an unknown character falls back to the default', () => {
    const engine = makeEngine();
    engine.setState({ character: 'kiro' });
    expect(engine.currentCharacter).toBe('kiro');

    engine.setState({ character: 'nope' });
    expect(engine.currentCharacter).toBe(charactersRegistry.default);
  });
});

describe('engine drawing', () => {
  test('new companion expressions align with and fully replace its painted eyes', async () => {
    const { createCanvas, loadImage } = require('canvas');
    const canvas = createCanvas(128, 128);
    const context = canvas.getContext('2d');
    const renderer = new CharacterRenderer(context);
    renderer.characterImages.vibemon = await loadImage(path.join(__dirname, '../src/assets/characters', charactersRegistry.characters.vibemon.image));
    const character = makeEngine().characters.vibemon;
    const pixel = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data);
    const ink = [36, 27, 58, 255], body = [139, 124, 246, 255];
    renderer.drawCharacter('normal', 'none', 'vibemon', character, 0);
    for (const x of [46, 82]) expect(pixel(x, 72)).toEqual(ink);
    for (const expression of ['blink', 'happy']) {
      renderer.drawCharacter(expression, 'none', 'vibemon', character, 0);
      for (const x of [46, 82]) {
        expect(pixel(x, 62)).toEqual(body);
        expect(pixel(x, 82)).toEqual(body);
      }
      expect(pixel(46, 73)).toEqual(ink);
      expect(pixel(expression === 'happy' ? 78 : 82, 73)).toEqual(ink);
    }
    renderer.drawCharacter('glasses', 'none', 'vibemon', character, 0);
    for (const x of [46, 82]) expect(pixel(x, 72)).toEqual(ink);
    expect(pixel(33, 56)).toEqual([17, 17, 17, 255]);
  });
  // Drive the real CharacterRenderer against a fake ctx and confirm each
  // registry eyeType/effect actually paints. 'normal' eyes and 'none' effects
  // intentionally paint nothing (no overlay).
  test('every registry eyeType/effect paints when it should', () => {
    const engine = makeEngine();          // gives art-unit character defs
    const char = engine.characters.vibemon;

    for (const name of VALID_STATES) {
      const { eyeType, effect } = STATE_CONFIG[name];
      const ctx = fakeCtx();
      const renderer = new CharacterRenderer(ctx);

      // animFrame 0 keeps frame-gated effects (zzz, sparkle) in a drawing frame.
      renderer.drawCharacter(eyeType, effect, 'vibemon', char, 0);

      expect(ctx.clearRect).toHaveBeenCalledTimes(1);
      if (eyeType !== 'normal' || effect !== 'none') {
        expect(ctx.fillRect).toHaveBeenCalled();
      } else {
        expect(ctx.fillRect).not.toHaveBeenCalled();
      }
    }
  });
});


test('cleanup permits a fresh engine to remount in the same container', async () => {
  const children = [];
  const container = { appendChild: canvas => children.push(canvas), querySelector: () => children[0] };
  const document = { createElement: () => {
    const canvas = { getContext: () => fakeCtx(), remove: () => children.splice(children.indexOf(canvas), 1) };
    return canvas;
  } };
  const Engine = loadEngine({ document }).VibeMonEngine;
  const first = new Engine(container);
  await first.init();
  const oldCanvas = first.canvas;
  first.cleanup();
  const next = new Engine(container);
  await next.init();
  expect(next.ctx).not.toBeNull();
  expect(next.canvas).not.toBe(oldCanvas);
  expect(children).toEqual([next.canvas]);
  next.cleanup();
  expect(children).toHaveLength(0);
});
