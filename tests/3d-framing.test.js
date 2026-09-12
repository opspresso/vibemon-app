const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const THREE = require('three');

function loadFraming() {
  const window = { innerWidth: 134, innerHeight: 138 };
  const sandbox = { window };
  const source = fs.readFileSync(path.join(__dirname, '../src/shared/3d-framing.js'), 'utf8').replaceAll('export function ', 'function ');
  vm.runInNewContext(source + '\nthis.result = { compute3DFrame, install3DFraming };', sandbox);
  return { ...sandbox.result, window };
}

describe('compute3DFrame', () => {
  test.each([[134, 138, 1, 0.53, 0.76], [40, 41, 0.3, 0.53, 0.76], [12, 13, 0.09, 0.53, 0.76], [1, 1, 0.005, 0.53, 0.76], [134, 138, 1, 0.85, 0.4]])('maximizes the pose inside a %s × %s viewport at scale %s with extent %s/%s', (width, height, scale, maxX, maxY) => {
    const { compute3DFrame } = loadFraming();
    const frame = compute3DFrame({ maxX, maxY, canvasWidth: 134, canvasHeight: 138, viewportWidth: width, viewportHeight: height, displayScale: scale, padding: 2 });
    const inset = Math.min(2, width / 4, height / 4);
    const centerX = (67 * frame.zoom + frame.x) * scale;
    const centerY = (69 * frame.zoom + frame.y) * scale;
    expect(centerX).toBeCloseTo(width / 2);
    expect(centerY).toBeCloseTo(height / 2);
    const extentX = maxX * 67 * frame.zoom * scale;
    const extentY = maxY * 69 * frame.zoom * scale;
    expect(centerX - extentX).toBeGreaterThanOrEqual(inset - 1e-9);
    expect(centerY - extentY).toBeGreaterThanOrEqual(inset - 1e-9);
    expect(centerX + extentX).toBeLessThanOrEqual(width - inset + 1e-9);
    expect(centerY + extentY).toBeLessThanOrEqual(height - inset + 1e-9);
    // Any further enlargement would violate the requested padding.
    expect(extentX * 1.001 > width / 2 - inset || extentY * 1.001 > height / 2 - inset).toBe(true);
  });

  test('does not produce invalid transforms for empty or hidden viewports', () => {
    const { compute3DFrame } = loadFraming();
    const input = { maxX: 0.5, maxY: 0.5, canvasWidth: 134, canvasHeight: 138, viewportWidth: 134, viewportHeight: 138, displayScale: 1, padding: 2 };
    expect(compute3DFrame({ ...input, maxX: 0, maxY: 0 })).toBeNull();
    expect(compute3DFrame({ ...input, viewportWidth: 0 })).toBeNull();
    expect(compute3DFrame({ ...input, displayScale: 0 })).toBeNull();
  });
});

describe('install3DFraming', () => {
  test('fits each visible pose before rendering without changing its camera or animation transforms', () => {
    const { install3DFraming } = loadFraming();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 134 / 138, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.updateMatrixWorld();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 1));
    scene.add(mesh);
    const invisible = new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000));
    invisible.visible = false;
    scene.add(invisible);
    const properties = new Map();
    const canvas = { style: { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) } };
    const container = { clientWidth: 134, clientHeight: 138, getBoundingClientRect: () => ({ width: 134 }) };
    const previous = jest.fn();
    scene.onBeforeRender = previous;
    const cleanup = install3DFraming({ scene, camera, renderer: { domElement: canvas } }, container, THREE, 2);
    const zoom = () => Number(properties.get('--vibemon-3d-transform').match(/matrix\(([^,]+)/)[1]);
    scene.updateMatrixWorld(true);
    scene.onBeforeRender();
    const first = zoom();
    expect(first).toBeGreaterThan(1);
    mesh.scale.set(2, 2, 2);
    scene.updateMatrixWorld(true);
    scene.onBeforeRender();
    expect(zoom()).toBeLessThan(first);
    expect(mesh.scale.toArray()).toEqual([2, 2, 2]);
    expect(camera.position.toArray()).toEqual([0, 0, 10]);
    expect(camera.zoom).toBe(1);
    expect(previous).toHaveBeenCalledTimes(2);
    cleanup();
    expect(scene.onBeforeRender).toBe(previous);
    expect(properties.size).toBe(0);
  });
});
