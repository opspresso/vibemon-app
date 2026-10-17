const { trayIconBitmap, dotBitmap } = require('../src/modules/tray-icon.cjs');

const SIZE = 22;
const pixel = (bitmap, size, x, y) => Array.from(bitmap.subarray((y * size + x) * 4, (y * size + x) * 4 + 4));
// Premultiplied BGRA of an opaque #RRGGBB color.
const bgra = color => [color & 255, (color >> 8) & 255, (color >> 16) & 255, 255];

describe('tray icon bitmap', () => {
  test('fills a rounded square with the state color and leaves the corners clear', () => {
    const bitmap = trayIconBitmap(SIZE, '#9933FF', null);
    expect(bitmap.length).toBe(SIZE * SIZE * 4);
    expect(pixel(bitmap, SIZE, 11, 11)).toEqual(bgra(0x9933FF));
    expect(pixel(bitmap, SIZE, 0, 0)[3]).toBe(0);
    // An anti-aliased corner edge is partly covered, never fully opaque.
    const edge = pixel(bitmap, SIZE, 1, 1)[3];
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
  });

  test('enlarges a small sprite inside a one-pixel inset', () => {
    // A 2x2 sprite: opaque blue on the left column, transparent on the right.
    const sprite = { width: 2, height: 2, data: Buffer.from([255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0]) };
    const bitmap = trayIconBitmap(SIZE, '#00AA00', sprite);
    expect(pixel(bitmap, SIZE, 3, 11)).toEqual(bgra(0x0000FF));
    expect(pixel(bitmap, SIZE, 18, 11)).toEqual(bgra(0x00AA00));
  });

  test('shrinks a large sprite by averaging the pixels each target covers', () => {
    // 40x1 sprite: alternating opaque white and transparent columns, two per target pixel.
    const data = Buffer.alloc(40 * 4);
    for (let x = 0; x < 40; x += 2) data.fill(255, x * 4, x * 4 + 4);
    const bitmap = trayIconBitmap(SIZE, '#000000', { width: 40, height: 1, data });
    // Half-covered white over opaque black: no hard on/off pixels.
    expect(pixel(bitmap, SIZE, 11, 11)).toEqual([128, 128, 128, 255]);
  });

  test('draws the same icon with twice the pixels at scale 2', () => {
    const bitmap = trayIconBitmap(SIZE, '#9933FF', null, '#FF6633', 2);
    expect(bitmap.length).toBe(SIZE * SIZE * 16);
    expect(pixel(bitmap, SIZE * 2, 22, 30)).toEqual(bgra(0x9933FF));
    expect(pixel(bitmap, SIZE * 2, (SIZE - 5) * 2, 10)).toEqual(bgra(0xFF6633));
    expect(pixel(bitmap, SIZE * 2, 0, 0)[3]).toBe(0);
  });

  test('draws the attention badge only when asked', () => {
    expect(pixel(trayIconBitmap(SIZE, '#00AA00', null, '#FF6633'), SIZE, SIZE - 5, 5)).toEqual(bgra(0xFF6633));
    expect(pixel(trayIconBitmap(SIZE, '#00AA00', null), SIZE, SIZE - 5, 5)).toEqual(bgra(0x00AA00));
  });

  test('a menu dot is centered and transparent outside', () => {
    const dot = dotBitmap(32, '#FF6633');
    expect(pixel(dot, 32, 16, 16)).toEqual(bgra(0xFF6633));
    expect(pixel(dot, 32, 2, 2)[3]).toBe(0);
  });
});
