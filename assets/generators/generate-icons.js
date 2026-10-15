// Generate the mark, companion sprite, and platform icons from shared geometry.
// Run on macOS: `pnpm exec electron assets/generators/generate-icons.js`.
// Chromium's canvas renders the PNG frames; macOS iconutil creates the ICNS container.
const { app, BrowserWindow } = require('electron');
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
// Runs in the page. Each job draws an optional gradient tile, then an SVG image.
function renderInPage(jobs) {
  return Promise.all(jobs.map(async job => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = job.size;
    const ctx = canvas.getContext('2d');
    if (job.tile) {
      const { padding, radius, from, to } = job.tile;
      const background = ctx.createLinearGradient(0, 0, job.size, job.size);
      background.addColorStop(0, from);
      background.addColorStop(1, to);
      ctx.fillStyle = background;
      ctx.beginPath();
      ctx.roundRect(padding, padding, job.size - 2 * padding, job.size - 2 * padding, radius);
      ctx.fill();
    }
    const image = new Image();
    image.src = `data:image/svg+xml;base64,${btoa(job.svg)}`;
    await image.decode();
    ctx.drawImage(image, job.offset, job.offset, job.box, job.box);
    return canvas.toDataURL('image/png').split(',')[1];
  }));
}
async function render(window, jobs) {
  const encoded = await window.webContents.executeJavaScript(`(${renderInPage})(${JSON.stringify(jobs)})`);
  return encoded.map(data => Buffer.from(data, 'base64'));
}
function tileJob(size, mark) {
  const box = size * (size < 64 ? .9 : .78);
  return {
    size, box, offset: (size - box) / 2,
    svg: mark.replace('<svg ', `<svg width="${size}" height="${size}" `).replaceAll('currentColor', token('--vm-sidebar-accent')),
    tile: { padding: size >= 128 ? size / 16 : 0, radius: size * .2, from: token('--vm-sidebar-hover'), to: token('--vm-sidebar') }
  };
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
async function generate(window) {
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
  const spriteSvg = svg(`<path fill="${character.color}" d="${body}"/><path fill="${character.eyeColor}" d="${eyes}"/>`)
    .replace('<svg ', '<svg width="128" height="128" ');
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  const [sprite, ...rendered] = await render(window, [
    { size: 128, box: 128, offset: 0, svg: spriteSvg },
    ...sizes.map(size => tileJob(size, mark))
  ]);
  const frames = new Map(sizes.map((size, index) => [size, rendered[index]]));
  fs.writeFileSync(path.join(design, 'brand-mark.svg'), mark);
  fs.writeFileSync(path.join(root, 'src/assets/characters', character.image), sprite);
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
app.dock?.hide();
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await window.loadURL('about:blank');
    await generate(window);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
