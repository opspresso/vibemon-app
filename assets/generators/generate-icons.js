const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const COLOR_CLAUDE = '#D97757';
const COLOR_EYE = '#000000';
const COLOR_BG = '#FFCC00';

function drawIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const scale = size / 64;

  function rect(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x * scale, y * scale, w * scale, h * scale);
  }

  // Round rectangle background
  const radius = size * 0.15;
  ctx.fillStyle = COLOR_BG;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, radius);
  ctx.fill();

  // Character positioning
  const offsetX = 0;
  const offsetY = 4;

  // Main body (52x36)
  rect(6 + offsetX, 8 + offsetY, 52, 36, COLOR_CLAUDE);

  // Arms (6x10)
  rect(0 + offsetX, 22 + offsetY, 6, 10, COLOR_CLAUDE);
  rect(58 + offsetX, 22 + offsetY, 6, 10, COLOR_CLAUDE);

  // Legs (4 legs)
  rect(10 + offsetX, 44 + offsetY, 6, 12, COLOR_CLAUDE);
  rect(18 + offsetX, 44 + offsetY, 6, 12, COLOR_CLAUDE);
  rect(40 + offsetX, 44 + offsetY, 6, 12, COLOR_CLAUDE);
  rect(48 + offsetX, 44 + offsetY, 6, 12, COLOR_CLAUDE);

  // Alert eyes (round)
  const leftX = 14 + offsetX;
  const rightX = 44 + offsetX;
  const eyeY = 22 + offsetY;

  // Left eye
  rect(leftX + 1, eyeY, 4, 6, COLOR_EYE);
  rect(leftX, eyeY + 1, 6, 4, COLOR_EYE);

  // Right eye
  rect(rightX + 1, eyeY, 4, 6, COLOR_EYE);
  rect(rightX, eyeY + 1, 6, 4, COLOR_EYE);

  // Question mark
  const qx = 50 + offsetX;
  const qy = 2 + offsetY;
  rect(qx + 1, qy, 4, 2, COLOR_EYE);
  rect(qx + 4, qy + 2, 2, 2, COLOR_EYE);
  rect(qx + 2, qy + 4, 2, 2, COLOR_EYE);
  rect(qx + 2, qy + 6, 2, 2, COLOR_EYE);
  rect(qx + 2, qy + 10, 2, 2, COLOR_EYE);

  return canvas;
}

// Generate icons
const sizes = [512, 256, 128, 64, 32, 16];
const assetsDir = __dirname;

console.log('Generating icons...');

sizes.forEach(size => {
  const canvas = drawIcon(size);
  const filename = size === 512 ? 'icon.png' : `icon-${size}.png`;
  const filepath = path.join(assetsDir, filename);
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(filepath, buffer);
  console.log(`Created: ${filename} (${size}x${size})`);
});

console.log('\nDone! PNG files created.');
console.log('\nNext steps:');
console.log('1. For Windows (.ico): convert icon-256.png icon-128.png icon-64.png icon-32.png icon-16.png icon.ico');
console.log('2. For macOS (.icns): See instructions in icon-generator.html');
