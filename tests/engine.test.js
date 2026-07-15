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

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { STATE_CONFIG, VALID_STATES } = require('../src/shared/states.cjs');
const charactersRegistry = require('../src/shared/data/characters.json');

function loadEngine() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'engine', 'vibemon-engine.js'),
    'utf8'
  )
    .replace(/export class /g, 'class ')
    .replace(/export function /g, 'function ')
    .replace(/export \{[^}]*\};?/g, '')
    + '\nmodule.exports = { VibeMonEngine, CONSTANTS, CharacterRenderer };';

  const mod = { exports: {} };
  vm.runInNewContext(src, { module: mod, exports: mod.exports, console });
  return mod.exports;
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
