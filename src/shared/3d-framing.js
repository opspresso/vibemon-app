// Fit projected geometry about the camera center, preserving the rig's
// movement. The viewport uses native CSS pixels, including rounded sizes.
export function compute3DFrame({ maxX, maxY, canvasWidth, canvasHeight, viewportWidth, viewportHeight, displayScale, padding }) {
  if (!(canvasWidth > 0 && canvasHeight > 0 && viewportWidth > 0 && viewportHeight > 0 && displayScale > 0)) return null;
  const inset = Math.min(padding, viewportWidth / 4, viewportHeight / 4);
  const zoom = Math.min(
    maxX > 0 ? (viewportWidth - inset * 2) / (maxX * canvasWidth * displayScale) : Infinity,
    maxY > 0 ? (viewportHeight - inset * 2) / (maxY * canvasHeight * displayScale) : Infinity
  );
  if (!Number.isFinite(zoom) || zoom <= 0) return null;
  return {
    zoom,
    x: viewportWidth / (2 * displayScale) - canvasWidth * zoom / 2,
    y: viewportHeight / (2 * displayScale) - canvasHeight * zoom / 2
  };
}

// Three.js updates world/camera matrices before Scene.onBeforeRender. Fit
// this app's canvas presentation to the current pose without changing the
// canonical engine's camera, rig, or animation loop.
export function install3DFraming(engine, container, THREE, padding) {
  const { scene, camera, renderer } = engine;
  const canvas = renderer.domElement;
  const projection = new THREE.Matrix4();
  const matrix = new THREE.Matrix4();
  const point = new THREE.Vector3();
  const previous = scene.onBeforeRender;
  const onBeforeRender = function (...args) {
    previous.apply(this, args);
    projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    let maxX = 0, maxY = 0;
    scene.traverseVisible(object => {
      const positions = object.geometry?.attributes.position;
      if (!positions) return;
      matrix.multiplyMatrices(projection, object.matrixWorld);
      for (let i = 0; i < positions.count; i++) {
        point.fromBufferAttribute(positions, i).applyMatrix4(matrix);
        maxX = Math.max(maxX, Math.abs(point.x));
        maxY = Math.max(maxY, Math.abs(point.y));
      }
    });
    const frame = compute3DFrame({
      maxX, maxY, canvasWidth: container.clientWidth, canvasHeight: container.clientHeight,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
      displayScale: container.getBoundingClientRect().width / container.clientWidth,
      padding
    });
    if (frame) canvas.style.setProperty('--vibemon-3d-transform', `matrix(${frame.zoom}, 0, 0, ${frame.zoom}, ${frame.x}, ${frame.y})`);
  };
  scene.onBeforeRender = onBeforeRender;
  return () => {
    if (scene.onBeforeRender === onBeforeRender) scene.onBeforeRender = previous;
    canvas.style.removeProperty('--vibemon-3d-transform');
  };
}
