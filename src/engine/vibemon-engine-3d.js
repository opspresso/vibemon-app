/**
 * VibeMon 3D rendering engine
 *
 * Draws an articulated monster with three.js on a transparent WebGL canvas
 * filling the character window. The monster is built entirely from
 * procedural primitives and flat toon materials — no external models or
 * textures. Joints are THREE.Group pivots (head, shoulders, elbows, legs,
 * tail chain); each of the 10 registry states blends to a target pose and
 * layers named procedural moves on top (see monster-states.js).
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
  FLOAT_AMPLITUDE: 0.1,
  SWAY_SPEED: 0.5,
  SWAY_AMPLITUDE: 0.06
};

// Rest rotations for posable joints; state poses are sparse overrides.
const REST_POSE = {
  root: { x: 0, y: 0, z: 0 },
  torso: { x: 0, y: 0, z: 0 },
  head: { x: 0, y: 0, z: 0 },
  armL: { x: 0, y: 0, z: 0.35 },
  armR: { x: 0, y: 0, z: -0.35 },
  elbowL: { x: -0.15, y: 0, z: 0 },
  elbowR: { x: -0.15, y: 0, z: 0 },
  legL: { x: 0, y: 0, z: 0 },
  legR: { x: 0, y: 0, z: 0 }
};

// Procedural move implementations. Each mutates the rig's joints additively
// after the blended pose has been applied. `t` is state-speed-scaled time in
// seconds.
const MOVE_FNS = {
  breathe(t, joints) {
    const s = Math.sin(t * 2);
    joints.torso.scale.set(1 - s * 0.015, 1 + s * 0.035, 1 - s * 0.015);
  },
  bounce(t, joints) {
    joints.root.position.y += Math.abs(Math.sin(t * 2.6)) * 0.22;
  },
  wave(t, joints) {
    joints.elbowR.rotation.z += Math.sin(t * 7) * 0.45;
  },
  tilt(t, joints) {
    joints.head.rotation.z += Math.sin(t * 1.6) * 0.14;
  },
  nod(t, joints) {
    joints.head.rotation.x += Math.sin(t * 2.4) * 0.12;
  },
  conduct(t, joints) {
    joints.elbowR.rotation.x += Math.sin(t * 3.2) * 0.5;
    joints.armR.rotation.x += Math.cos(t * 3.2) * 0.25;
  },
  typing(t, joints) {
    joints.elbowL.rotation.x += -0.6 + Math.sin(t * 13) * 0.35;
    joints.elbowR.rotation.x += -0.6 + Math.sin(t * 13 + Math.PI) * 0.35;
  },
  squash(t, joints) {
    const s = Math.sin(t * 2.8);
    joints.root.scale.set(1 - s * 0.05, 1 + s * 0.1, 1 - s * 0.05);
  },
  gather(t, joints) {
    const s = Math.sin(t * 2.6) * 0.5 + 0.3;
    joints.armL.rotation.z += s;
    joints.armR.rotation.z -= s;
  },
  hop(t, joints) {
    const ph = Math.abs(Math.sin(t * 3.4));
    joints.root.position.y += ph * 0.3;
    joints.legL.rotation.x -= ph * 0.5;
    joints.legR.rotation.x -= ph * 0.5;
  },
  tremble(t, joints) {
    joints.root.position.x += Math.sin(t * 42) * 0.045;
    joints.head.rotation.z += Math.sin(t * 37) * 0.05;
  }
};

// =============================================================================
// MONSTER RIG
// =============================================================================

/**
 * Builds the jointed pet and returns { group, joints, materials, eyes,
 * tailSegments }. Kawaii proportions: one blob-like silhouette (the huge
 * head overlaps the squat body, no neck gap), big glossy wide-spaced eyes
 * set low on the face, small rounded ears, stubby limbs and a chubby tail.
 * Everything is primitives + flat materials; joints are the Group pivots
 * listed in JOINTS plus the procedural tail chain.
 */
function buildMonster() {
  const materials = {
    body: new THREE.MeshToonMaterial({ color: '#B79CFA' }),
    belly: new THREE.MeshToonMaterial({ color: '#EFE9FF' }),
    accent: new THREE.MeshToonMaterial({ color: '#7C5CD6' }),
    eye: new THREE.MeshToonMaterial({ color: '#2B2140' }),
    blush: new THREE.MeshToonMaterial({ color: '#FFA7C4' }),
    white: new THREE.MeshToonMaterial({ color: '#FFFFFF' })
  };

  const joints = {};
  const root = new THREE.Group();
  joints.root = root;

  const hips = new THREE.Group();
  hips.position.y = 0.85;
  root.add(hips);

  // --- Torso: squat body, mostly hidden behind the huge head ---
  const torso = new THREE.Group();
  joints.torso = torso;
  hips.add(torso);

  const body = new THREE.Mesh(new THREE.SphereGeometry(1.2, 24, 18), materials.body);
  body.position.y = 0.5;
  body.scale.set(1.05, 0.95, 0.95);
  torso.add(body);

  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.8, 20, 16), materials.belly);
  belly.position.set(0, 0.42, 0.72);
  belly.scale.set(1, 0.95, 0.55);
  torso.add(belly);

  // --- Head: dominates the silhouette, overlapping the body (no neck) ---
  const neck = new THREE.Group();
  neck.position.y = 1.15;
  torso.add(neck);

  const head = new THREE.Group();
  joints.head = head;
  neck.add(head);

  const skull = new THREE.Mesh(new THREE.SphereGeometry(1.45, 28, 22), materials.body);
  skull.position.y = 1.1;
  skull.scale.set(1.02, 0.95, 0.98);
  head.add(skull);

  // Small rounded ears with a soft inner
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), materials.body);
    ear.position.set(side * 0.85, 2.25, -0.1);
    ear.scale.set(0.75, 1, 0.45);
    ear.rotation.z = -side * 0.35;
    head.add(ear);

    const inner = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 10), materials.accent);
    inner.position.set(side * 0.87, 2.22, 0.08);
    inner.scale.set(0.6, 0.85, 0.35);
    inner.rotation.z = -side * 0.35;
    head.add(inner);
  }

  // Eyes: big glossy wide-spaced eyes set low on the face, with a large and
  // a small glint. The whole group Y-scales shut for blinks and a ^ arc
  // swaps in for the happy mode.
  const eyes = { left: {}, right: {} };
  for (const [key, side] of [['left', 1], ['right', -1]]) {
    const eyeGroup = new THREE.Group();
    eyeGroup.position.set(side * 0.58, 0.82, 1.32);
    head.add(eyeGroup);

    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.3, 18, 14), materials.eye);
    ball.scale.z = 0.5;
    eyeGroup.add(ball);

    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), materials.white);
    glint.position.set(0.09, 0.11, 0.16);
    eyeGroup.add(glint);

    const glint2 = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), materials.white);
    glint2.position.set(-0.08, -0.09, 0.16);
    eyeGroup.add(glint2);

    const happy = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.06, 8, 12, Math.PI), materials.eye);
    happy.position.z = 0.1;
    happy.visible = false;
    eyeGroup.add(happy);

    eyes[key] = { group: eyeGroup, ball, glint, glint2, happy };
  }

  // Big soft cheek blushes, right under the eyes
  for (const side of [-1, 1]) {
    const blush = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), materials.blush);
    blush.position.set(side * 0.98, 0.45, 1.02);
    blush.scale.set(1, 0.6, 0.4);
    head.add(blush);
  }

  // Mouth: tiny smile arc tucked close to the eyes
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.05, 8, 12, Math.PI), materials.eye);
  mouth.position.set(0, 0.52, 1.38);
  mouth.rotation.z = Math.PI;
  head.add(mouth);

  // --- Arms: stubby paw nubs (shoulder + elbow joints kept for posing) ---
  for (const [suffix, side] of [['L', 1], ['R', -1]]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 1.1, 0.6, 0.15);
    torso.add(shoulder);
    joints['arm' + suffix] = shoulder;

    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.18, 4, 12), materials.body);
    upper.position.y = -0.14;
    shoulder.add(upper);

    const elbow = new THREE.Group();
    elbow.position.y = -0.38;
    shoulder.add(elbow);
    joints['elbow' + suffix] = elbow;

    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.12, 4, 12), materials.body);
    fore.position.y = -0.08;
    elbow.add(fore);

    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 12), materials.belly);
    hand.position.y = -0.26;
    elbow.add(hand);
  }

  // --- Legs: tiny round feet peeking out under the blob ---
  for (const [suffix, side] of [['L', 1], ['R', -1]]) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.5, -0.72, 0.12);
    hips.add(hip);
    joints['leg' + suffix] = hip;

    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.1, 4, 12), materials.body);
    leg.position.y = -0.05;
    hip.add(leg);

    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.26, 14, 12), materials.body);
    foot.position.set(0, -0.2, 0.1);
    foot.scale.set(1.05, 0.6, 1.2);
    hip.add(foot);
  }

  // --- Tail: chubby puff chain curling up behind, light tip, animated
  // procedurally as a chain of joints ---
  const tailSegments = [];
  let parent = new THREE.Group();
  parent.position.set(0, -0.35, -1.0);
  parent.rotation.x = 2.5;
  hips.add(parent);
  tailSegments.push(parent);

  const radii = [0.28, 0.22];
  for (let i = 0; i < radii.length; i++) {
    const seg = new THREE.Group();
    seg.position.y = -0.34;
    parent.add(seg);

    const isTip = i === radii.length - 1;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radii[i], 14, 12),
      isTip ? materials.belly : materials.body
    );
    mesh.position.y = -0.08;
    seg.add(mesh);

    tailSegments.push(seg);
    parent = seg;
  }

  return { group: root, joints, materials, eyes, tailSegments };
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
    this.camera.position.set(0, 2.5, 9.8);
    this.camera.lookAt(0, 2.3, 0);

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
    joints.torso.scale.set(1, 1, 1);

    // Always-on floating + gentle sway, then the state's moves.
    joints.root.position.y += Math.sin(t * CONSTANTS.FLOAT_SPEED) * CONSTANTS.FLOAT_AMPLITUDE;
    joints.root.rotation.y += Math.sin(t * CONSTANTS.SWAY_SPEED) * CONSTANTS.SWAY_AMPLITUDE;
    for (const move of anim.moves) {
      const fn = MOVE_FNS[move];
      if (fn) fn(t, joints);
      else console.warn(`VibeMon 3D engine: unknown move "${move}"`);
    }

    // Tail wave, speed scaled per state. The base segment carries a resting
    // sideways curl so the fluffy tip peeks out beside the body.
    const tailT = t * anim.tailSpeed * 2.2;
    this.rig.tailSegments.forEach((seg, i) => {
      seg.rotation.z = (i === 0 ? 0.35 : 0) + Math.sin(tailT - i * 0.7) * 0.28;
    });

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
