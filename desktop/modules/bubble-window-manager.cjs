/**
 * Speech bubble window management for Character Only Mode
 * One small transparent, click-through BrowserWindow per project, positioned
 * in screen coordinates relative to that project's character window using a
 * d3-force simulation (forceLink + forceCollide) so it never overlaps the
 * character and stays on-screen.
 */

'use strict';

const { BrowserWindow, screen } = require('electron');
const path = require('path');

// The character sprite's center offset and collision radius within the
// character window, matching the rendering engine's layout constants
// (CHAR_X_BASE=22, CHAR_Y_BASE=20, CHAR_SIZE=128) — kept in sync manually
// since those aren't exported by the remote engine. The radius is generous
// (measured opaque sprite bounds span nearly the full 128x128 canvas for some
// characters) since the bubble now has the whole screen to move in.
const CHARACTER_OFFSET = { x: 86, y: 84 };
const CHARACTER_RADIUS = 70;
const BUBBLE_COLLIDE_PADDING = 4;
const LINK_DISTANCE = 100;
const BIAS_DISTANCE = 100;
const SCREEN_MARGIN = 8;

// Animate the bubble sliding to a new position instead of teleporting there.
const MOVE_ANIMATION_STEPS = 10;
const MOVE_ANIMATION_INTERVAL_MS = 16;

const METRIC_ICONS = {
  memory: '🧠',
  usage5h: '⏱️',
  usageWeek: '📅'
};

/**
 * Build the bubble.html content payload: the project field renders as plain
 * text, memory/usage5h/usageWeek render as an icon + inline bar + percentage
 * (bubble.html's __setBubbleContent draws the bar itself from `value`).
 * @param {Object|null} state
 * @param {Object|null} speechBubbleFields
 * @returns {Object.<string, {type: 'text', text: string}|{type: 'metric', icon: string, value: number}>}
 */
function buildFieldPayload(state, speechBubbleFields) {
  const payload = {};

  if (speechBubbleFields && speechBubbleFields.project && state && state.project) {
    payload.project = { type: 'text', text: String(state.project) };
  }

  for (const field of ['memory', 'usage5h', 'usageWeek']) {
    const value = state && state[field];
    if (speechBubbleFields && speechBubbleFields[field] && value !== undefined && value !== null && value !== '') {
      payload[field] = { type: 'metric', icon: METRIC_ICONS[field], value: Number(value) };
    }
  }

  return payload;
}

class BubbleWindowManager {
  /**
   * @param {(projectId: string) => Electron.BrowserWindow|null} getCharacterWindow
   */
  constructor(getCharacterWindow) {
    this.getCharacterWindow = getCharacterWindow;
    this.bubbleWindows = new Map(); // Map<projectId, BrowserWindow>
    this.lastSizes = new Map(); // Map<projectId, {width, height}>
    this.animationTimers = new Map(); // Map<projectId, NodeJS.Timeout>
    this.d3ForceModule = null;
  }

  async getD3Force() {
    if (!this.d3ForceModule) {
      this.d3ForceModule = await import('d3-force');
    }
    return this.d3ForceModule;
  }

  isWindowValid(win) {
    return !!(win && !win.isDestroyed());
  }

  async ensureBubbleWindow(projectId) {
    let win = this.bubbleWindows.get(projectId);
    if (this.isWindowValid(win)) return win;

    win = new BrowserWindow({
      width: 10,
      height: 10,
      x: 0,
      y: 0,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    win.setIgnoreMouseEvents(true);
    this.bubbleWindows.set(projectId, win);

    win.on('closed', () => {
      this.stopAnimation(projectId);
      this.bubbleWindows.delete(projectId);
      this.lastSizes.delete(projectId);
    });

    win.loadFile(path.join(__dirname, '..', 'bubble.html'));
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));

    return win;
  }

  /**
   * Refresh a project's speech bubble content and position, creating or
   * hiding the bubble window as needed. Re-checks the character window's
   * validity after every await — its window can close mid-flight (each
   * executeJavaScript round-trip takes a moment), and without re-checking, a
   * stale call can recreate a bubble window right after destroy() removed it.
   * @param {string} projectId
   * @param {{state: Object|null, speechBubbleFields: Object, characterOnlyMode: boolean}} options
   */
  async update(projectId, { state, speechBubbleFields, characterOnlyMode }) {
    const fields = characterOnlyMode ? buildFieldPayload(state, speechBubbleFields) : {};

    if (!characterOnlyMode || Object.keys(fields).length === 0 || !this.isWindowValid(this.getCharacterWindow(projectId))) {
      this.hide(projectId);
      return;
    }

    const win = await this.ensureBubbleWindow(projectId);
    if (!this.isWindowValid(win) || !this.isWindowValid(this.getCharacterWindow(projectId))) {
      this.destroy(projectId);
      return;
    }

    // First pass: render content with a neutral tail position, just to
    // measure the bubble's natural size (varies with which fields/text show).
    const size = await win.webContents.executeJavaScript(
      `window.__setBubbleContent(${JSON.stringify(fields)}, 0, 'bottom')`
    );
    if (!this.isWindowValid(win) || !this.isWindowValid(this.getCharacterWindow(projectId))) {
      this.destroy(projectId);
      return;
    }
    this.lastSizes.set(projectId, size);

    const wasVisible = win.isVisible();
    const placement = await this.computePlacement(this.getCharacterWindow(projectId), size);
    if (!placement || !this.isWindowValid(win) || !this.isWindowValid(this.getCharacterWindow(projectId))) {
      this.destroy(projectId);
      return;
    }

    // Second pass: point the tail at the character now that we know the
    // bubble's final position relative to it.
    await win.webContents.executeJavaScript(
      `window.__setBubbleContent(${JSON.stringify(fields)}, ${placement.tailX}, ${JSON.stringify(placement.tailSide)})`
    );
    if (!this.isWindowValid(win) || !this.isWindowValid(this.getCharacterWindow(projectId))) {
      this.destroy(projectId);
      return;
    }

    if (wasVisible) {
      this.animateTo(projectId, win, { x: placement.x, y: placement.y, width: size.width, height: size.height });
    } else {
      win.setBounds({ x: placement.x, y: placement.y, width: size.width, height: size.height });
    }
    if (!win.isVisible()) win.showInactive();
  }

  /**
   * Recompute a project's bubble position without touching its content —
   * called when the character window moves.
   * @param {string} projectId
   */
  reposition(projectId) {
    const win = this.bubbleWindows.get(projectId);
    const charWindow = this.getCharacterWindow(projectId);
    const size = this.lastSizes.get(projectId);
    if (!this.isWindowValid(win) || !this.isWindowValid(charWindow) || !size || !win.isVisible()) return;

    this.computePlacement(charWindow, size).then((placement) => {
      if (!placement || !this.isWindowValid(win) || !this.isWindowValid(this.getCharacterWindow(projectId))) return;
      this.animateTo(projectId, win, { x: placement.x, y: placement.y, width: size.width, height: size.height });
    });
  }

  /**
   * Slide a bubble window to a new position/size over a short animation
   * instead of teleporting it there, cancelling any animation already in
   * flight for this project.
   * @param {string} projectId
   * @param {Electron.BrowserWindow} win
   * @param {{x: number, y: number, width: number, height: number}} target
   */
  animateTo(projectId, win, target) {
    this.stopAnimation(projectId);

    const start = win.getBounds();
    let step = 0;

    const timer = setInterval(() => {
      step++;
      if (!this.isWindowValid(win)) {
        this.stopAnimation(projectId);
        return;
      }

      const t = Math.min(1, step / MOVE_ANIMATION_STEPS);
      const eased = 1 - (1 - t) * (1 - t); // ease-out
      win.setBounds({
        x: Math.round(start.x + (target.x - start.x) * eased),
        y: Math.round(start.y + (target.y - start.y) * eased),
        width: Math.round(start.width + (target.width - start.width) * eased),
        height: Math.round(start.height + (target.height - start.height) * eased)
      });

      if (t >= 1) {
        this.stopAnimation(projectId);
      }
    }, MOVE_ANIMATION_INTERVAL_MS);

    this.animationTimers.set(projectId, timer);
  }

  /**
   * @param {string} projectId
   */
  stopAnimation(projectId) {
    const timer = this.animationTimers.get(projectId);
    if (timer) {
      clearInterval(timer);
      this.animationTimers.delete(projectId);
    }
  }

  /**
   * Run the collision/link simulation and return the clamped on-screen
   * placement for the bubble window, plus the tail's horizontal offset.
   * @param {Electron.BrowserWindow} charWindow
   * @param {{width: number, height: number}} size
   * @returns {Promise<{x: number, y: number, tailX: number}|null>}
   */
  async computePlacement(charWindow, size) {
    const { forceSimulation, forceCollide, forceLink, forceX, forceY } = await this.getD3Force();
    if (!this.isWindowValid(charWindow)) return null;

    const charBounds = charWindow.getBounds();
    const charCenterX = charBounds.x + CHARACTER_OFFSET.x;
    const charCenterY = charBounds.y + CHARACTER_OFFSET.y;

    const display = screen.getDisplayNearestPoint({ x: charCenterX, y: charCenterY });
    const { workArea } = display;
    const onRightHalf = charCenterX > workArea.x + workArea.width / 2;

    const bubbleRadius = Math.max(size.width, size.height) / 2;

    // The bias point only helps if it's far enough from the character that
    // the on-screen clamp below never has to drag it back into overlap —
    // e.g. new windows spawn flush against the top of the screen, so "always
    // bias upward" has no room there and the clamp would just pull the
    // simulation's result back down into the character. Flip toward
    // whichever side of each axis actually has room instead.
    const requiredClearance = CHARACTER_RADIUS + bubbleRadius + BUBBLE_COLLIDE_PADDING + SCREEN_MARGIN;

    let biasXOffset = onRightHalf ? -BIAS_DISTANCE : BIAS_DISTANCE;
    const spaceX = biasXOffset < 0 ? charCenterX - workArea.x : workArea.x + workArea.width - charCenterX;
    if (spaceX < requiredClearance) biasXOffset = -biasXOffset;
    const biasX = charCenterX + biasXOffset;

    let biasYOffset = -BIAS_DISTANCE; // prefer above, matching a speech bubble's usual placement
    const spaceAbove = charCenterY - workArea.y;
    if (spaceAbove < requiredClearance) biasYOffset = BIAS_DISTANCE;
    const biasY = charCenterY + biasYOffset;

    const nodes = [
      { id: 'character', x: charCenterX, y: charCenterY, fx: charCenterX, fy: charCenterY, radius: CHARACTER_RADIUS },
      { id: 'bubble', x: biasX, y: biasY, radius: bubbleRadius }
    ];

    const simulation = forceSimulation(nodes)
      .force('link', forceLink([{ source: 'character', target: 'bubble' }]).id((d) => d.id).distance(LINK_DISTANCE).strength(0.3))
      .force('collide', forceCollide((d) => d.radius + BUBBLE_COLLIDE_PADDING))
      .force('x', forceX((d) => (d.id === 'bubble' ? biasX : d.x)).strength(0.1))
      .force('y', forceY((d) => (d.id === 'bubble' ? biasY : d.y)).strength(0.1))
      .stop();

    for (let i = 0; i < 120; i++) simulation.tick();

    const bubbleNode = nodes[1];
    const minX = workArea.x + SCREEN_MARGIN + size.width / 2;
    const maxX = workArea.x + workArea.width - SCREEN_MARGIN - size.width / 2;
    const minY = workArea.y + SCREEN_MARGIN + size.height / 2;
    const maxY = workArea.y + workArea.height - SCREEN_MARGIN - size.height / 2;
    const clampedX = Math.min(maxX, Math.max(minX, bubbleNode.x));
    const clampedY = Math.min(maxY, Math.max(minY, bubbleNode.y));

    const x = Math.round(clampedX - size.width / 2);
    const y = Math.round(clampedY - size.height / 2);
    const tailX = Math.max(12, Math.min(size.width - 12, Math.round(charCenterX - x)));
    // Which edge of the bubble the tail sits on: the bubble usually ends up
    // above the character, but can land below it when there's no room above
    // (see biasYOffset), so the tail must flip to keep pointing at it.
    const tailSide = clampedY < charCenterY ? 'bottom' : 'top';

    return { x, y, tailX, tailSide };
  }

  /**
   * @param {string} projectId
   */
  hide(projectId) {
    this.stopAnimation(projectId);
    const win = this.bubbleWindows.get(projectId);
    if (this.isWindowValid(win) && win.isVisible()) win.hide();
  }

  /**
   * @param {string} projectId
   */
  destroy(projectId) {
    this.stopAnimation(projectId);
    const win = this.bubbleWindows.get(projectId);
    if (this.isWindowValid(win)) win.destroy();
    this.bubbleWindows.delete(projectId);
    this.lastSizes.delete(projectId);
  }

  /**
   * Destroy all bubble windows on app quit.
   */
  cleanup() {
    for (const projectId of this.animationTimers.keys()) {
      this.stopAnimation(projectId);
    }
    for (const [, win] of this.bubbleWindows) {
      if (this.isWindowValid(win)) win.destroy();
    }
    this.bubbleWindows.clear();
    this.lastSizes.clear();
  }
}

module.exports = { BubbleWindowManager };
