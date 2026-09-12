const { dockCorner, fitDockLayout } = require('../src/modules/dock-layout.cjs');

const display = {
  id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 30, width: 1440, height: 814 }
};
const dock = { x: 400, y: 844, width: 640, height: 52 };
const character = { width: 134, height: 138 };

function within(rect, area) {
  expect(rect.x).toBeGreaterThanOrEqual(area.x);
  expect(rect.y).toBeGreaterThanOrEqual(area.y);
  expect(rect.x + rect.width).toBeLessThanOrEqual(area.x + area.width);
  expect(rect.y + rect.height).toBeLessThanOrEqual(area.y + area.height);
}

test.each(['left', 'right'])('fits both complete overlays beside the bottom Dock on the %s', side => {
  const window = { x: side === 'left' ? 0 : 1306, y: 706, ...character };
  const corner = dockCorner(display, dock, window);
  const layout = fitDockLayout(corner, character, { width: 260, height: 185 });
  expect(layout.scale).toBeLessThan(1);
  within(layout.character, corner.area);
  within(layout.bubble, corner.area);
  expect(layout.character.y + layout.character.height).toBe(900);
  expect(layout.bubble.y + layout.bubble.height).toBe(900);
  if (side === 'left') {
    expect(layout.character.x).toBe(0);
    expect(layout.character.x + layout.character.width).toBeLessThan(layout.bubble.x);
  } else {
    expect(layout.character.x + layout.character.width).toBe(1440);
    expect(layout.bubble.x + layout.bubble.width).toBeLessThan(layout.character.x);
  }
});

test('uses Dock width to shrink a long bubble in a narrow corner', () => {
  const corner = dockCorner(display, { ...dock, x: 85, width: 1270 }, { x: 0, y: 760, ...character }, 8);
  const layout = fitDockLayout(corner, character, { width: 1500, height: 50 });
  within(layout.character, corner.area);
  within(layout.bubble, corner.area);
  expect(layout.character.x).toBe(8);
  expect(layout.character.y + layout.character.height).toBe(892);
});

test.each(['left', 'right'])('stacks overlays below a %s-side Dock', side => {
  const workArea = { x: side === 'left' ? 60 : 0, y: 30, width: 1380, height: 870 };
  const sideDock = { x: side === 'left' ? 4 : 1384, y: 250, width: 52, height: 400 };
  const window = { x: side === 'left' ? 60 : 1246, y: 762, ...character };
  const corner = dockCorner({ ...display, workArea }, sideDock, window);
  expect(corner.axis).toBe('vertical');
  const layout = fitDockLayout(corner, character, { width: 200, height: 100 });
  within(layout.character, corner.area);
  within(layout.bubble, corner.area);
  expect(layout.bubble.y + layout.bubble.height).toBeLessThan(layout.character.y);
});

test('matches negative-origin Retina displays in points', () => {
  const shifted = {
    id: 2, scaleFactor: 2,
    bounds: { ...display.bounds, x: -1440, y: -900 },
    workArea: { ...display.workArea, x: -1440, y: -870 }
  };
  const corner = dockCorner(shifted, { ...dock, x: -1040, y: -56 }, { x: -1440, y: -138, ...character });
  const layout = fitDockLayout(corner, character);
  expect(layout.character.x).toBe(-1440);
  expect(layout.character.y + layout.character.height).toBe(0);
  expect(layout.displayId).toBe(2);
});

test.each([
  null, { x: NaN, y: 844, width: 640, height: 52 },
  { x: 400, y: 899, width: 640, height: 1 },
  { x: 400, y: 900, width: 640, height: 52 },
  { x: 1840, y: 844, width: 640, height: 52 },
  display.bounds
])('ignores absent, hidden, invalid or non-Dock bounds: %j', candidate => {
  expect(dockCorner(display, candidate, { x: 0, y: 762, ...character })).toBeNull();
});

test('leaves ordinary positions and corners without usable space unchanged', () => {
  expect(dockCorner(display, dock, { x: 0, y: 50, ...character })).toBeNull();
  expect(dockCorner(display, dock, { x: 600, y: 762, ...character })).toBeNull();
  expect(dockCorner(display, dock, { x: 0, y: 762, ...character }, 32)).toBeNull();
});

test.each(['left', 'right'])('keep-size mode uses the free column at the %s screen corner', side => {
  const corner = dockCorner(display, dock, { x: side === 'left' ? 0 : 1306, y: 762, ...character }, 8, false);
  const bubble = { width: 260, height: 185 };
  const layout = fitDockLayout(corner, character, bubble, false);
  expect(layout.scale).toBe(1);
  expect(layout.character).toMatchObject(character);
  expect(layout.bubble).toMatchObject(bubble);
  expect(layout.character.y + layout.character.height).toBe(892);
  within(layout.character, corner.area);
  within(layout.bubble, corner.area);
  expect(layout.axis).toBe('vertical');
  expect(layout.bubble.y + layout.bubble.height).toBeLessThan(layout.character.y);
});

test('keep-size mode uses the free row beneath a side Dock', () => {
  const sideDisplay = { ...display, workArea: { x: 60, y: 30, width: 1380, height: 870 } };
  const corner = dockCorner(sideDisplay, { x: 4, y: 250, width: 52, height: 400 }, { x: 60, y: 762, ...character }, 0, false);
  const layout = fitDockLayout(corner, character, { width: 200, height: 185 }, false);
  expect(layout.scale).toBe(1);
  expect(layout.axis).toBe('horizontal');
  within(layout.character, corner.area);
  within(layout.bubble, corner.area);
});

test('keep-size mode does not silently shrink overlays when neither arrangement fits', () => {
  const corner = dockCorner(display, { ...dock, x: 85, width: 1270 }, { x: 0, y: 762, ...character }, 0, false);
  expect(fitDockLayout(corner, character, { width: 260, height: 185 }, false)).toBeNull();
  expect(fitDockLayout(corner, character, { width: 260, height: 185 }, true).scale).toBeLessThan(1);
});

describe.each([false, true])('short Dock bubbles with autoScale=%s', autoScale => {
  test.each(['left', 'right'])('vertically centers a shorter bubble at the %s bottom corner', side => {
    const corner = dockCorner(display, dock, { x: side === 'left' ? 0 : 1306, y: 762, ...character }, 8, autoScale);
    const layout = fitDockLayout(corner, character, { width: 146, height: 51 }, autoScale);
    expect(layout.axis).toBe('horizontal');
    const charCenter = layout.character.y + layout.character.height / 2;
    const bubbleCenter = layout.bubble.y + layout.bubble.height / 2;
    expect(Math.abs(charCenter - bubbleCenter)).toBeLessThanOrEqual(0.5);
    expect(layout.character.y + layout.character.height).toBe(892);
    expect(layout.bubble.y + layout.bubble.height).toBeLessThan(892);
    within(layout.bubble, corner.area);
    expect(layout.bubble.tailSide).toBe(side);
  });
});
