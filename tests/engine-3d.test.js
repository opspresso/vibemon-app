/**
 * Tests for the 3D rendering engine (src/engine/vibemon-engine-3d.js).
 *
 * Loaded like tests/engine.test.js: the ES module source is read,
 * import/export-stripped, and evaluated in a vm sandbox. State definitions
 * are real, and rig tests supply the installed three.js geometry/materials.
 * State and move tests use fake joints. None needs a WebGL context.
 */

const { loadBrowserModule } = require('./helpers/browser-module.cjs');
const charactersRegistry = require('../src/shared/data/characters.json');

const monsterStates = loadBrowserModule('src/engine/monster-states.js', [
  'JOINTS', 'MOVES', 'STATE_ANIMATIONS', 'DEFAULT_THEME', 'getStateAnimation', 'getCharacterTheme', 'lerp', 'dampFactor'
]);
const companion = loadBrowserModule('src/engine/vibemon-companion.mjs', [
  'COMPANION_SIZE', 'COMPANION_OUTLINE', 'COMPANION_EYES'
]);

const { VibeMonEngine3D, createVibeMonEngine, CONSTANTS, REST_POSE, MOVE_FNS, buildMonster } = loadBrowserModule(
  'src/engine/vibemon-engine-3d.js',
  ['VibeMonEngine3D', 'createVibeMonEngine', 'CONSTANTS', 'REST_POSE', 'MOVE_FNS', 'buildMonster'],
  { ...monsterStates, ...companion }
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
  test('one engine keeps its graphics dependency when another engine is created', () => {
    const library = require('three');
    const first = { ...library, MeshToonMaterial: class FirstMaterial extends library.MeshToonMaterial {} };
    const second = { ...library, MeshToonMaterial: class SecondMaterial extends library.MeshToonMaterial {} };
    const engine = createVibeMonEngine(null, { THREE: first, characters: charactersRegistry.characters, defaultCharacter: 'vibemon' });
    engine.scene = new library.Scene();
    engine.rig = buildMonster(first, true);
    engine.scene.add(engine.rig.group);
    const other = createVibeMonEngine(null, { THREE: second, characters: charactersRegistry.characters });
    try {
      engine.setState({ character: 'clawd' });
      expect(engine.rig.materials.body).toBeInstanceOf(first.MeshToonMaterial);
      expect(engine.rig.materials.body).not.toBeInstanceOf(second.MeshToonMaterial);
    } finally { engine.cleanup(); other.cleanup(); }
  });
  test('the V companion uses matching face anchors and switching disposes its geometry', () => {
    const THREE = require('three');
    const engine = createVibeMonEngine(null, { THREE, characters: charactersRegistry.characters, defaultCharacter: 'vibemon' });
    engine.scene = new THREE.Scene();
    engine.rig = buildMonster(THREE, true);
    engine.scene.add(engine.rig.group);
    const face = engine.rig;
    expect(face.eyes.left.group.position.toArray()).toEqual([-0.45, -0.2, 0.37]);
    expect(face.eyes.right.group.position.toArray()).toEqual([0.45, -0.2, 0.37]);
    const geometry = face.joints.body.children.find(child => child.geometry?.type === 'ExtrudeGeometry').geometry;
    const disposed = jest.spyOn(geometry, 'dispose');
    engine.setState({ character: 'clawd' });
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(engine.rig.attentive).toBe(false);
    expect(engine.scene.children).toEqual([engine.rig.group]);
    const previous = engine.rig;
    engine.setState({ character: 'codex' });
    expect(engine.rig).toBe(previous);
    engine.setState({ character: 'vibemon', state: 'sleep' });
    expect(engine.rig.attentive).toBe(true);
    expect(engine.scene.children).toEqual([engine.rig.group]);
    engine._applyFrame(1);
    expect(engine.rig.eyes.left.group.scale.y).toBeLessThan(0.1);
    expect(engine.rig.eyes.left.glint.visible).toBe(false);
    expect(engine.rig.eyes.right.glint2.visible).toBe(false);
    engine.cleanup();
    expect(engine.scene.children).toHaveLength(0);
  });
  test('reduced motion uses the current state pose without time-driven movement', () => {
    const { Group } = require('three');
    const engine = makeEngine();
    engine.rig = {
      joints: Object.fromEntries(monsterStates.JOINTS.map(joint => [joint, new Group()])),
      eyes: Object.fromEntries(['left', 'right'].map(key => [key, { group: new Group(), ball: {}, glint: {}, glint2: {}, happy: {} }]))
    };
    engine.renderer = { render: jest.fn() };
    engine.setReducedMotion(true);
    engine.setState({ state: 'sleep' }); engine.render();
    const frame = () => Object.values(engine.rig.joints).map(joint => [...joint.position.toArray(), ...joint.rotation.toArray(), ...joint.scale.toArray()]);
    const still = frame();
    engine.t = 100; engine.render();
    expect(frame()).toEqual(still);
    expect(engine.eyeOpenness).toBe(0);
    engine.setState({ state: 'working' }); engine.render();
    expect(engine.eyeOpenness).toBe(1);
    expect(frame()).not.toEqual(still);
  });
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
