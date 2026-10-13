/* global document, requestAnimationFrame, performance */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
const registry = require('../../src/shared/data/characters.json');
const root = path.resolve(__dirname, '../..');

// Run against the real WebGL buffer after compositor frames, including a
// stationary cursor, CSS transform changes and a stopped animation.
async function verify({ engineUrl, hitUrl, threeUrl, characters, defaultCharacter }) {
  const [{ createVibeMonEngine }, { createCharacterHitTest }, THREE] = await Promise.all([
    import(engineUrl), import(hitUrl), import(threeUrl)
  ]);
  const container = document.getElementById('companion');
  const engine = createVibeMonEngine(container, { THREE, characters, defaultCharacter, preserveDrawingBuffer: true });
  engine.init();
  engine.setReducedMotion(true);
  engine.setState({ state: 'working' });
  engine.render();
  const { renderer } = engine;
  const canvas = renderer.domElement;
  const preserved = renderer.getContext().getContextAttributes().preserveDrawingBuffer;
  const sample = document.createElement('canvas');
  sample.width = canvas.width; sample.height = canvas.height;
  const context = sample.getContext('2d', { willReadFrequently: true });
  context.drawImage(canvas, 0, 0);
  const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
  const points = [0, 255].map(alpha => {
    const index = pixels.findIndex((value, i) => i % 4 === 3 && value === alpha) / 4;
    const pixel = Math.floor(index);
    return { x: pixel % canvas.width, y: Math.floor(pixel / canvas.width), opaque: alpha > 0 };
  });
  const hit = createCharacterHitTest(engine);
  const read = point => {
    const rect = canvas.getBoundingClientRect();
    return hit(rect.left + (point.x + 0.5) * rect.width / canvas.width, rect.top + (point.y + 0.5) * rect.height / canvas.height);
  };
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const before = renderer.info.render.frame;
  const start = performance.now();
  const samples = [];
  for (let i = 0; i < 120; i++) samples.push(read(points[1]));
  const durationMs = performance.now() - start;
  const stationaryRenders = renderer.info.render.frame - before;
  const transparent = read(points[0]);
  canvas.style.transformOrigin = 'top left';
  canvas.style.transform = 'translate(12px, 8px) scale(0.5)';
  const transformed = points.map(read);
  engine.setState({ state: 'sleep' });
  engine.render();
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  // Removing the visible rig changes the same previously opaque pixel.
  engine.rig.group.visible = false;
  engine.render();
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const cleared = read(points[1]);
  engine.cleanup();
  return { preserved, samples: samples.filter(Boolean).length, transparent, transformed, cleared, stationaryRenders, durationMs };
}

async function run() {
  await app.whenReady();
  const win = new BrowserWindow({ width: 200, height: 220, show: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, 'hit-test.html'));
  win.showInactive();
  const cases = [{ name: 'current', engine: path.join(root, 'src/engine/vibemon-engine-3d.js'), hit: path.join(root, 'src/shared/window-interaction.js') }];
  const baseline = process.env.VIBEMON_HIT_TEST_BASELINE_DIR;
  if (baseline) cases.unshift({ name: 'baseline', engine: path.join(baseline, 'vibemon-engine-3d.mjs'), hit: path.join(baseline, 'window-interaction.mjs') });
  const results = [];
  for (const item of cases) {
    const args = { engineUrl: pathToFileURL(item.engine).href, hitUrl: pathToFileURL(item.hit).href,
      threeUrl: pathToFileURL(path.join(root, 'src/vendor/three.module.min.js')).href,
      characters: registry.characters, defaultCharacter: registry.default };
    const result = await win.webContents.executeJavaScript(`(${verify.toString()})(${JSON.stringify(args)})`);
    assert.equal(result.samples, 120);
    assert.equal(result.transparent, false);
    assert.deepEqual(result.transformed, [false, true]);
    assert.equal(result.cleared, false);
    if (item.name === 'current') { assert.equal(result.preserved, true); assert.equal(result.stationaryRenders, 0); }
    results.push({ name: item.name, ...result });
  }
  const output = path.join(root, 'out/hit-test');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
  win.destroy();
}
const timeout = setTimeout(() => { console.error('Hit testing verification timed out'); app.exit(1); }, 30000);
run().then(() => { clearTimeout(timeout); app.exit(0); }).catch(error => { console.error(error); app.exit(1); });
