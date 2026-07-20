/**
 * Tests for the 3D rendering engine (src/engine/vibemon-engine-3d.js).
 *
 * Loaded like tests/engine.test.js: the ES module source is read,
 * import/export-stripped, and evaluated in a vm sandbox. The three.js import
 * is replaced with an empty stub and the monster-states imports with the
 * real definitions (loaded via their own sandbox) — enough to exercise the
 * state/character selection logic and the move implementations against a
 * fake rig, without a WebGL context.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const charactersRegistry = require('../src/shared/data/characters.json');

function loadModule(relPath, sandbox, exportNames) {
  const src = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(/import[^;]*;/g, '')
    .replace(/^export /gm, '')
    + `\nmodule.exports = { ${exportNames.join(', ')} };`;

  const mod = { exports: {} };
  vm.runInNewContext(src, { module: mod, exports: mod.exports, console, ...sandbox });
  return mod.exports;
}

const monsterStates = loadModule('src/engine/monster-states.js', {}, [
  'JOINTS', 'MOVES', 'STATE_ANIMATIONS', 'getStateAnimation', 'getCharacterTheme', 'lerp', 'dampFactor'
]);

const { VibeMonEngine3D, CONSTANTS, REST_POSE, MOVE_FNS } = loadModule(
  'src/engine/vibemon-engine-3d.js',
  { THREE: {}, ...monsterStates },
  ['VibeMonEngine3D', 'CONSTANTS', 'REST_POSE', 'MOVE_FNS']
);

// container=null: the constructor doesn't touch the DOM; init() (which does)
// is deliberately never called here.
function makeEngine() {
  return new VibeMonEngine3D(null, {
    characters: charactersRegistry.characters,
    defaultCharacter: charactersRegistry.default
  });
}

function fakeJoint() {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, set() {} },
    scale: { x: 1, y: 1, z: 1, set() {} }
  };
}

describe('engine state/character selection', () => {
  test('setState updates state and keeps known characters', () => {
    const engine = makeEngine();
    engine.setState({ state: 'working', character: 'kiro' });
    expect(engine.currentState).toBe('working');
    expect(engine.currentCharacter).toBe('kiro');
  });

  test('unknown characters fall back to the registry default', () => {
    const engine = makeEngine();
    engine.setState({ character: 'nope' });
    expect(engine.currentCharacter).toBe(charactersRegistry.default);
  });

  test('invalid payloads are ignored', () => {
    const engine = makeEngine();
    engine.setState(null);
    engine.setState('working');
    expect(engine.currentState).toBe('start');
  });
});

describe('rig conformance', () => {
  test('every declared move has an implementation', () => {
    for (const move of monsterStates.MOVES) {
      expect(typeof MOVE_FNS[move]).toBe('function');
    }
  });

  test('every posable joint has a rest pose', () => {
    for (const joint of monsterStates.JOINTS) {
      expect(REST_POSE[joint]).toBeDefined();
    }
  });

  test('every move implementation runs against the rig joints', () => {
    const rig = Object.fromEntries(monsterStates.JOINTS.map((j) => [j, fakeJoint()]));
    for (const move of monsterStates.MOVES) {
      expect(() => MOVE_FNS[move](1.23, rig)).not.toThrow();
    }
  });

  test('pose blending starts from the rest pose', () => {
    const engine = makeEngine();
    for (const joint of monsterStates.JOINTS) {
      expect(engine.pose[joint]).toEqual(REST_POSE[joint]);
    }
  });

  test('frame interval caps the loop at ~30fps', () => {
    expect(CONSTANTS.FRAME_INTERVAL_MS).toBeGreaterThanOrEqual(33);
  });
});
