/**
 * VibeMon 3D rendering engine
 *
 * Draws a digital vibe monster with three.js on a transparent WebGL canvas
 * filling the character window. The monster is built entirely from
 * procedural primitives and flat materials — no external models or
 * textures: a squishy egg-shaped body with two horns, big eyes, nub arms, a
 * spade tail, and a "vibe flame" (unlit MeshBasicMaterial, self-lit look)
 * burning above its head. Each state sets a `vibe` energy level that drives
 * the flame's size and flicker plus the tail sway — the session's vibe made
 * visible.
 *
 * Joints are THREE.Group pivots (body, arms, tail chain, flame); each of
 * the 10 registry states blends to a target pose and layers named
 * creature-behavior moves on top (see monster-states.js).
 *
 * Characters are represented as color themes on the same rig
 * (CHARACTER_THEMES), so Character Lock and bridge character switching keep
 * working. Public API mirrors the 2D engine so renderer.js is a drop-in:
 *
 *   const engine = createVibeMonEngine(container, {
 *     characters,       // registry entries (theme fallback for unknown names)
 *     defaultCharacter,
 *     states            // registry entries (unused visually; kept for parity)
 *   });
 *   await engine.init();
 *   engine.setState({ state: 'working', character: 'vibemon' });
 *   engine.render();
 *   engine.startAnimation();
 */

import * as THREE from '../vendor/three.module.min.js';
import {
  JOINTS,
  getStateAnimation,
  getCharacterTheme,
  lerp,
  dampFactor
} from './monster-states.js';

const CONSTANTS = {
  VIEW_WIDTH: 172,
  VIEW_HEIGHT: 160,
  FRAME_INTERVAL_MS: 33,     // ~30fps cap; tray-resident app, keep CPU low
  POSE_DAMP_RATE: 9,         // responsiveness of pose blending (1/s)
  EYE_DAMP_RATE: 18,
  BLINK_PERIOD_S: 3.6,
  BLINK_DURATION_S: 0.14,
  FLOAT_SPEED: 1.1,
  FLOAT_AMPLITUDE: 0.12,
  SWAY_SPEED: 0.5,
  SWAY_AMPLITUDE: 0.05,
  TAIL_SWAY_RATE: 1.6,       // tail sway speed factor per vibe unit
  FLAME_FLICKER_RATE: 6      // flame flicker speed factor per vibe unit
};

// Rest rotations for posable joints; state poses are sparse overrides.
const REST_POSE = {
  root: { x: 0, y: 0, z: 0 },
  body: { x: 0, y: 0, z: 0 },
  armL: { x: 0, y: 0, z: 0.5 },
  armR: { x: 0, y: 0, z: -0.5 },
  tail1: { x: 0, y: 0, z: 0 },
  tail2: { x: 0, y: 0, z: 0 },
  flame: { x: 0, y: 0, z: 0 }
};

// Smoothstep easing for moves that need an eased phase (e.g. twirl).
function smoothstep(u) {
  return u * u * (3 - 2 * u);
}

// Creature-behavior move implementations. Each mutates the rig's joints
// additively after the blended pose has been applied — rotations/positions
// add, scales multiply — so any combination of moves composes. `t` is
// state-speed-scaled time in seconds.
const MOVE_FNS = {
  breathe(t, joints) {
    const s = Math.sin(t * 2);
    joints.body.scale.x *= 1 - s * 0.015;
    joints.body.scale.y *= 1 + s * 0.03;
    joints.body.scale.z *= 1 - s * 0.015;
  },
  lookAround(t, joints) {
    joints.body.rotation.y += Math.sin(t * 0.7) * 0.28;
  },
  ponder(t, joints) {
    joints.body.rotation.z += Math.sin(t * 1.3) * 0.12;
    joints.body.rotation.x += -0.1 + Math.sin(t * 0.9) * 0.05;
  },
  orbitDrift(t, joints) {
    const a = t * 0.9;
    joints.root.position.x += Math.sin(a) * 0.5;
    joints.root.position.z += Math.cos(a) * 0.35;
    joints.body.rotation.y += Math.sin(a) * 0.35;
    joints.body.rotation.z += Math.cos(a) * 0.08;
  },
  pulseFocus(t, joints) {
    const p = 1 + Math.sin(t * 7) * 0.04;
    joints.body.scale.x *= p;
    joints.body.scale.y *= p;
    joints.body.scale.z *= p;
  },
  coil(t, joints) {
    const q = (Math.sin(t * 2.6) + 1) / 2;
    joints.root.scale.x *= 1 + q * 0.06;
    joints.root.scale.y *= 1 - q * 0.13;
    joints.root.scale.z *= 1 + q * 0.06;
    joints.armL.rotation.z -= q * 0.5;
    joints.armR.rotation.z += q * 0.5;
    joints.tail1.rotation.x += q * 0.6;
    joints.tail2.rotation.x += q * 0.8;
  },
  popUp(t, joints) {
    const hop = Math.abs(Math.sin(t * 3.6));
    joints.root.position.y += hop * 0.4;
    joints.body.scale.y *= 1 - (1 - hop) * 0.12;
    joints.body.scale.x *= 1 + (1 - hop) * 0.08;
  },
  twirl(t, joints) {
    // One full eased pirouette per period, holding a beat between spins;
    // the added 2π at the end of each spin wraps back to 0 seamlessly.
    const u = (t % 2.4) / 2.4;
    const e = u < 0.7 ? smoothstep(u / 0.7) : 1;
    joints.body.rotation.y += e * Math.PI * 2;
  },
  hopJoy(t, joints) {
    joints.root.position.y += Math.abs(Math.sin(t * 3.2)) * 0.28;
  },
  wiggle(t, joints) {
    joints.body.rotation.z += Math.sin(t * 5) * 0.12;
  },
  shiver(t, joints) {
    joints.root.position.x += Math.sin(t * 42) * 0.05;
    joints.body.rotation.z += Math.sin(t * 36) * 0.05;
  },
  swell(t, joints) {
    const s = 1 + (Math.sin(t * 2) + 1) * 0.05;
    joints.body.scale.x *= s;
    joints.body.scale.y *= s;
    joints.body.scale.z *= s;
  },
  sink(t, joints) {
    joints.root.position.y += -0.25 + Math.sin(t * 1.1) * 0.04;
  },
  stretch(t, joints) {
    const v = Math.sin(t * 2.2);
    joints.body.scale.x *= 1 - v * 0.04;
    joints.body.scale.y *= 1 + v * 0.1;
    joints.body.scale.z *= 1 - v * 0.04;
    joints.armL.rotation.z += Math.sin(t * 2.2) * 0.3;
    joints.armR.rotation.z -= Math.sin(t * 2.2) * 0.3;
  },
  wave(t, joints) {
    joints.armR.rotation.z += Math.sin(t * 6) * 0.35;
  },
  tailTap(t, joints) {
    joints.tail2.rotation.x += Math.max(0, Math.sin(t * 3.4)) * 0.5;
  },
  scan(t, joints) {
    // Flattened sine: sweeps quickly through center and dwells at each end.
    const s = Math.sin(t * 0.8);
    joints.body.rotation.y += Math.sign(s) * Math.pow(Math.abs(s), 0.35) * 0.45;
  },
  typeKeys(t, joints) {
    // Paws held up forward, alternating downward taps like typing.
    joints.armL.rotation.x += -0.9 + Math.abs(Math.sin(t * 5)) * 0.6;
    joints.armR.rotation.x += -0.9 + Math.abs(Math.cos(t * 5)) * 0.6;
    joints.body.rotation.x += Math.sin(t * 10) * 0.02;
  },
  dartGlance(t, joints) {
    // Steepened sine snaps the gaze from side to side, lingering at each.
    joints.body.rotation.y += Math.tanh(Math.sin(t * 2.4) * 6) * 0.4;
  },
  nod(t, joints) {
    joints.body.rotation.x += (Math.sin(t * 0.9) + 1) * 0.11;
  }
};

// =============================================================================
// VIBE MONSTER RIG
// =============================================================================

/**
 * Builds the jointed vibe monster and returns { group, joints, materials,
 * eyes }. Everything is primitives + flat materials; joints are the Group
 * pivots listed in JOINTS.
 */
function buildMonster() {
  const materials = {
    body: new THREE.MeshToonMaterial({ color: '#8B7CF6' }),
    belly: new THREE.MeshToonMaterial({ color: '#EDE9FF' }),
    accent: new THREE.MeshToonMaterial({ color: '#C4B5FD' }),
    eye: new THREE.MeshToonMaterial({ color: '#241B3A' }),
    blush: new THREE.MeshToonMaterial({ color: '#FF9EC4' }),
    flame: new THREE.MeshBasicMaterial({ color: '#7DF9FF' }),
    white: new THREE.MeshBasicMaterial({ color: '#FFFFFF' })
  };

  const joints = {};
  const root = new THREE.Group();
  joints.root = root;

  // --- Body: squishy egg slime, acts as head+torso in one ---
  const body = new THREE.Group();
  body.position.y = 1.35;
  root.add(body);
  joints.body = body;

  const slime = new THREE.Mesh(new THREE.SphereGeometry(1.25, 26, 20), materials.body);
  slime.position.y = 0.15;
  slime.scale.set(1.02, 1.12, 0.95);
  body.add(slime);

  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.85, 20, 16), materials.belly);
  belly.position.set(0, -0.18, 0.68);
  belly.scale.set(1, 1, 0.5);
  body.add(belly);

  // Horns
  for (const side of [-1, 1]) {
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.5, 10), materials.accent);
    horn.position.set(side * 0.62, 1.38, 0);
    horn.rotation.z = -side * 0.45;
    body.add(horn);
  }

  // Vibe flame: glowing wisp above the head; its joint is scaled/flickered
  // every frame by the state's vibe level.
  const flame = new THREE.Group();
  flame.position.y = 1.58;
  body.add(flame);
  joints.flame = flame;

  const flameOuter = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.55, 10), materials.flame);
  flameOuter.position.y = 0.18;
  flame.add(flameOuter);

  const flameBase = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), materials.flame);
  flameBase.position.y = -0.05;
  flame.add(flameBase);

  // Eyes: big dark eyes with two glints. The whole group Y-scales shut for
  // blinks and a ^ arc swaps in for the happy mode.
  const eyes = { left: {}, right: {} };
  for (const [key, side] of [['left', 1], ['right', -1]]) {
    const eyeGroup = new THREE.Group();
    eyeGroup.position.set(side * 0.5, 0.38, 1.1);
    body.add(eyeGroup);

    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), materials.eye);
    ball.scale.z = 0.5;
    eyeGroup.add(ball);

    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), materials.white);
    glint.position.set(0.07, 0.1, 0.12);
    eyeGroup.add(glint);

    const glint2 = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), materials.white);
    glint2.position.set(-0.07, -0.08, 0.12);
    eyeGroup.add(glint2);

    const happy = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.055, 8, 12, Math.PI), materials.eye);
    happy.position.z = 0.1;
    happy.visible = false;
    eyeGroup.add(happy);

    eyes[key] = { group: eyeGroup, ball, glint, glint2, happy };
  }

  // Cheek blushes
  for (const side of [-1, 1]) {
    const blush = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), materials.blush);
    blush.position.set(side * 0.92, 0.02, 0.88);
    blush.scale.set(1, 0.6, 0.4);
    body.add(blush);
  }

  // Mouth: tiny smile arc
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.05, 8, 12, Math.PI), materials.eye);
  mouth.position.set(0, -0.04, 1.16);
  mouth.rotation.z = Math.PI;
  body.add(mouth);

  // --- Arms: tiny nubs with paws ---
  for (const [suffix, side] of [['L', 1], ['R', -1]]) {
    const arm = new THREE.Group();
    arm.position.set(side * 1.26, -0.2, 0.12);
    body.add(arm);
    joints['arm' + suffix] = arm;

    const nub = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.24, 4, 12), materials.body);
    nub.position.y = -0.15;
    arm.add(nub);

    const paw = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), materials.belly);
    paw.position.y = -0.36;
    arm.add(paw);
  }

  // --- Tail: two-joint chain ending in a spade tip, swaying with the vibe ---
  const tail1 = new THREE.Group();
  tail1.position.set(0, 0.75, -1.0);
  tail1.rotation.x = 2.45;
  body.add(tail1);
  joints.tail1 = tail1;

  const seg1 = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), materials.body);
  seg1.position.y = -0.15;
  tail1.add(seg1);

  const tail2 = new THREE.Group();
  tail2.position.y = -0.4;
  tail1.add(tail2);
  joints.tail2 = tail2;

  const seg2 = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), materials.body);
  seg2.position.y = -0.1;
  tail2.add(seg2);

  const spade = new THREE.Mesh(new THREE.OctahedronGeometry(0.22), materials.accent);
  spade.position.y = -0.35;
  spade.scale.set(1, 1.3, 0.6);
  tail2.add(spade);

  return { group: root, joints, materials, eyes };
}

// =============================================================================
// VIBEMON 3D ENGINE
// =============================================================================

export class VibeMonEngine3D {
  constructor(container, options = {}) {
    this.container = container;
    this.characters = options.characters || {};
    this.defaultCharacter = options.defaultCharacter || Object.keys(this.characters)[0] || null;
    this.states = options.states || {};

    this.currentState = 'start';
    this.currentCharacter = this.defaultCharacter;

    // Blended joint rotations, initialized at rest.
    this.pose = {};
    for (const joint of JOINTS) {
      this.pose[joint] = { ...REST_POSE[joint] };
    }
    this.eyeOpenness = 1;
    this.eyeScale = 1;
    // Vibe level blends smoothly so the flame doesn't jump between states.
    this.vibeLevel = 1;

    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.rig = null;

    this.t = 0;
    this.lastFrameTime = 0;
    this.animationRunning = false;
    this.animationFrameId = null;
    this.boundAnimationLoop = this._animationLoop.bind(this);
  }

  init() {
    if (this.renderer || !this.container) return this;

    const width = this.container.clientWidth || CONSTANTS.VIEW_WIDTH;
    const height = this.container.clientHeight || CONSTANTS.VIEW_HEIGHT;

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(width, height);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.className = 'vibemon-canvas-3d';
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 100);
    this.camera.position.set(0, 2.0, 8.8);
    this.camera.lookAt(0, 1.85, 0);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x667799, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(3, 6, 5);
    this.scene.add(sun);

    this.rig = buildMonster();
    this.scene.add(this.rig.group);
    this._applyTheme(this.currentCharacter);

    return this;
  }

  setState(data) {
    if (!data || typeof data !== 'object') return;

    if (data.state !== undefined) this.currentState = data.state;
    if (data.character !== undefined) {
      const next = this.characters[data.character] ? data.character : this.defaultCharacter;
      if (next !== this.currentCharacter) {
        this.currentCharacter = next;
        this._applyTheme(next);
      }
    }
  }

  render() {
    if (!this.renderer) return;
    this._applyFrame(0);
    this.renderer.render(this.scene, this.camera);
  }

  _applyTheme(name) {
    if (!this.rig) return;
    const theme = getCharacterTheme(name, this.characters[name]);
    this.rig.materials.body.color.set(theme.body);
    this.rig.materials.belly.color.set(theme.belly);
    this.rig.materials.accent.color.set(theme.accent);
    this.rig.materials.eye.color.set(theme.eye);
    this.rig.materials.blush.color.set(theme.blush);
    this.rig.materials.flame.color.set(theme.flame);
  }

  _applyFrame(dt) {
    const joints = this.rig.joints;
    const anim = getStateAnimation(this.currentState);
    const t = this.t;
    const poseBlend = dampFactor(CONSTANTS.POSE_DAMP_RATE, dt);

    // Blend joints toward the state's target pose, then write rotations.
    for (const joint of JOINTS) {
      const rest = REST_POSE[joint];
      const target = anim.pose[joint] || {};
      const current = this.pose[joint];
      for (const axis of ['x', 'y', 'z']) {
        const goal = target[axis] !== undefined ? target[axis] : rest[axis];
        current[axis] = lerp(current[axis], goal, poseBlend);
      }
      joints[joint].rotation.set(current.x, current.y, current.z);
    }

    // Reset the frame-transient transforms the moves layer onto.
    joints.root.position.set(0, 0, 0);
    joints.root.scale.set(1, 1, 1);
    joints.body.scale.set(1, 1, 1);

    // Always-on floating + gentle sway.
    joints.root.position.y += Math.sin(t * CONSTANTS.FLOAT_SPEED) * CONSTANTS.FLOAT_AMPLITUDE;
    joints.root.rotation.y += Math.sin(t * CONSTANTS.SWAY_SPEED) * CONSTANTS.SWAY_AMPLITUDE;

    // Vibe level (blended): tail sway + flame size/flicker.
    this.vibeLevel = lerp(this.vibeLevel, anim.vibe, poseBlend);
    const vibe = this.vibeLevel;

    const tv = t * vibe * CONSTANTS.TAIL_SWAY_RATE;
    joints.tail1.rotation.y += Math.sin(tv) * 0.3;
    joints.tail2.rotation.y += Math.sin(tv - 0.7) * 0.25;

    const flameSize = 0.55 + vibe * 0.45;
    const flicker = 1 + Math.sin(t * vibe * CONSTANTS.FLAME_FLICKER_RATE) * 0.15;
    joints.flame.scale.set(flameSize * 0.9, flameSize * flicker, flameSize * 0.9);
    joints.flame.rotation.z += Math.sin(t * vibe * 5) * 0.08;

    for (const move of anim.moves) {
      const fn = MOVE_FNS[move];
      if (fn) fn(t, joints);
      else console.warn(`VibeMon 3D engine: unknown move "${move}"`);
    }

    // Eyes: openness (blink/closed) + happy arcs + wide-eye scaling.
    let openTarget = anim.eye === 'closed' ? 0 : 1;
    if (anim.blink && openTarget === 1) {
      const phase = t % CONSTANTS.BLINK_PERIOD_S;
      if (phase > CONSTANTS.BLINK_PERIOD_S - CONSTANTS.BLINK_DURATION_S) openTarget = 0;
    }
    const eyeBlend = dampFactor(CONSTANTS.EYE_DAMP_RATE, dt);
    this.eyeOpenness = lerp(this.eyeOpenness, openTarget, eyeBlend);
    this.eyeScale = lerp(this.eyeScale, anim.eyeScale, eyeBlend);

    const happy = anim.eye === 'happy';
    for (const key of ['left', 'right']) {
      const eye = this.rig.eyes[key];
      const openY = Math.max(this.eyeOpenness, 0.08);
      eye.group.scale.set(this.eyeScale, this.eyeScale * openY, this.eyeScale);
      eye.ball.visible = !happy;
      eye.glint.visible = !happy;
      eye.glint2.visible = !happy;
      eye.happy.visible = happy;
    }
  }

  _animationLoop(timestamp) {
    if (!this.animationRunning) return;

    if (timestamp - this.lastFrameTime < CONSTANTS.FRAME_INTERVAL_MS) {
      this.animationFrameId = requestAnimationFrame(this.boundAnimationLoop);
      return;
    }

    const dt = this.lastFrameTime
      ? Math.min((timestamp - this.lastFrameTime) / 1000, 0.1)
      : CONSTANTS.FRAME_INTERVAL_MS / 1000;
    this.lastFrameTime = timestamp;

    const anim = getStateAnimation(this.currentState);
    this.t += dt * anim.speed;

    this._applyFrame(dt);
    this.renderer.render(this.scene, this.camera);

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
    if (this.scene) {
      this.scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
      });
    }
    if (this.rig) {
      for (const mat of Object.values(this.rig.materials)) mat.dispose();
    }
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
  }
}

// =============================================================================
// FACTORY AND EXPORTS
// =============================================================================

export function createVibeMonEngine(container, options = {}) {
  return new VibeMonEngine3D(container, options);
}

export { CONSTANTS, REST_POSE, MOVE_FNS };
