/**
 * Tests for bubble-window-manager.cjs
 */

jest.mock('electron', () => {
  const { EventEmitter } = require('events');

  class MockWebContents extends EventEmitter {
    executeJavaScript() {
      return Promise.resolve({ width: 100, height: 40 });
    }
  }

  class MockBrowserWindow extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.webContents = new MockWebContents();
      this._destroyed = false;
      this._visible = false;
      this._alwaysOnTop = !!opts.alwaysOnTop;
      this._bounds = { x: opts.x || 0, y: opts.y || 0, width: opts.width || 10, height: opts.height || 10 };
      MockBrowserWindow.instances.push(this);
    }
    loadFile() {}
    isDestroyed() { return this._destroyed; }
    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      this.emit('closed');
    }
    setAlwaysOnTop(v) { this._alwaysOnTop = v; }
    isAlwaysOnTop() { return this._alwaysOnTop; }
    setIgnoreMouseEvents() {}
    getBounds() { return this._bounds; }
    setBounds(b) { this._bounds = { ...this._bounds, ...b }; }
    isVisible() { return this._visible; }
    show() { this._visible = true; }
    showInactive() { this._visible = true; }
    hide() { this._visible = false; }
  }
  MockBrowserWindow.instances = [];

  return {
    BrowserWindow: MockBrowserWindow,
    screen: {
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    }
  };
});

const { BrowserWindow } = require('electron');
const { BubbleWindowManager, buildFieldPayload } = require('../src/modules/bubble-window-manager.cjs');

function freshManager(getCharacterWindow = () => null) {
  BrowserWindow.instances.length = 0;
  return new BubbleWindowManager(getCharacterWindow);
}

describe('buildFieldPayload status text', () => {
  const fields = { status: true };

  test('maps states to the same text as the window mode status line', () => {
    expect(buildFieldPayload({ state: 'start' }, fields).status.text).toBe('Hello!');
    expect(buildFieldPayload({ state: 'idle' }, fields).status.text).toBe('Ready');
    expect(buildFieldPayload({ state: 'notification' }, fields).status.text).toBe('Input?');
    expect(buildFieldPayload({ state: 'sleep' }, fields).status.text).toBe('Zzz...');
    expect(buildFieldPayload({ state: 'done' }, fields).status.text).toBe('Done!');
  });

  test('working state uses the tool-based text', () => {
    expect(buildFieldPayload({ state: 'working', tool: 'Read' }, fields).status.text).toBe('Reading');
    expect(buildFieldPayload({ state: 'working', tool: 'Bash' }, fields).status.text).toBe('Running');
    expect(buildFieldPayload({ state: 'working' }, fields).status.text).toBe('Working');
    expect(buildFieldPayload({ state: 'working', tool: 'UnknownTool' }, fields).status.text).toBe('Working');
  });

  test('falls back to a capitalized state name for unknown states', () => {
    expect(buildFieldPayload({ state: 'custom' }, fields).status.text).toBe('Custom');
  });

  test('loading states carry dot flags: working fast, thinking-style slow', () => {
    expect(buildFieldPayload({ state: 'working' }, fields).status).toMatchObject({ showLoading: true, slow: false });
    expect(buildFieldPayload({ state: 'thinking' }, fields).status).toMatchObject({ showLoading: true, slow: true });
    expect(buildFieldPayload({ state: 'planning' }, fields).status).toMatchObject({ showLoading: true, slow: true });
    expect(buildFieldPayload({ state: 'packing' }, fields).status).toMatchObject({ showLoading: true, slow: true });
  });

  test('non-loading states carry no dot flags', () => {
    expect(buildFieldPayload({ state: 'idle' }, fields).status.showLoading).toBeUndefined();
    expect(buildFieldPayload({ state: 'done' }, fields).status.showLoading).toBeUndefined();
  });
});

describe('buildFieldPayload model-scoped weekly usage', () => {
  const fields = { usageWeekModel: true };

  test('renders the model week metric with its label and no reset time', () => {
    const payload = buildFieldPayload({
      state: 'working',
      usageWeekModel: 12,
      usageWeekModelResetsIn: 6300,
      usageWeekModelLabel: 'Fable'
    }, fields);

    // No resetIn even though the collector sent one — the model-scoped
    // window resets together with the Week row, so the row shows "Fable 12%".
    expect(payload.usageWeekModel).toEqual({
      type: 'metric',
      icon: '🎯',
      value: 12,
      label: 'Fable'
    });
  });

  test('omits the label when the collector did not send one', () => {
    const payload = buildFieldPayload({ state: 'working', usageWeekModel: 12 }, fields);

    expect(payload.usageWeekModel.label).toBeUndefined();
    expect(payload.usageWeekModel.value).toBe(12);
  });

  test('omits the row when the field toggle is off', () => {
    const payload = buildFieldPayload(
      { state: 'working', usageWeekModel: 12 },
      { usageWeekModel: false }
    );

    expect(payload.usageWeekModel).toBeUndefined();
  });
});

describe('ensureBubbleWindow', () => {
  test('concurrent calls for the same project share one window instead of racing', async () => {
    const manager = freshManager();

    const p1 = manager.ensureBubbleWindow('proj-a');
    const p2 = manager.ensureBubbleWindow('proj-a');

    expect(BrowserWindow.instances).toHaveLength(1);

    let p2Resolved = false;
    p2.then(() => { p2Resolved = true; });

    // Flush pending microtasks/timers without the page having loaded yet —
    // the second caller must still be waiting, not resolved with a
    // not-yet-loaded window.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p2Resolved).toBe(false);

    BrowserWindow.instances[0].webContents.emit('did-finish-load');

    const [win1, win2] = await Promise.all([p1, p2]);
    expect(win1).toBe(BrowserWindow.instances[0]);
    expect(win2).toBe(win1);
  });

  test('destroying the window mid-load resolves with null instead of hanging', async () => {
    const manager = freshManager();

    const pending = manager.ensureBubbleWindow('proj-b');
    expect(BrowserWindow.instances).toHaveLength(1);

    manager.destroy('proj-b');

    const win = await pending;
    expect(win).toBeNull();
  });

  test('a failed load destroys the window and resolves with null', async () => {
    const manager = freshManager();

    const pending = manager.ensureBubbleWindow('proj-c');
    const win = BrowserWindow.instances[0];
    win.webContents.emit('did-fail-load');

    const result = await pending;
    expect(result).toBeNull();
    expect(win.isDestroyed()).toBe(true);
  });

  test('reuses an already-loaded window without creating a new one', async () => {
    const manager = freshManager();

    const p = manager.ensureBubbleWindow('proj-d');
    BrowserWindow.instances[0].webContents.emit('did-finish-load');
    const first = await p;

    const second = await manager.ensureBubbleWindow('proj-d');
    expect(second).toBe(first);
    expect(BrowserWindow.instances).toHaveLength(1);
  });
});

describe('update', () => {
  test('a rejected executeJavaScript destroys the bubble instead of leaking a rejection', async () => {
    let charWindow;
    const manager = freshManager(() => charWindow);
    charWindow = new BrowserWindow({});

    const updatePromise = manager.update('proj-e', {
      state: { state: 'idle' },
      speechBubbleFields: { status: true }
    });

    // The bubble window is created after the character-window validity check.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const bubbleWin = BrowserWindow.instances[1];
    bubbleWin.webContents.executeJavaScript = () => Promise.reject(new Error('Script failed'));
    bubbleWin.webContents.emit('did-finish-load');

    await expect(updatePromise).resolves.toBeUndefined();
    expect(bubbleWin.isDestroyed()).toBe(true);
  });
});
