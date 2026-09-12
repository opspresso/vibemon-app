// Map CSS coordinates through the canvas's current transform and backing size.
export function createCharacterHitTest(engine) {
  const sample = document.createElement('canvas');
  sample.width = sample.height = 1;
  const context = sample.getContext('2d', { willReadFrequently: true });
  return (x, y) => {
    const canvas = engine.canvas || engine.renderer?.domElement;
    if (!canvas) return false;
    // Rendering can update the adaptive 3D canvas transform. Read its bounds
    // afterwards, while the WebGL drawing buffer is still available.
    if (engine.renderer) engine.renderer.render(engine.scene, engine.camera);
    const rect = canvas.getBoundingClientRect();
    if (x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom || !rect.width || !rect.height) return false;
    context.clearRect(0, 0, 1, 1);
    context.drawImage(canvas,
      Math.floor((x - rect.left) * canvas.width / rect.width),
      Math.floor((y - rect.top) * canvas.height / rect.height), 1, 1,
      0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3] > 0;
  };
}

export function hitTestBubble(bubble, x, y) {
  const rect = bubble.getBoundingClientRect();
  const scale = bubble.offsetWidth ? rect.width / bubble.offsetWidth : 1;
  const radius = Math.min(10 * scale, rect.width / 2, rect.height / 2);
  if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) {
    const cx = Math.max(rect.left + radius, Math.min(rect.right - radius, x));
    const cy = Math.max(rect.top + radius, Math.min(rect.bottom - radius, y));
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  }
  const tail = bubble.querySelector('.bubble-tail');
  const t = tail.getBoundingClientRect();
  if (x < t.left || x > t.right || y < t.top || y > t.bottom) return false;
  if (tail.classList.contains('tail-bottom')) return Math.abs(x - (t.left + t.right) / 2) <= t.bottom - y;
  if (tail.classList.contains('tail-top')) return Math.abs(x - (t.left + t.right) / 2) <= y - t.top;
  if (tail.classList.contains('tail-left')) return Math.abs(y - (t.top + t.bottom) / 2) <= x - t.left;
  return Math.abs(y - (t.top + t.bottom) / 2) <= t.right - x;
}

export function installWindowInteraction({ hitTest, onInteraction = () => {} }) {
  const api = window.electronAPI;
  let pointer = null;
  let held = null;
  let origin = null;
  let moved = false;
  let ignored = true;
  let frame;
  const listeners = [];
  const listen = (target, name, handler) => {
    target.addEventListener(name, handler);
    listeners.push(() => target.removeEventListener(name, handler));
  };
  const refresh = () => {
    const ignore = held === null && (!pointer || !hitTest(pointer.x, pointer.y));
    if (ignore !== ignored) {
      ignored = ignore;
      api.setIgnoreMouseEvents(ignore);
    }
  };
  const remember = (event) => {
    pointer = { x: event.clientX, y: event.clientY };
  };
  const end = () => {
    if (held === null) return;
    const id = held;
    held = null;
    if (document.documentElement.hasPointerCapture(id)) document.documentElement.releasePointerCapture(id);
    api.endWindowDrag();
    onInteraction(false);
    refresh();
  };
  const cleanupPointer = api.onWindowPointer?.((point) => {
    if (point?.x === pointer?.x && point?.y === pointer?.y) return;
    pointer = point;
    refresh();
  });
  // Electron's forwarding option explicitly forwards mousemove events.
  listen(document, 'mousemove', (event) => {
    remember(event);
    refresh();
  });
  listen(document, 'pointerdown', (event) => {
    if (held !== null || event.isPrimary === false || event.button !== 0 || !hitTest(event.clientX, event.clientY)) return;
    remember(event);
    held = event.pointerId;
    origin = { x: event.screenX, y: event.screenY };
    moved = false;
    document.documentElement.setPointerCapture(held);
    refresh();
    onInteraction(true);
    api.beginWindowDrag();
  });
  listen(document, 'pointermove', (event) => {
    if (event.isPrimary === false || (held !== null && event.pointerId !== held)) return;
    remember(event);
    if (held === null) return;
    if ((event.buttons & 1) === 0) { end(); return; }
    if (Math.abs(event.screenX - origin.x) > 4 || Math.abs(event.screenY - origin.y) > 4) moved = true;
    api.moveWindowDrag();
  });
  listen(document, 'pointerup', (event) => {
    if (event.button !== 0 || event.pointerId !== held) return;
    remember(event);
    end();
  });
  const endPointer = (event) => { if (event.pointerId === held) end(); };
  listen(document, 'pointercancel', endPointer);
  listen(document, 'lostpointercapture', endPointer);
  listen(window, 'blur', end);
  listen(document, 'visibilitychange', () => { if (document.hidden) end(); });
  listen(document, 'mouseleave', () => { pointer = null; refresh(); });
  listen(document, 'contextmenu', (event) => {
    event.preventDefault();
    if (hitTest(event.clientX, event.clientY)) api.showContextMenu();
  });
  listen(document, 'click', (event) => {
    if (event.button !== 0 || moved || !hitTest(event.clientX, event.clientY)) return;
    api.focusTerminal().catch((error) => console.warn('Focus terminal failed:', error));
  });
  // Floating animation can move opaque pixels under a stationary cursor.
  const tick = () => { refresh(); frame = requestAnimationFrame(tick); };
  frame = requestAnimationFrame(tick);
  return () => {
    end();
    cancelAnimationFrame(frame);
    cleanupPointer?.();
    for (const remove of listeners) remove();
  };
}
