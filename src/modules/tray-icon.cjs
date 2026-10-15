/**
 * Tray icon pixels, drawn without a native graphics dependency.
 *
 * Bitmaps are premultiplied BGRA, the layout Electron's nativeImage uses for
 * toBitmap() and createFromBitmap(). Shape edges are anti-aliased by sampling
 * each pixel on a SAMPLES x SAMPLES grid.
 */

const SAMPLES = 4;

/** @param {string} color - #RRGGBB */
function rgb(color) {
  const value = Number.parseInt(color.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** The fraction of pixel (x, y) that lies inside a shape. */
function coverage(inside, x, y) {
  let hits = 0;
  for (let i = 0; i < SAMPLES; i++) {
    for (let j = 0; j < SAMPLES; j++) {
      if (inside(x + (i + 0.5) / SAMPLES, y + (j + 0.5) / SAMPLES)) hits++;
    }
  }
  return hits / (SAMPLES * SAMPLES);
}

/** Composite one premultiplied BGRA pixel over the pixel at `offset`. */
function over(target, offset, blue, green, red, alpha) {
  const keep = 1 - alpha / 255;
  target[offset] = Math.round(blue + target[offset] * keep);
  target[offset + 1] = Math.round(green + target[offset + 1] * keep);
  target[offset + 2] = Math.round(red + target[offset + 2] * keep);
  target[offset + 3] = Math.round(alpha + target[offset + 3] * keep);
}

/** Fill a shape with one color, anti-aliased at its edge. */
function fill(target, size, color, inside) {
  const [red, green, blue] = rgb(color);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const alpha = 255 * coverage(inside, x, y);
      if (alpha > 0) over(target, (y * size + x) * 4, blue * alpha / 255, green * alpha / 255, red * alpha / 255, alpha);
    }
  }
}

const roundedSquare = (size, radius) => (x, y) => {
  const dx = Math.max(radius - x, 0, x - (size - radius));
  const dy = Math.max(radius - y, 0, y - (size - radius));
  return dx * dx + dy * dy <= radius * radius;
};
const circle = (cx, cy, radius) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;

/**
 * Draw a sprite into a square region with nearest-neighbor scaling, which
 * keeps pixel art sharp.
 * @param {{width: number, height: number, data: Buffer}} sprite
 */
function drawSprite(target, size, sprite, inset) {
  const extent = size - inset * 2;
  for (let y = 0; y < extent; y++) {
    const sy = Math.min(sprite.height - 1, Math.floor((y + 0.5) * sprite.height / extent));
    for (let x = 0; x < extent; x++) {
      const sx = Math.min(sprite.width - 1, Math.floor((x + 0.5) * sprite.width / extent));
      const source = (sy * sprite.width + sx) * 4;
      const alpha = sprite.data[source + 3];
      if (alpha > 0) over(target, ((y + inset) * size + x + inset) * 4, sprite.data[source], sprite.data[source + 1], sprite.data[source + 2], alpha);
    }
  }
}

/**
 * The tray icon: a state-colored rounded square, the character sprite, and
 * an optional attention badge in the top-right corner.
 * @returns {Buffer} size x size premultiplied BGRA
 */
function trayIconBitmap(size, background, sprite, badgeColor = null) {
  const pixels = Buffer.alloc(size * size * 4);
  fill(pixels, size, background, roundedSquare(size, 4));
  if (sprite) drawSprite(pixels, size, sprite, 1);
  if (badgeColor) fill(pixels, size, badgeColor, circle(size - 5, 5, 3));
  return pixels;
}

/** A filled dot centered in a size x size square. */
function dotBitmap(size, color) {
  const pixels = Buffer.alloc(size * size * 4);
  fill(pixels, size, color, circle(size / 2, size / 2, size / 4));
  return pixels;
}

module.exports = { trayIconBitmap, dotBitmap };
