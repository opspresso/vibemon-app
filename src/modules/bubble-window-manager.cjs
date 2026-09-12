/**
 * Speech bubble window management
 * One small transparent BrowserWindow per project, positioned
 * in screen coordinates relative to the character window using a d3-force
 * simulation (forceLink + forceCollide) so it never overlaps the character
 * and stays on-screen.
 */

'use strict';

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { trackWindowPointer } = require('./window-pointer.cjs');
const { STATE_COLORS, STATE_TEXTS, TOOL_TEXTS, LOADING_STATES } = require('../shared/config.cjs');

// The character sprite's center offset and collision radius within a
// full-size character window, matching the rendering engine's layout
// constants (CHAR_X_BASE=3, CHAR_Y_BASE=5, CHAR_SIZE=128 in
// src/engine/vibemon-engine.js). The radius is generous
// (measured opaque sprite bounds span nearly the full 128x128 canvas for some
// characters) since the bubble now has the whole screen to move in.
// The Character Size setting shrinks the window, so both are scaled by the
// configured render scale in computePlacement().
const CHARACTER_OFFSET = { x: 67, y: 69 };
const CHARACTER_RADIUS = 70;
const BUBBLE_COLLIDE_PADDING = 4;
const LINK_DISTANCE = 100;
const BIAS_DISTANCE = 100;

// How close the character window's edge must be to the work area's edge to
// count as "pinned" there (the character window is continuously clamped on
// screen, so a pinned edge sits flush — this just tolerates rounding). The
// configured edge margin is added on top, since the character window is
// clamped to the work area inset by it.
const EDGE_PIN_EPSILON = 2;

// Must match character-window-manager.cjs's ALWAYS_ON_TOP_LEVEL so the
// bubble stacks at the same level as its character window.
const ALWAYS_ON_TOP_LEVEL = process.platform === 'darwin' ? 'floating' : 'screen-saver';

// Backstop for a bubble window that never fires 'did-finish-load' or
// 'did-fail-load' (e.g. loadFile hangs) — destroy it so ensureBubbleWindow()
// doesn't wait forever.
const LOAD_TIMEOUT_MS = 5000;

const METRIC_ICONS = {
  memory: '🧠',
  usage5h: '⏱️',
  usageWeek: '📅',
  usageWeekModel: '🎯'
};

const TEXT_ICONS = {
  project: '📁',
  model: '🤖'
};

// Plan-usage quotas reset on rolling windows; the collector can
// optionally send how many minutes remain until that reset in these fields,
// shown next to the usual usage percentage (e.g. "18% · 24m"). Absent for
// collectors that don't send it yet, or for memory (not a resetting quota).
const RESET_MINUTES_FIELDS = {
  usage5h: 'usage5hResetsIn',
  usageWeek: 'usageWeekResetsIn',
  usageWeekModel: 'usageWeekModelResetsIn'
};

/**
 * Build the bubble.html content payload: status/project/model render as plain
 * text, and usage metrics render as an icon + inline bar + percentage
 * (bubble.html's __setBubbleContent draws the bar itself from `value`).
 * @param {Object|null} state
 * @param {Object|null} speechBubbleFields
 * @returns {Object.<string, {type: 'text', text: string}|{type: 'metric', icon: string, value: number, resetIn: number|undefined}>}
 */
function buildFieldPayload(state, speechBubbleFields) {
  const payload = {};

  if (speechBubbleFields && speechBubbleFields.status && state && state.state) {
    const stateKey = String(state.state);
    // State/tool -> text mapping from constants.json (STATE_TEXTS/TOOL_TEXTS).
    const text = stateKey === 'working'
      ? TOOL_TEXTS[String(state.tool || '').toLowerCase()] || TOOL_TEXTS.default
      : STATE_TEXTS[stateKey] || stateKey.charAt(0).toUpperCase() + stateKey.slice(1);
    payload.status = { type: 'text', text };
    if (LOADING_STATES.includes(stateKey)) {
      // Loading dots beside the text; thinking-style states animate slower
      // than working (bubble.html's DOT_SLOWDOWN).
      payload.status.showLoading = true;
      payload.status.slow = stateKey !== 'working';
    }
  }

  if (speechBubbleFields && speechBubbleFields.project && state && state.project) {
    payload.project = { type: 'text', text: `${TEXT_ICONS.project} ${state.project}` };
  }

  if (speechBubbleFields && speechBubbleFields.model && state && state.model) {
    payload.model = { type: 'text', text: `${TEXT_ICONS.model} ${state.model}` };
  }

  for (const field of ['memory', 'usage5h', 'usageWeek', 'usageWeekModel']) {
    const value = state && state[field];
    if (speechBubbleFields && speechBubbleFields[field] && value !== undefined && value !== null && value !== '') {
      const metric = { type: 'metric', icon: METRIC_ICONS[field], value: Number(value) };

      const resetField = RESET_MINUTES_FIELDS[field];
      const resetValue = resetField && state[resetField];
      if (resetValue !== undefined && resetValue !== null && resetValue !== '') {
        metric.resetIn = Number(resetValue);
      }

      if (field === 'usageWeekModel' && typeof state.usageWeekModelLabel === 'string' && state.usageWeekModelLabel) {
        // Model-scoped weekly limit: prefix the percentage with the model
        // name (e.g. "Fable 12%") so the row reads distinctly from Week.
        metric.label = state.usageWeekModelLabel;
      }

      payload[field] = metric;
    }
  }

  return payload;
}

/**
 * Same state -> background color mapping (STATE_COLORS) used for the tray
 * icon, so the bubble's background tracks the current state. The character
 * window's own canvas is transparent — the bubble is where state color shows.
 * @param {Object|null} state
 * @returns {string} hex color
 */
function resolveBgColor(state) {
  return (state && STATE_COLORS[state.state]) || STATE_COLORS.idle;
}

class BubbleWindowManager {
  /**
   * @param {(projectId: string) => Electron.BrowserWindow|null} getCharacterWindow
   * @param {() => number} [getEdgeMargin] - the configured gap from the
   *   screen's edges, shared with the character window: it widens the
   *   pinned-edge check and is the bubble's own minimum distance from an edge
   * @param {() => number} [getCharacterScale] - the renderer's configured scale
   */
  constructor(getCharacterWindow, getEdgeMargin = () => 0, getCharacterScale = () => 1, dock = {}) {
    this.getCharacterWindow = getCharacterWindow;
    this.getEdgeMargin = getEdgeMargin;
    this.getCharacterScale = getCharacterScale;
    this.getDockLayout = dock.getLayout || (() => null);
    this.setBubbleSize = dock.setBubbleSize || (() => {});
    this.bubbleWindows = new Map(); // Map<projectId, BrowserWindow>
    this.lastSizes = new Map(); // Map<projectId, {width, height}>
    this.lastFields = new Map(); // Map<projectId, Object> — needed so reposition() can re-render the tail
    this.lastBgColors = new Map(); // Map<projectId, string> — same, for the state-colored background
    this.loadingWindows = new Map(); // Map<projectId, Promise<boolean>> — in-flight bubble.html load
    this.d3ForceModule = null;
    this.placementRequests = new Map();
    this.contentRequests = new Map();
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
    const loading = this.loadingWindows.get(projectId);
    if (loading) {
      const ready = await loading;
      const win = this.bubbleWindows.get(projectId);
      return ready && this.isWindowValid(win) ? win : null;
    }

    let win = this.bubbleWindows.get(projectId);
    if (this.isWindowValid(win)) return win;

    const charWindow = this.getCharacterWindow(projectId);
    const startsOnTop = this.isWindowValid(charWindow) && charWindow.isAlwaysOnTop();

    win = new BrowserWindow({
      width: 10,
      height: 10,
      x: 0,
      y: 0,
      frame: false,
      // Allow the complete bubble to occupy a free corner in the Dock strip.
      enableLargerThanScreen: process.platform === 'darwin',
      thickFrame: false,
      transparent: true,
      alwaysOnTop: startsOnTop,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    trackWindowPointer(win);
    if (typeof win.webContents.setWindowOpenHandler === 'function') {
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    }
    if (typeof win.webContents.on === 'function') {
      win.webContents.on('will-navigate', (event) => event.preventDefault());
    }
    if (startsOnTop) win.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);
    win.setIgnoreMouseEvents(true, { forward: true });
    this.bubbleWindows.set(projectId, win);

    win.on('closed', () => {
      this.contentRequests.delete(projectId);
      this.placementRequests.delete(projectId);
      this.bubbleWindows.delete(projectId);
      this.loadingWindows.delete(projectId);
      this.lastSizes.delete(projectId);
      this.lastFields.delete(projectId);
      this.lastBgColors.delete(projectId);
    });

    // A load that never settles (finish, fail, or the window closing) would
    // otherwise leave every ensureBubbleWindow() caller awaiting forever.
    const timeoutTimer = setTimeout(() => {
      if (this.isWindowValid(win)) win.destroy();
    }, LOAD_TIMEOUT_MS);

    const loadPromise = new Promise((resolve) => {
      win.webContents.once('did-finish-load', () => {
        clearTimeout(timeoutTimer);
        resolve(true);
      });
      win.once('closed', () => {
        clearTimeout(timeoutTimer);
        resolve(false);
      });
    });
    // A failed load leaves the window alive but blank; destroy it so it
    // doesn't linger as a "valid" window that never rendered bubble.html.
    win.webContents.once('did-fail-load', () => {
      if (this.isWindowValid(win)) win.destroy();
    });

    this.loadingWindows.set(projectId, loadPromise);
    win.loadFile(path.join(__dirname, '..', 'bubble.html'));

    const ready = await loadPromise;
    this.loadingWindows.delete(projectId);

    return ready ? win : null;
  }

  /**
   * Run script in the bubble window, absorbing the rejection that
   * executeJavaScript throws when the window is destroyed mid-flight (the
   * same race the isWindowValid re-checks guard against). Returns null on
   * failure so callers take their existing invalid-window path.
   * @param {BrowserWindow} win
   * @param {string} code
   * @returns {Promise<any|null>}
   */
  async execInBubble(win, code) {
    try {
      return await win.webContents.executeJavaScript(code);
    } catch {
      return null;
    }
  }

  /**
   * Refresh a project's speech bubble content and position, creating or
   * hiding the bubble window as needed. Re-checks the character window's
   * validity after every await — its window can close mid-flight (each
   * executeJavaScript round-trip takes a moment), and without re-checking, a
   * stale call can recreate a bubble window right after destroy() removed it.
   * @param {string} projectId
   * @param {{state: Object|null, speechBubbleFields: Object}} options
   */
  async update(projectId, { state, speechBubbleFields }) {
    const request = {};
    this.contentRequests.set(projectId, request);
    this.placementRequests.delete(projectId);
    const isCurrent = () => this.contentRequests.get(projectId) === request;
    const fields = buildFieldPayload(state, speechBubbleFields);

    if (Object.keys(fields).length === 0 || !this.isWindowValid(this.getCharacterWindow(projectId))) {
      this.hide(projectId);
      return;
    }

    const bgColor = resolveBgColor(state);

    const win = await this.ensureBubbleWindow(projectId);
    if (!isCurrent()) return;
    if (!this.isWindowValid(win) || !this.isWindowValid(this.getCharacterWindow(projectId))) {
      this.destroy(projectId);
      return;
    }

    // First pass: render content with a neutral tail position, just to
    // measure the bubble's natural size (varies with which fields/text show).
    const size = await this.execInBubble(
      win,
      `window.__setBubbleContent(${JSON.stringify(fields)}, 0, 'bottom', ${JSON.stringify(bgColor)})`
    );
    if (!isCurrent()) return;
    if (!size || !this.isWindowValid(win) || !this.isWindowValid(this.getCharacterWindow(projectId))) {
      this.destroy(projectId);
      return;
    }
    this.placementRequests.delete(projectId);
    this.lastSizes.set(projectId, size);
    this.lastFields.set(projectId, fields);
    this.lastBgColors.set(projectId, bgColor);
    this.setBubbleSize(size);

    const placement = await this.computePlacement(this.getCharacterWindow(projectId), size);
    if (!isCurrent()) return;
    if (!placement || !this.isWindowValid(win) || !this.isWindowValid(this.getCharacterWindow(projectId))) {
      this.destroy(projectId);
      return;
    }

    await this.execInBubble(win,
      `window.__setBubbleContent(${JSON.stringify(fields)}, ${placement.tailOffset}, ${JSON.stringify(placement.tailSide)}, ${JSON.stringify(bgColor)}, ${placement.scale || 1})`);
    if (!isCurrent() || !this.isWindowValid(win) || !this.isWindowValid(this.getCharacterWindow(projectId))) return;
    this.applyPlacement(win, placement, size);
    this.syncAlwaysOnTop(projectId);
    if (!win.isVisible()) win.showInactive();
    this.reposition(projectId);
  }

  /**
   * Recompute a project's bubble position and tail direction — called when
   * the character window moves. Must also re-render the tail (not just
   * reposition the window): the character can end up on a different side or
   * even flip above/below as it moves, and without refreshing the tail here
   * it would keep pointing at wherever the character used to be.
   * @param {string} projectId
   */
  reposition(projectId) {
    const win = this.bubbleWindows.get(projectId);
    const charWindow = this.getCharacterWindow(projectId);
    const size = this.lastSizes.get(projectId);
    const fields = this.lastFields.get(projectId);
    const bgColor = this.lastBgColors.get(projectId);
    if (!this.isWindowValid(win) || !this.isWindowValid(charWindow) || !size || !fields || !win.isVisible()) return;

    const request = {};
    this.placementRequests.set(projectId, request);
    const isCurrent = () => this.placementRequests.get(projectId) === request &&
      this.bubbleWindows.get(projectId) === win && this.getCharacterWindow(projectId) === charWindow &&
      this.isWindowValid(win) && this.isWindowValid(charWindow) && win.isVisible();
    this.computePlacement(charWindow, size).then(async (placement) => {
      if (!isCurrent()) return;
      if (!placement || !this.isWindowValid(win) || !this.isWindowValid(this.getCharacterWindow(projectId))) return;

      await this.execInBubble(
        win,
        `window.__setBubbleContent(${JSON.stringify(fields)}, ${placement.tailOffset}, ${JSON.stringify(placement.tailSide)}, ${JSON.stringify(bgColor)}, ${placement.scale || 1})`
      );
      if (!this.isWindowValid(win) || !this.isWindowValid(this.getCharacterWindow(projectId))) return;

      if (!isCurrent()) return;
      // Follow directly: restarting easing on every move leaves the bubble behind.
      // setPosition round-trips rounded native sizes and grows at fractional DPI.
      this.applyPlacement(win, placement, size);
    }).catch((err) => console.error('Bubble reposition failed:', err));
  }

  applyPlacement(win, placement, size) {
    const bounds = { x: placement.x, y: placement.y, width: placement.width || size.width, height: placement.height || size.height };
    const current = win.getBounds();
    const resized = current.width !== bounds.width || current.height !== bounds.height;
    if (resized) win.setResizable(true);
    win.setBounds(bounds);
    if (resized) {
      win.setResizable(false);
      win.setBounds(bounds);
    }
  }

  /**
   * Run the collision/link simulation and return the clamped on-screen
   * placement for the bubble window, plus which edge the tail sits on and
   * its offset along that edge.
   * @param {Electron.BrowserWindow} charWindow
   * @param {{width: number, height: number}} size
   * @returns {Promise<{x: number, y: number, tailOffset: number, tailSide: string}|null>}
   */
  async computePlacement(charWindow, size) {
    const dock = this.getDockLayout();
    if (dock?.bubble) return { ...dock.bubble, scale: dock.scale };
    const { forceSimulation, forceCollide, forceLink, forceX, forceY } = await this.getD3Force();
    if (!this.isWindowValid(charWindow)) return null;

    const charBounds = charWindow.getBounds();
    // Use the rendering setting, not native window bounds: Windows frame
    // insets and fractional-DPI rounding must not feed back into sprite scale.
    const charScale = this.getCharacterScale();
    const charCenterX = charBounds.x + CHARACTER_OFFSET.x * charScale;
    const charCenterY = charBounds.y + CHARACTER_OFFSET.y * charScale;
    const characterRadius = CHARACTER_RADIUS * charScale;

    const display = screen.getDisplayNearestPoint({ x: charCenterX, y: charCenterY });
    const { workArea } = display;
    const onRightHalf = charCenterX > workArea.x + workArea.width / 2;

    // How close to the screen's edges the bubble may be pushed. This used to
    // be a fixed 8px, which contradicted the Edge Margin setting at both
    // ends: it held the bubble back at margin 0, and let it sit closer than
    // the character it belongs to at larger margins. It only binds when the
    // bubble is squeezed against an edge — placement is otherwise driven by
    // the character's position below.
    const screenMargin = this.getEdgeMargin();

    const bubbleRadius = Math.max(size.width, size.height) / 2;

    // The bias point only helps if it's far enough from the character that
    // the on-screen clamp below never has to drag it back into overlap —
    // e.g. new windows spawn flush against the top of the screen, so "always
    // bias upward" has no room there and the clamp would just pull the
    // simulation's result back down into the character. Flip toward
    // whichever side of each axis actually has room instead.
    const requiredClearance = characterRadius + bubbleRadius + BUBBLE_COLLIDE_PADDING + screenMargin;

    let biasXOffset = onRightHalf ? -BIAS_DISTANCE : BIAS_DISTANCE;
    const spaceX = biasXOffset < 0 ? charCenterX - workArea.x : workArea.x + workArea.width - charCenterX;
    if (spaceX < requiredClearance) biasXOffset = -biasXOffset;

    let biasYOffset = -BIAS_DISTANCE; // prefer above, matching a speech bubble's usual placement
    const spaceAbove = charCenterY - workArea.y;
    if (spaceAbove < requiredClearance) biasYOffset = BIAS_DISTANCE;

    // The character window is continuously clamped on screen (see
    // character-window-manager.cjs's handleWindowMove), so when it's pinned
    // flush against an edge, force the bubble onto the axis that still has
    // room instead of the usual diagonal bias: pinned top/bottom -> bubble
    // beside the character; pinned left/right -> bubble above/below it.
    // A corner pin satisfies both checks — top/bottom wins there.
    const pinDistance = EDGE_PIN_EPSILON + this.getEdgeMargin();
    const pinnedTop = charBounds.y <= workArea.y + pinDistance;
    const pinnedBottom = (charBounds.y + charBounds.height) >= (workArea.y + workArea.height - pinDistance);
    const pinnedLeft = charBounds.x <= workArea.x + pinDistance;
    const pinnedRight = (charBounds.x + charBounds.width) >= (workArea.x + workArea.width - pinDistance);

    if (pinnedTop || pinnedBottom) {
      biasYOffset = 0;
    } else if (pinnedLeft || pinnedRight) {
      biasXOffset = 0;
    }

    const biasX = charCenterX + biasXOffset;
    const biasY = charCenterY + biasYOffset;

    const nodes = [
      { id: 'character', x: charCenterX, y: charCenterY, fx: charCenterX, fy: charCenterY, radius: characterRadius },
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

    // forceCollide treats the bubble as a circle of max(width, height) / 2,
    // which overshoots the real half-extent of a wide, short bubble along
    // the vertical axis — placed above/below the character it ends up with
    // a much larger visual gap than beside it. Pull it back toward the
    // character along the center-to-center direction until the bubble
    // *rectangle* (not the circle) sits at the intended padding.
    const dx = bubbleNode.x - charCenterX;
    const dy = bubbleNode.y - charCenterY;
    const dist = Math.hypot(dx, dy);
    if (dist > 0) {
      const ux = dx / dist;
      const uy = dy / dist;
      // Half-extent of the bubble rectangle along the placement direction
      const halfExtent = Math.abs(ux) * size.width / 2 + Math.abs(uy) * size.height / 2;
      const desired = characterRadius + BUBBLE_COLLIDE_PADDING + halfExtent;
      if (dist > desired) {
        bubbleNode.x = charCenterX + ux * desired;
        bubbleNode.y = charCenterY + uy * desired;
      }
    }

    const minX = workArea.x + screenMargin + size.width / 2;
    const maxX = workArea.x + workArea.width - screenMargin - size.width / 2;
    const minY = workArea.y + screenMargin + size.height / 2;
    const maxY = workArea.y + workArea.height - screenMargin - size.height / 2;
    const clampedX = Math.min(maxX, Math.max(minX, bubbleNode.x));
    const clampedY = Math.min(maxY, Math.max(minY, bubbleNode.y));

    const x = Math.round(clampedX - size.width / 2);
    const y = Math.round(clampedY - size.height / 2);

    // Which edge of the bubble the tail sits on: pick the axis along which
    // the character actually lies outside the bubble's extent — above/below
    // placements get a top/bottom tail, beside placements (character pinned
    // to the screen's top/bottom edge) get a left/right tail pointing
    // sideways at it. tailOffset positions the tail along that edge,
    // relative to #bubble (inset 6px from the window edge by bubble.html's
    // body padding that reserves the tail's overflow space).
    const sepX = Math.abs(clampedX - charCenterX) - size.width / 2;
    const sepY = Math.abs(clampedY - charCenterY) - size.height / 2;
    let tailSide;
    let tailOffset;
    if (sepX > sepY) {
      tailSide = clampedX < charCenterX ? 'right' : 'left';
      tailOffset = Math.max(12, Math.min(size.height - 24, Math.round(charCenterY - (y + 6))));
    } else {
      tailSide = clampedY < charCenterY ? 'bottom' : 'top';
      tailOffset = Math.max(12, Math.min(size.width - 24, Math.round(charCenterX - (x + 6))));
    }

    return { x, y, tailOffset, tailSide };
  }

  /**
   * Match the bubble window's always-on-top flag to its character window's
   * current one — the character's flag changes dynamically (Always on Top
   * mode + active/inactive state via updateAlwaysOnTopByState/
   * setAlwaysOnTopMode), and without this the bubble stays always-on-top
   * while the character sinks behind other windows, or vice versa.
   * @param {string} projectId
   */
  syncAlwaysOnTop(projectId) {
    const win = this.bubbleWindows.get(projectId);
    const charWindow = this.getCharacterWindow(projectId);
    if (!this.isWindowValid(win) || !this.isWindowValid(charWindow)) return;

    const shouldBeOnTop = charWindow.isAlwaysOnTop();
    if (win.isAlwaysOnTop() === shouldBeOnTop) return;
    win.setAlwaysOnTop(shouldBeOnTop, ALWAYS_ON_TOP_LEVEL);
  }

  /**
   * @param {string} projectId
   */
  hide(projectId) {
    this.contentRequests.delete(projectId);
    this.placementRequests.delete(projectId);
    const win = this.bubbleWindows.get(projectId);
    if (this.isWindowValid(win) && win.isVisible()) win.hide();
    this.setBubbleSize(null);
  }

  /**
   * @param {string} projectId
   */
  destroy(projectId) {
    this.contentRequests.delete(projectId);
    this.placementRequests.delete(projectId);
    const win = this.bubbleWindows.get(projectId);
    if (this.isWindowValid(win)) win.destroy();
    this.bubbleWindows.delete(projectId);
    this.lastSizes.delete(projectId);
    this.lastFields.delete(projectId);
    this.lastBgColors.delete(projectId);
    this.setBubbleSize(null);
  }

  /**
   * Destroy all bubble windows on app quit.
   */
  cleanup() {
    for (const [, win] of this.bubbleWindows) {
      if (this.isWindowValid(win)) win.destroy();
    }
    this.contentRequests.clear();
    this.placementRequests.clear();
    this.bubbleWindows.clear();
    this.lastSizes.clear();
    this.lastFields.clear();
    this.lastBgColors.clear();
  }
}

module.exports = { BubbleWindowManager, buildFieldPayload };
