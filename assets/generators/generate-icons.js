// Generate platform icons from the same vector and palette as App/Web.
// macOS iconutil creates the ICNS container; node-canvas renders PNG frames.
const { createCanvas, loadImage } = require('canvas');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const assets = path.join(root, 'assets');
const design = path.join(root, 'src/shared/design');
const palette = fs.readFileSync(path.join(design, 'tokens.css'), 'utf8');
const mark = fs.readFileSync(path.join(design, 'brand-mark.svg'), 'utf8');
function token(name) {
  const value = palette.match(new RegExp(`${name}:\\s*(#[a-fA-F0-9]{6});`))?.[1];
  if (!value) throw new Error(`Expected a fixed product color: ${name}`);
  return value;
}
async function draw(size) {
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
    .replace('currentColor', token('--vm-sidebar-accent'))
    .replace('stroke-width="1.6"', `stroke-width="${size < 32 ? 2.4 : 1.8}"`);
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
  const frames = new Map(await Promise.all([16, 24, 32, 48, 64, 128, 256, 512, 1024].map(async size => [size, await draw(size)])));
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
    console.log('Generated App PNG/ICO/ICNS and Web favicons from shared product sources');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
