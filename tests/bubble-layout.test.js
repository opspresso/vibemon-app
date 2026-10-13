const { placeBubble } = require('../src/modules/bubble-layout.cjs');

test.each([0.3, 0.4, 0.5, 1])('fits bubbles without overlap across edges and displays at scale %s', scale => {
  for (const work of [{ x: 0, y: 25, width: 1920, height: 1055 }, { x: -800, y: -600, width: 800, height: 600 }]) {
    for (const margin of [0, 16]) for (const size of [{ width: 146, height: 35 }, { width: 300, height: 200 }, { width: 1000, height: 600 }]) {
      const width = 134 * scale, height = 138 * scale;
      const left = work.x + margin, top = work.y + margin;
      const right = work.x + work.width - margin, bottom = work.y + work.height - margin;
      for (const x of [left, (left + right - width) / 2, right - width]) for (const y of [top, (top + bottom - height) / 2, bottom - height]) {
        const placed = placeBubble({ x, y, width, height }, size, work, scale, margin);
        expect(placed).not.toBeNull();
        expect(placed.x).toBeGreaterThanOrEqual(left);
        expect(placed.y).toBeGreaterThanOrEqual(top);
        expect(placed.x + placed.width).toBeLessThanOrEqual(right);
        expect(placed.y + placed.height).toBeLessThanOrEqual(bottom);
        const overlap = Math.max(0, Math.min(x + width, placed.x + placed.width) - Math.max(x, placed.x))
          * Math.max(0, Math.min(y + height, placed.y + placed.height) - Math.max(y, placed.y));
        expect(overlap).toBe(0);
        expect(placed.scale).toBeGreaterThan(0);
        expect(placed.scale).toBeLessThanOrEqual(1);
      }
    }
  }
});

test('chooses readable full-size placement before shrinking and keeps stationary layout stable', () => {
  const work = { x: 0, y: 0, width: 1000, height: 800 };
  const bounds = { x: 400, y: 25, width: 134, height: 138 };
  const size = { width: 200, height: 100 };
  const placed = placeBubble(bounds, size, work, 1);
  expect(placed).toMatchObject({ scale: 1, tailSide: 'top', y: 167 });
  for (let i = 0; i < 100; i++) expect(placeBubble(bounds, size, work, 1)).toEqual(placed);
  expect(placeBubble(bounds, { width: 0, height: 100 }, work, 1)).toBeNull();
});
