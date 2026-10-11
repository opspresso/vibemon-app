// Generate the mark, companion sprite, and platform icons from shared geometry.
// macOS iconutil creates the ICNS container; node-canvas renders PNG frames.
const { createCanvas, loadImage } = require('canvas');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const assets = path.join(root, 'assets');
const design = path.join(root, 'src/shared/design');
const palette = fs.readFileSync(path.join(design, 'tokens.css'), 'utf8');
function token(name) {
  const value = palette.match(new RegExp(`${name}:\\s*(#[a-fA-F0-9]{6});`))?.[1];
  if (!value) throw new Error(`Expected a fixed product color: ${name}`);
  return value;
}
async function draw(size, mark) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const padding = size >= 128 ? size / 16 : 0;
  const background = ctx.createLinearGradient(0, 0, size, size);
  background.addColorStop(0, token('--vm-sidebar-hover'));
  background.addColorStop(1, token('--vm-sidebar'));
  ctx.fillStyle = background;
  ctx.beginPath();
  ctx.roundRect(padding, padding, size - 2 * padding, size - 2 * padding, size * .2);
  ctx.fill();
  const box = size * (size < 64 ? .9 : .78);
  const source = mark.replace('<svg ', `<svg width="${size}" height="${size}" `)
    .replaceAll('currentColor', token('--vm-sidebar-accent'));
  const image = await loadImage(Buffer.from(source));
  ctx.drawImage(image, (size - box) / 2, (size - box) / 2, box, box);
  return canvas.toBuffer('image/png');
}
function ico(frames) {
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(([size, bytes], index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(bytes.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += bytes.length;
  });
  return Buffer.concat([header, ...frames.map(([, bytes]) => bytes)]);
}
async function main() {
  if (process.platform !== 'darwin') throw new Error('Regenerate the complete icon set on macOS with iconutil');
  const { COMPANION_SIZE, COMPANION_EYES, companionBodyPath, companionEyePath } = await import('../../src/engine/vibemon-companion.mjs');
  const svg = content => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${COMPANION_SIZE} ${COMPANION_SIZE}">\n  ${content}\n</svg>\n`;
  const body = companionBodyPath(), eyes = companionEyePath();
  const mark = svg(`<path fill="currentColor" fill-rule="evenodd" d="${body} ${eyes}"/>`);
  const character = JSON.parse(fs.readFileSync(path.join(root, 'src/shared/data/characters.json'), 'utf8')).characters.vibemon;
  for (const side of ['left', 'right']) {
    const eye = COMPANION_EYES[side], scale = 128 / COMPANION_SIZE;
    assert.deepEqual(character.eyes[side], { x: eye.x * scale, y: eye.y * scale });
    assert.equal(character.eyes.w, eye.w * scale);
    assert.equal(character.eyes.h, eye.h * scale);
  }
  const sprite = await loadImage(Buffer.from(svg(`<path fill="${character.color}" d="${body}"/><path fill="${character.eyeColor}" d="${eyes}"/>`).replace('<svg ', '<svg width="128" height="128" ')));
  const spriteCanvas = createCanvas(128, 128);
  spriteCanvas.getContext('2d').drawImage(sprite, 0, 0);
  fs.writeFileSync(path.join(design, 'brand-mark.svg'), mark);
  fs.writeFileSync(path.join(root, 'src/assets/characters', character.image), spriteCanvas.toBuffer('image/png'));
  const frames = new Map(await Promise.all([16, 24, 32, 48, 64, 128, 256, 512, 1024].map(async size => [size, await draw(size, mark)])));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vibemon-icons-'));
  try {
    const iconset = path.join(temporary, 'VibeMon.iconset');
    fs.mkdirSync(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      fs.writeFileSync(path.join(iconset, `icon_${size}x${size}.png`), frames.get(size));
      fs.writeFileSync(path.join(iconset, `icon_${size}x${size}@2x.png`), frames.get(size * 2));
    }
    const icns = path.join(temporary, 'icon.icns');
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', '-o', icns, iconset]);
    fs.copyFileSync(icns, path.join(assets, 'icon.icns'));
    fs.writeFileSync(path.join(assets, 'icon.png'), frames.get(512));
    fs.writeFileSync(path.join(assets, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map(size => [size, frames.get(size)])));
    const favicon = ico([16, 32].map(size => [size, frames.get(size)]));
    fs.writeFileSync(path.join(assets, 'web/favicon.ico'), favicon);
    fs.writeFileSync(path.join(root, 'public/install/favicon.ico'), favicon);
    for (const size of [16, 32]) fs.writeFileSync(path.join(assets, `web/icon-${size}.png`), frames.get(size));
    console.log('Generated the logo, aligned companion sprite, App PNG/ICO/ICNS and Web favicons');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
