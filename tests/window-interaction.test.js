const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadInteraction() {
  const events = new Map();
  const api = Object.fromEntries(['setIgnoreMouseEvents', 'beginWindowDrag', 'moveWindowDrag', 'endWindowDrag', 'showContextMenu'].map(name => [name, jest.fn()]));
  api.focusTerminal = jest.fn(() => Promise.resolve());
  const context = { clearRect: jest.fn(), drawImage: jest.fn(), getImageData: jest.fn(() => ({ data: [0, 0, 0, 255] })) };
  const target = {
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: (name) => events.delete(name)
  };
  const document = {
    ...target,
    createElement: () => ({ getContext: () => context }),
    documentElement: { setPointerCapture: jest.fn(), hasPointerCapture: () => true, releasePointerCapture: jest.fn() }
  };
  const sandbox = {
    document, window: { ...target, electronAPI: api }, console,
    requestAnimationFrame: jest.fn(), cancelAnimationFrame: jest.fn()
  };
  const code = fs.readFileSync(path.join(__dirname, '../src/shared/window-interaction.js'), 'utf8').replaceAll('export function ', 'function ');
  vm.runInNewContext(code + '\nthis.result = { createCharacterHitTest, hitTestBubble, installWindowInteraction };', sandbox);
  return { ...sandbox.result, context, api, events, document };
}

test.each([0.5, 0.75, 1, 1.25, 1.5, 2])('alpha hit testing respects CSS scale and backing resolution: %s', (scale) => {
  const { createCharacterHitTest, context } = loadInteraction();
  const canvas = {
    width: 256, height: 256,
    getBoundingClientRect: () => ({ left: 3, top: 5, right: 3 + 128 * scale, bottom: 5 + 128 * scale, width: 128 * scale, height: 128 * scale })
  };
  const hit = createCharacterHitTest({ canvas });
  expect(hit(2, 5)).toBe(false);
  expect(hit(3 + 128 * scale, 5)).toBe(false);
  expect(hit(3 + 64 * scale, 5 + 64 * scale)).toBe(true);
  expect(context.drawImage).toHaveBeenLastCalledWith(canvas, 128, 128, 1, 1, 0, 0, 1, 1);
  context.getImageData.mockReturnValue({ data: [0, 0, 0, 0] });
  expect(hit(3 + 64 * scale, 5 + 64 * scale)).toBe(false);
});

test('WebGL is rendered before sampling its non-preserved drawing buffer', () => {
  const { createCharacterHitTest, context } = loadInteraction();
  const renderer = {
    domElement: { width: 100, height: 100, getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) },
    render: jest.fn()
  };
  expect(createCharacterHitTest({ renderer, scene: {}, camera: {} })(50, 50)).toBe(true);
  expect(renderer.render.mock.invocationCallOrder[0]).toBeLessThan(context.drawImage.mock.invocationCallOrder[0]);
});

test('rounded bubble corners and transparent tail corners pass through', () => {
  const { hitTestBubble } = loadInteraction();
  const bubble = {
    getBoundingClientRect: () => ({ left: 6, top: 6, right: 140, bottom: 46, width: 134, height: 40 }),
    querySelector: () => ({ getBoundingClientRect: () => ({ left: 67, right: 79, top: 46, bottom: 52 }), classList: { contains: name => name === 'tail-bottom' } })
  };
  expect(hitTestBubble(bubble, 6, 6)).toBe(false);
  expect(hitTestBubble(bubble, 20, 20)).toBe(true);
  expect(hitTestBubble(bubble, 73, 50)).toBe(true);
  expect(hitTestBubble(bubble, 68, 50)).toBe(false);
  expect(hitTestBubble(bubble, 150, 20)).toBe(false);
});

test('bubble corner hit testing follows its Dock scale', () => {
  const { hitTestBubble } = loadInteraction();
  const bubble = {
    offsetWidth: 100,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 50, bottom: 25, width: 50, height: 25 })
  };
  expect(hitTestBubble(bubble, 2, 2)).toBe(true);
  expect(hitTestBubble(bubble, 0, 0)).toBe(false);
});

test('forwarded mousemove enables only visible pixels; drag capture survives transparent pixels', () => {
  const { installWindowInteraction, events, api, document } = loadInteraction();
  const cleanup = installWindowInteraction({ hitTest: x => x >= 20 });
  const event = { clientX: 25, clientY: 20, screenX: 100, screenY: 100, button: 0, buttons: 1, pointerId: 1 };
  events.get('mousemove')(event);
  expect(api.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  events.get('pointerdown')(event);
  expect(document.documentElement.setPointerCapture).toHaveBeenCalledWith(1);
  events.get('mousemove')({ ...event, clientX: 0 });
  expect(api.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  events.get('pointermove')({ ...event, clientX: 0, screenX: 150 });
  expect(api.moveWindowDrag).toHaveBeenCalledTimes(1);
  events.get('pointerup')({ ...event, clientX: 0 });
  expect(api.endWindowDrag).toHaveBeenCalledTimes(1);
  expect(api.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
  events.get('click')(event);
  expect(api.focusTerminal).not.toHaveBeenCalled();
  cleanup();
  expect(events.size).toBe(0);
});

test('transparent pointerdown is ignored and blur terminates a held drag', () => {
  const { installWindowInteraction, events, api } = loadInteraction();
  installWindowInteraction({ hitTest: x => x > 10 });
  const event = { clientX: 0, clientY: 0, screenX: 0, screenY: 0, button: 0, pointerId: 1 };
  events.get('pointerdown')(event);
  expect(api.beginWindowDrag).not.toHaveBeenCalled();
  events.get('pointerdown')({ ...event, clientX: 20 });
  events.get('blur')();
  expect(api.endWindowDrag).toHaveBeenCalledTimes(1);
});

test('native cursor updates restore input without any forwarded mousemove', () => {
  const { installWindowInteraction, api } = loadInteraction();
  let onPointer;
  const unsubscribe = jest.fn();
  api.onWindowPointer = callback => { onPointer = callback; return unsubscribe; };
  const cleanup = installWindowInteraction({ hitTest: x => x >= 20 });
  onPointer({ x: 25, y: 20 });
  expect(api.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  onPointer(null);
  expect(api.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
  cleanup();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});


test('hiding a held renderer releases capture and restores its interaction state', () => {
  const { installWindowInteraction, events, api, document } = loadInteraction();
  const onInteraction = jest.fn();
  const cleanup = installWindowInteraction({ hitTest: x => x > 10, onInteraction });
  events.get('pointerdown')({ clientX: 20, clientY: 20, screenX: 100, screenY: 100, button: 0, pointerId: 1 });
  document.hidden = true;
  events.get('visibilitychange')();
  expect(api.endWindowDrag).toHaveBeenCalledTimes(1);
  expect(onInteraction).toHaveBeenLastCalledWith(false);
  expect(document.documentElement.releasePointerCapture).toHaveBeenCalledWith(1);
  document.hidden = false;
  events.get('visibilitychange')();
  events.get('mousemove')({ clientX: 0, clientY: 0 });
  expect(api.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
  cleanup();
});

test.each(['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'])('unrelated %s cannot move or end a held pointer', type => {
  const { installWindowInteraction, api, events } = loadInteraction();
  const cleanup = installWindowInteraction({ hitTest: () => true });
  const primary = { pointerId: 1, isPrimary: true, button: 0, buttons: 1, clientX: 20, clientY: 20, screenX: 100, screenY: 100 };
  events.get('pointerdown')(primary);
  events.get(type)({ ...primary, pointerId: 2, isPrimary: false, buttons: 0, screenX: 300 });
  expect(api.moveWindowDrag).not.toHaveBeenCalled();
  expect(api.endWindowDrag).not.toHaveBeenCalled();
  events.get('pointerup')(primary);
  expect(api.endWindowDrag).toHaveBeenCalledTimes(1);
  cleanup();
});

test('a second pointer cannot replace the active drag anchor', () => {
  const { installWindowInteraction, api, events, document } = loadInteraction();
  const cleanup = installWindowInteraction({ hitTest: () => true });
  const primary = { pointerId: 1, isPrimary: true, button: 0, buttons: 1, clientX: 20, clientY: 20, screenX: 100, screenY: 100 };
  events.get('pointerdown')(primary);
  events.get('pointerdown')({ ...primary, pointerId: 2, isPrimary: true });
  expect(api.beginWindowDrag).toHaveBeenCalledTimes(1);
  events.get('pointerup')(primary);
  expect(document.documentElement.releasePointerCapture).toHaveBeenCalledWith(1);
  cleanup();
});

test('a non-primary contact does not start a drag', () => {
  const { installWindowInteraction, api, events } = loadInteraction();
  const cleanup = installWindowInteraction({ hitTest: () => true });
  events.get('pointerdown')({ pointerId: 2, isPrimary: false, button: 0, clientX: 20, clientY: 20 });
  expect(api.beginWindowDrag).not.toHaveBeenCalled();
  cleanup();
});
