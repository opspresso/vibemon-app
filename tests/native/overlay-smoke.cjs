// Run with Electron, separately from Jest, to exercise native window geometry.
const { app, BrowserWindow, ipcMain, screen, protocol } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { CharacterWindowManager } = require('../../src/modules/character-window-manager.cjs');
const { BubbleWindowManager } = require('../../src/modules/bubble-window-manager.cjs');
const characters = require('../../src/shared/data/characters.json');
const states = require('../../src/shared/data/states.json');
const { CHARACTER_IMAGE_FETCH_TIMEOUT_MS } = require('../../src/shared/config.cjs');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'out', 'overlay-tests', process.platform, app.commandLine.getSwitchValue('force-device-scale-factor') || 'native');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'vibemon-overlay-')));
app.on('window-all-closed', () => {});

let characterManager;
let bubbleManager;
let focused = 0;
const ignored = new Map();
const errors = [];
const results = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 10000;
  do {
    if (await check()) return;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

ipcMain.handle('get-character-registry', () => ({ ...characters, staticBaseUrl: 'https://static.vibemon.io', imageFetchTimeoutMs: CHARACTER_IMAGE_FETCH_TIMEOUT_MS }));
ipcMain.handle('get-state-registry', () => states);
ipcMain.handle('get-render-mode', () => characterManager.getRenderMode());
ipcMain.handle('get-display-options', () => characterManager.getDisplayOptions());
ipcMain.handle('focus-terminal', () => { focused++; return { success: true }; });
ipcMain.on('window-ignore-mouse', (event, ignore) => {
  ignored.set(event.sender.id, ignore);
  BrowserWindow.fromWebContents(event.sender).setIgnoreMouseEvents(ignore, { forward: true });
});
ipcMain.on('window-drag-start', event => characterManager.beginUserDrag(BrowserWindow.fromWebContents(event.sender)));
ipcMain.on('window-drag-move', event => characterManager.moveUserDrag(BrowserWindow.fromWebContents(event.sender)));
ipcMain.on('window-drag-end', event => characterManager.endUserDrag(BrowserWindow.fromWebContents(event.sender)));
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', event => {
    if (event.level === 'error') errors.push(event.message);
  });
  contents.on('render-process-gone', (_event, details) => errors.push(`Renderer exited: ${details.reason}`));
});

// A real OS click must land on the receiver behind transparent overlay pixels.
function windowsMouse() {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'windows-mouse.ps1')], { windowsHide: true });
  const pending = [];
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const waiter = pending.shift();
    if (!waiter) return;
    const result = JSON.parse(line);
    if (result.error) waiter.reject(new Error(result.error)); else waiter.resolve();
  });
  child.stderr.on('data', data => console.error(String(data)));
  child.on('error', error => { for (const waiter of pending.splice(0)) waiter.reject(error); });
  child.on('exit', code => { for (const waiter of pending.splice(0)) waiter.reject(new Error(`Mouse helper exited: ${code}`)); });
  return {
    send: (action, point) => new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      child.stdin.write(JSON.stringify({ action, ...(point ? screen.dipToScreenPoint(point) : {}) }) + '\n');
    }),
    close: () => { child.stdin.end(); lines.close(); }
  };
}

async function nativeClickTest(mouse, receiver, win, inside, outside) {
  const { x, y } = win.getBounds();
  await mouse.send('move', { x: x + inside.x, y: y + inside.y });
  await until(() => ignored.get(win.webContents.id) === false, 'opaque pixels accept native input');
  const count = await receiver.webContents.executeJavaScript('window.clicks');
  const focusBefore = focused;
  await mouse.send('click');
  await until(() => focused > focusBefore, 'opaque click reaches overlay');
  assert.equal(await receiver.webContents.executeJavaScript('window.clicks'), count);
  await mouse.send('move', { x: x + outside.x, y: y + outside.y });
  await until(() => ignored.get(win.webContents.id) === true, 'transparent pixels ignore native input');
  await mouse.send('click');
  await until(async () => await receiver.webContents.executeJavaScript('window.clicks') === count + 1, 'transparent click reaches receiver');
}

async function nativeDragTest(mouse, win, point) {
  const bounds = win.getBounds();
  const character = characterManager.getActiveWindow();
  const origin = character.getBounds();
  const cursor = { x: bounds.x + point.x, y: bounds.y + point.y };
  await mouse.send('move', cursor);
  await until(() => ignored.get(win.webContents.id) === false, 'drag hit');
  await mouse.send('down');
  await until(() => characterManager.dragOrigin !== null, 'drag begins');
  await mouse.send('move', { x: cursor.x + 40, y: cursor.y + 20 });
  await until(() => character.getBounds().x === origin.x + 40, 'native drag follows cursor');
  await mouse.send('up');
  await until(() => characterManager.dragOrigin === null, 'drag ends');
  await until(() => characterManager.snapTimer === null, 'edge snapping settles');
  await until(async () => {
    const bubble = bubbleManager.bubbleWindows.get('test');
    const expected = await bubbleManager.computePlacement(character, bubbleManager.lastSizes.get('test'));
    const actual = bubble.getBounds();
    return actual.x === expected.x && actual.y === expected.y;
  }, 'bubble follows the settled character');
}

async function verifyDockCorners(win, mode) {
  const display = screen.getDisplayMatching(win.getBounds());
  const b = display.bounds;
  characterManager.dockMonitor = {
    bounds: [{ x: b.x + Math.round(b.width * 0.3), y: b.y + b.height - 96, width: Math.round(b.width * 0.4), height: 92 }],
    refresh: () => Promise.resolve()
  };
  bubbleManager.getDockLayout = () => characterManager.dockLayout;
  bubbleManager.setBubbleSize = size => characterManager.setBubbleSize(size);
  const content = {
    state: { state: 'working', project: 'Dock corner verification', model: 'Example model', memory: 42, usage5h: 18, usageWeek: 36 },
    speechBubbleFields: { status: true, project: true, model: true, memory: true, usage5h: true, usageWeek: true }
  };
  for (const side of ['left', 'right']) {
    characterManager.dockLayout = null;
    win.setResizable(true);
    characterManager.positionWindow(win, side === 'left' ? b.x : b.x + b.width - 134, b.y + b.height - 138);
    win.setResizable(false);
    characterManager.refreshDockLayout();
    await bubbleManager.update('test', content);
    const bubble = bubbleManager.bubbleWindows.get('test');
    await until(() => {
      const expected = characterManager.dockLayout?.bubble;
      if (!expected) return false;
      const actual = bubble.getBounds();
      return ['x', 'y', 'width', 'height'].every(key => actual[key] === expected[key]);
    }, `${mode} ${side} native Dock corner geometry`);
    const layout = characterManager.dockLayout;
    assert.deepEqual(win.getBounds(), layout.character);
    for (const overlay of [win, bubble]) {
      const rect = overlay.getBounds();
      assert(rect.x >= layout.area.x && rect.y >= layout.area.y);
      assert(rect.x + rect.width <= layout.area.x + layout.area.width);
      assert(rect.y + rect.height <= layout.area.y + layout.area.height);
    }
    const rendered = await bubble.webContents.executeJavaScript('(() => { const b = document.getElementById("bubble").getBoundingClientRect(); return { right: b.right, bottom: b.bottom, width: innerWidth, height: innerHeight }; })()');
    assert(rendered.right <= rendered.width && rendered.bottom <= rendered.height, 'scaled bubble content is not clipped');
    fs.writeFileSync(path.join(output, `dock-${mode}-${side}-character.png`), (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(output, `dock-${mode}-${side}-bubble.png`), (await bubble.webContents.capturePage()).toPNG());
    results.push({ mode, dockCorner: side, fixtureDock: characterManager.dockMonitor.bounds[0], layout, rendered });
  }
  characterManager.dockMonitor.bounds = [];
  characterManager.refreshDockLayout();
  bubbleManager.reposition('test');
  await until(() => bubbleManager.bubbleWindows.get('test').getBounds().width === bubbleManager.lastSizes.get('test').width, 'bubble returns to natural size');
  assert.equal(win.getBounds().width, 134);
  assert.equal(characterManager.getDisplayOptions().characterScale, 100);
}

async function run() {
  await app.whenReady();
  // Keep the remote-first image/CORS path deterministic without depending on CDN availability.
  let stalledImage = false;
  protocol.handle('https', request => {
    if (!stalledImage) {
      stalledImage = true;
      return new Promise(() => {});
    }
    const name = path.basename(new URL(request.url).pathname);
    const asset = path.join(root, 'src/assets/characters', name);
    return new globalThis.Response(fs.readFileSync(asset), { headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' } });
  });
  const { workArea } = screen.getPrimaryDisplay();
  const receiver = new BrowserWindow({ ...workArea, show: false, frame: false, webPreferences: { sandbox: true } });
  await receiver.loadURL('data:text/html,<body style="background:white">Overlay click receiver</body>');
  await receiver.webContents.executeJavaScript('window.clicks = 0; document.addEventListener("pointerdown", () => window.clicks++);');
  receiver.show();
  const mouse = process.platform === 'win32' ? windowsMouse() : null;
  try {
    for (const mode of ['2d', '3d']) {
      for (const scale of [50, 75, 100]) {
        characterManager = new CharacterWindowManager();
        characterManager.renderMode = mode;
        characterManager.characterScale = scale;
        const origin = { x: workArea.x + Math.round(workArea.width / 2), y: workArea.y + Math.round(workArea.height / 2) };
        characterManager.windowPosition = origin;
        bubbleManager = new BubbleWindowManager(id => characterManager.getWindow(id), () => 0, () => scale / 100);
        characterManager.onWindowMoved = id => bubbleManager.reposition(id);
        const { window: win } = characterManager.ensureWindow('test');
        const initialState = { state: 'working', character: 'clawd', project: 'test' };
        characterManager.entry.state = initialState;
        const center = { x: Math.round(67 * scale / 100), y: Math.round(69 * scale / 100) };
        await until(async () => {
          if (win.webContents.isLoading()) return false;
          await win.webContents.executeJavaScript(`document.dispatchEvent(new MouseEvent('mousemove', { clientX: ${center.x}, clientY: ${center.y} }))`);
          return ignored.get(win.webContents.id) === false;
        }, `${mode}/${scale} renderer initialized`);
        let replayedState;
        await until(async () => {
          replayedState = await win.webContents.executeJavaScript('(() => { let state; const stop = window.electronAPI.onStateUpdate(value => { state = value; }); stop(); return state; })()');
          return replayedState !== undefined;
        }, 'initial state IPC arrives');
        assert.deepEqual(replayedState, initialState, 'startup state survives asynchronous image loading');
        await win.webContents.executeJavaScript("window.mouseEvents = []; for (const type of ['mousemove', 'pointermove', 'mouseleave']) document.addEventListener(type, e => { window.mouseEvents.push({ type, x: e.clientX, y: e.clientY }); if (window.mouseEvents.length > 20) window.mouseEvents.shift(); }); document.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 0 }))");
        await until(() => ignored.get(win.webContents.id) === true, 'transparent corner');
        await bubbleManager.update('test', { state: { state: 'working', project: 'Overlay test' }, speechBubbleFields: { status: true, project: true } });
        const bubble = bubbleManager.bubbleWindows.get('test');
        await delay(100);
        const start = { character: win.getBounds(), bubble: bubble.getBounds() };
        for (let i = 1; i <= 30; i++) {
          characterManager.positionWindow(win, origin.x + i, origin.y + i);
          await delay(10);
        }
        characterManager.positionWindow(win, origin.x, origin.y);
        await until(() => {
          const b = bubble.getBounds();
          return b.x === start.bubble.x && b.y === start.bubble.y;
        }, 'bubble returns to original position');
        assert.deepEqual(win.getBounds(), start.character);
        assert.deepEqual(bubble.getBounds(), start.bubble);
        if (mouse) {
          await nativeClickTest(mouse, receiver, win, center, { x: 1, y: 1 });
          await nativeClickTest(mouse, receiver, bubble, { x: 30, y: 20 }, { x: 1, y: 1 });
          await nativeDragTest(mouse, win, center);
          await nativeDragTest(mouse, bubble, { x: 30, y: 20 });
          const bubbleBounds = bubble.getBounds();
          await mouse.send('move', { x: bubbleBounds.x + 30, y: bubbleBounds.y + 20 });
          await until(() => ignored.get(bubble.webContents.id) === false, 'bubble drag hit before removal');
          await mouse.send('down');
          await until(() => characterManager.dragOrigin !== null, 'bubble drag before removal');
          bubbleManager.destroy('test');
          await until(() => characterManager.dragOrigin === null, 'removed bubble ends its drag');
          await mouse.send('up');
        }
        const label = `${mode}-${scale}`;
        fs.writeFileSync(path.join(output, `${label}.png`), (await win.webContents.capturePage()).toPNG());
        results.push({ mode, scale, devicePixelRatio: await win.webContents.executeJavaScript('devicePixelRatio'), initial: start, nativeClicks: !!mouse });
        if (process.platform === 'darwin' && scale === 100) await verifyDockCorners(win, mode);
        bubbleManager.cleanup();
        characterManager.cleanup();
        win.destroy();
        assert.deepEqual(errors, [], 'renderer errors');
      }
    }
  } finally {
    mouse?.close();
    receiver.destroy();
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ platform: process.platform, electron: process.versions.electron, displays: screen.getAllDisplays(), results }, null, 2));
  console.log(JSON.stringify(results));
}

const timeout = setTimeout(() => { console.error('Overlay verification timed out'); app.exit(1); }, 120000);
run().then(() => { clearTimeout(timeout); app.exit(0); }).catch(async error => {
  const windows = [];
  for (const win of BrowserWindow.getAllWindows()) {
    windows.push({ bounds: win.getBounds(), visible: win.isVisible(), ignored: ignored.get(win.webContents.id), mouseEvents: await win.webContents.executeJavaScript('window.mouseEvents').catch(() => null) });
    fs.writeFileSync(path.join(output, `failure-${win.id}.png`), (await win.webContents.capturePage()).toPNG());
  }
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, cursor: screen.getCursorScreenPoint(), displays: screen.getAllDisplays(), windows, errors, results }, null, 2));
  console.error(error);
  app.exit(1);
});
