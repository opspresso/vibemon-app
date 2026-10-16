/**
 * Speech bubble window management
 * One small transparent BrowserWindow per project, positioned
 * beside the character by a bounded, pure rectangle layout.
 */

'use strict';

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { trackWindowPointer } = require('./window-pointer.cjs');
const { placeBubble } = require('./bubble-layout.cjs');
const { remainingResetMinutes } = require('../shared/monitoring/clock.cjs');
const { ALWAYS_ON_TOP_LEVEL } = require('./window-position.cjs');
const { STATE_COLORS, STATE_TEXTS, TOOL_TEXTS, LOADING_STATES, BUBBLE_LOAD_TIMEOUT_MS } = require('../shared/config.cjs');

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
function buildFieldPayload(state, speechBubbleFields, { observedAt = state?.observedAt, now = Date.now() } = {}) {
  const payload = {};

  if (speechBubbleFields && speechBubbleFields.status && state && state.state) {
    const stateKey = String(state.state);
    // State/tool -> text mapping from constants.json (STATE_TEXTS/TOOL_TEXTS).
    const toolKey = String(state.tool || '').toLowerCase();
    const text = stateKey === 'working'
      ? (Object.hasOwn(TOOL_TEXTS, toolKey) ? TOOL_TEXTS[toolKey] : TOOL_TEXTS.default)
      : (Object.hasOwn(STATE_TEXTS, stateKey) ? STATE_TEXTS[stateKey] : stateKey.charAt(0).toUpperCase() + stateKey.slice(1));
    payload.status = { type: 'text', text };
    if (LOADING_STATES.includes(stateKey)) {
      // Loading dots beside the text; thinking-style states animate slower
      // than working (vibemon-bubble.css's slow and fast animations).
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
        metric.resetIn = remainingResetMinutes(resetValue, observedAt, now);
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

// The renderer call that draws a bubble. Without a placement it measures the
// content with a bottom tail and leaves the current scale unchanged.
function bubbleContent(fields, bgColor, placement = null) {
  const args = placement
    ? [fields, placement.tailOffset, placement.tailSide, bgColor, placement.scale || 1]
    : [fields, 0, 'bottom', bgColor];
  return `window.__setBubbleContent(${args.map(value => JSON.stringify(value)).join(', ')})`;
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
    this.placementRequests = new Map();
    this.contentRequests = new Map();
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
    }, BUBBLE_LOAD_TIMEOUT_MS);

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
   * @param {{state: Object|null, speechBubbleFields: Object, observedAt?: string, now?: number}} options
   */
  async update(projectId, { state, speechBubbleFields, observedAt, now }) {
    const request = {};
    this.contentRequests.set(projectId, request);
    this.placementRequests.delete(projectId);
    const isCurrent = () => this.contentRequests.get(projectId) === request;
    const fields = buildFieldPayload(state, speechBubbleFields, { observedAt, now });

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
      win, bubbleContent(fields, bgColor)
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

    await this.execInBubble(win, bubbleContent(fields, bgColor, placement));
    if (!isCurrent() || !this.isWindowValid(win) || !this.isWindowValid(this.getCharacterWindow(projectId))) return;
    this.applyPlacement(win, placement, size);
    this.syncAlwaysOnTop(projectId);
    if (!win.isVisible()) win.showInactive();
    this.reposition(projectId);
  }

  // Poll ticks refresh presentation only. They must neither reopen a closed
  // companion nor go through status ingestion and extend its lifecycle timers.
  async refresh(projectId, options) {
    const win = this.bubbleWindows.get(projectId);
    if (!this.isWindowValid(win) || !win.isVisible()) return;
    const fields = buildFieldPayload(options.state, options.speechBubbleFields, options);
    if (JSON.stringify(fields) === JSON.stringify(this.lastFields.get(projectId)) &&
        resolveBgColor(options.state) === this.lastBgColors.get(projectId)) return;
    await this.update(projectId, options);
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

      await this.execInBubble(win, bubbleContent(fields, bgColor, placement));
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

  async computePlacement(charWindow, size) {
    const dock = this.getDockLayout();
    if (dock?.bubble) return { ...dock.bubble, scale: dock.scale };
    if (!this.isWindowValid(charWindow)) return null;
    const bounds = charWindow.getBounds();
    const { workArea } = screen.getDisplayNearestPoint({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    return placeBubble(bounds, size, workArea, this.getCharacterScale(), this.getEdgeMargin());
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
