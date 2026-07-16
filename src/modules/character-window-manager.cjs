/**
 * Character window management for VibeMon
 *
 * One persistent frameless window shows the character sprite. Status
 * updates from every project are recorded in a state registry, and a focus
 * rule (selectFocus) decides which single project the window follows: an
 * active-state project takes focus, otherwise the most recently updated
 * project keeps it.
 */

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const Store = require('electron-store');
const {
  WINDOW_WIDTH,
  MAX_STATE_REGISTRY_SIZE,
  SNAP_THRESHOLD,
  SNAP_DEBOUNCE_MS,
  POSITION_RESTORE_DELAY_MS,
  ALWAYS_ON_TOP_MODES,
  ACTIVE_STATES,
  SPEECH_BUBBLE_FIELDS,
  CHARACTER_NAMES,
  CHAR_Y_BASE,
  CHAR_SIZE,
  FOCUS_HYSTERESIS_MS
} = require('../shared/config.cjs');

// States that steal focus immediately even mid-hysteresis — they signal
// something needs the user's attention right away.
const PRIORITY_FOCUS_STATES = ['alert', 'notification'];

// Platform-specific always-on-top level
// macOS: 'floating' (required for tray menu visibility)
// Windows/Linux: 'screen-saver' (required for window visibility in WSL/Windows)
const ALWAYS_ON_TOP_LEVEL = process.platform === 'darwin' ? 'floating' : 'screen-saver';

// Window height: just tall enough for the character sprite
// (CHAR_Y_BASE + CHAR_SIZE) plus a little clearance for its floating
// animation. Must stay in sync with .vibemon-display in styles.css.
const WINDOW_HEIGHT = CHAR_Y_BASE + CHAR_SIZE + 12;

class CharacterWindowManager {
  constructor() {
    // The one character window: { window, state, projectId } or null.
    // projectId is mutable — the window is retargeted when focus moves to
    // another project instead of being destroyed and recreated.
    this.entry = null;
    this.snapTimer = null;

    // While true, 'move' events are OS-initiated (screen lock, system
    // sleep, display reconfiguration) rather than user drags — the snap
    // handler must not clamp or persist them.
    this.positionTrackingSuspended = false;
    this.restoreTimer = null;

    this.onWindowClosed = null;  // callback: (projectId) => void
    this.onStateUpdated = null;  // callback: (projectId) => void, fires after state/info changes
    this.onAlwaysOnTopChanged = null;  // callback: (projectId) => void, fires after the always-on-top flag changes
    this.onWindowMoved = null;  // callback: (projectId) => void
    this.onDisplayModeChanged = null;  // callback: () => void, fires after speech bubble field toggles

    // Persistent settings
    this.store = new Store({
      defaults: {
        alwaysOnTopMode: 'all',  // 'active-only', 'all', or 'disabled'
        speechBubbleFields: { status: true, project: true, model: true, memory: true, usage5h: true, usageWeek: true },
        characterLock: 'auto',  // 'auto' or a CHARACTER_NAMES entry
        windowPosition: null  // {x, y} - last dragged position, restored on next creation
      }
    });

    this.alwaysOnTopMode = this.store.get('alwaysOnTopMode');
    // Merge with defaults so fields added in a later version (not yet in an
    // existing user's persisted store) default to enabled instead of missing.
    const storedSpeechBubbleFields = this.store.get('speechBubbleFields');
    this.speechBubbleFields = Object.fromEntries(
      SPEECH_BUBBLE_FIELDS.map(field => [
        field,
        storedSpeechBubbleFields[field] !== undefined ? storedSpeechBubbleFields[field] : true
      ])
    );
    // A stored lock may name a character that no longer exists in the
    // registry (removed in an update, or a corrupted store) — falling back
    // to 'auto' keeps status updates from being overridden with an
    // unknown character.
    const storedCharacterLock = this.store.get('characterLock');
    this.characterLock = storedCharacterLock === 'auto' || CHARACTER_NAMES.includes(storedCharacterLock)
      ? storedCharacterLock
      : 'auto';
    if (this.characterLock !== storedCharacterLock) {
      this.store.set('characterLock', this.characterLock);
    }

    // Migrate the window position saved by earlier versions, which kept it
    // in a per-key map under the '__character__' key.
    this.windowPosition = this.store.get('windowPosition');
    if (!this.windowPosition) {
      const legacyPositions = this.store.get('windowPositions');
      if (legacyPositions && legacyPositions.__character__) {
        this.windowPosition = legacyPositions.__character__;
        this.store.set('windowPosition', this.windowPosition);
      }
    }

    // Latest known state per project, independent of which project the
    // window currently follows — focus can switch to any known project and
    // immediately recover its last state.
    this.stateRegistry = new Map();

    // The project the window currently follows.
    this.focusedProjectId = null;
    // When the focused project last reported an active state — see
    // selectFocus()'s busy-hold check.
    this.focusedLastActiveAt = 0;
  }

  // ============================================================================
  // Speech Bubble Fields
  // ============================================================================

  /**
   * Get speech bubble field visibility
   * @returns {Object.<string, boolean>}
   */
  getSpeechBubbleFields() {
    return this.speechBubbleFields;
  }

  /**
   * Set visibility for a single speech bubble field
   * @param {string} field - One of SPEECH_BUBBLE_FIELDS
   * @param {boolean} enabled
   */
  setSpeechBubbleField(field, enabled) {
    if (!SPEECH_BUBBLE_FIELDS.includes(field)) return;

    this.speechBubbleFields = { ...this.speechBubbleFields, [field]: !!enabled };
    this.store.set('speechBubbleFields', this.speechBubbleFields);
    if (this.onDisplayModeChanged) {
      this.onDisplayModeChanged();
    }
  }

  // ============================================================================
  // Character Lock
  // ============================================================================

  /**
   * Get current character lock
   * @returns {'auto'|string} 'auto', or a CHARACTER_NAMES entry
   */
  getCharacterLock() {
    return this.characterLock;
  }

  /**
   * Force the window to display one character regardless of what incoming
   * status updates specify ('auto' restores each project's own character on
   * its next status update — the currently shown character isn't
   * retroactively corrected, since the original isn't tracked separately).
   * @param {'auto'|string} character
   */
  setCharacterLock(character) {
    if (character !== 'auto' && !CHARACTER_NAMES.includes(character)) return;

    this.characterLock = character;
    this.store.set('characterLock', character);

    if (character === 'auto') return;

    // Immediately reflect the lock in the open window instead of waiting
    // for the next status update.
    if (this.entry && this.entry.state && this.entry.state.character !== character) {
      const projectId = this.entry.projectId;
      const newState = { ...this.entry.state, character };
      this.updateState(projectId, newState);
      this.sendToWindow(projectId, 'state-update', newState);
    }
  }

  // ============================================================================
  // Window Position
  // ============================================================================

  /**
   * Persist the window's settled position — used as the spawn position the
   * next time the window is created.
   * @param {{x: number, y: number}} position
   */
  saveWindowPosition(position) {
    this.windowPosition = position;
    this.store.set('windowPosition', position);
  }

  /**
   * Clamp a candidate spawn position (e.g. restored from a saved position)
   * to whichever display it falls on, so a screen/monitor configuration
   * change since it was saved can't spawn the window off-screen.
   * @param {{x: number, y: number}} position
   * @returns {{x: number, y: number}}
   */
  clampPositionToScreen(position) {
    const display = screen.getDisplayMatching({ x: position.x, y: position.y, width: WINDOW_WIDTH, height: WINDOW_HEIGHT });
    const { workArea } = display;
    const x = Math.min(Math.max(position.x, workArea.x), workArea.x + workArea.width - WINDOW_WIDTH);
    const y = Math.min(Math.max(position.y, workArea.y), workArea.y + workArea.height - WINDOW_HEIGHT);
    return { x, y };
  }

  /**
   * Default spawn position: top-right corner of the primary display.
   * @returns {{x: number, y: number}}
   */
  defaultPosition() {
    const { workArea } = screen.getPrimaryDisplay();
    return { x: workArea.x + workArea.width - WINDOW_WIDTH, y: workArea.y };
  }

  /**
   * Debounced snap after a drag settles: clamp the window fully back
   * on-screen (it can be dragged past the edge mid-drag), snap flush to an
   * edge when within SNAP_THRESHOLD of it, and remember where it settled.
   */
  handleWindowMove() {
    if (!this.entry || this.positionTrackingSuspended) return;
    const entry = this.entry;

    if (this.snapTimer) {
      clearTimeout(this.snapTimer);
    }

    this.snapTimer = setTimeout(() => {
      this.snapTimer = null;
      if (!this.isWindowValid(entry)) return;

      const bounds = entry.window.getBounds();
      const display = screen.getDisplayMatching(bounds);
      const { workArea } = display;

      // Hard clamp first: never leave the window partially or fully off-screen,
      // regardless of how far past the edge it was dragged.
      let newX = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - bounds.width);
      let newY = Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - bounds.height);

      // Snap flush to the nearest edge when already close to it.
      if (Math.abs(newX - workArea.x) < SNAP_THRESHOLD) {
        newX = workArea.x;
      } else if (Math.abs((newX + bounds.width) - (workArea.x + workArea.width)) < SNAP_THRESHOLD) {
        newX = workArea.x + workArea.width - bounds.width;
      }

      if (Math.abs(newY - workArea.y) < SNAP_THRESHOLD) {
        newY = workArea.y;
      } else if (Math.abs((newY + bounds.height) - (workArea.y + workArea.height)) < SNAP_THRESHOLD) {
        newY = workArea.y + workArea.height - bounds.height;
      }

      if (newX !== bounds.x || newY !== bounds.y) {
        entry.window.setPosition(newX, newY);
      }

      this.saveWindowPosition({ x: newX, y: newY });
    }, SNAP_DEBOUNCE_MS);
  }

  /**
   * Stop treating 'move' events as user drags. Called on screen lock,
   * system suspend, and display attach/detach, where macOS moves windows
   * itself (e.g. onto the primary display when another display sleeps) —
   * persisting such a move would overwrite the user's chosen position.
   */
  suspendPositionTracking() {
    this.positionTrackingSuspended = true;
    if (this.snapTimer) {
      clearTimeout(this.snapTimer);
      this.snapTimer = null;
    }
    if (this.restoreTimer) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
  }

  /**
   * Put the window back at its saved position and resume drag tracking.
   * Called (debounced) on resume/unlock and after display changes; the
   * delay lets macOS finish re-enumerating displays first. The window is
   * only moved once the saved position's display is available again —
   * until then it stays where the OS put it, and a later display-added
   * event retries.
   */
  restoreWindowPosition() {
    if (this.restoreTimer) {
      clearTimeout(this.restoreTimer);
    }
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = null;
      this.positionTrackingSuspended = false;

      if (!this.isWindowValid(this.entry) || !this.windowPosition) return;

      const target = this.clampPositionToScreen(this.windowPosition);
      const displayAvailable = target.x === this.windowPosition.x && target.y === this.windowPosition.y;
      if (!displayAvailable) return;

      const [x, y] = this.entry.window.getPosition();
      if (x !== target.x || y !== target.y) {
        this.entry.window.setPosition(target.x, target.y);
      }
    }, POSITION_RESTORE_DELAY_MS);
  }

  // ============================================================================
  // Window Lifecycle
  // ============================================================================

  /**
   * Ensure the character window exists and follows projectId. An existing
   * window is retargeted to the new project (its state reset); a missing
   * one is created at the last saved position.
   * @param {string} projectId
   * @returns {{window: BrowserWindow, switchedProject: string|null}}
   */
  ensureWindow(projectId) {
    if (this.entry) {
      if (this.entry.projectId === projectId) {
        return { window: this.entry.window, switchedProject: null };
      }
      const switchedProject = this.entry.projectId;
      this.entry.projectId = projectId;
      // Reset state for the new project (clear previous project's data)
      this.entry.state = { project: projectId };
      return { window: this.entry.window, switchedProject };
    }

    const position = this.windowPosition
      ? this.clampPositionToScreen(this.windowPosition)
      : this.defaultPosition();

    const windowOptions = {
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      x: position.x,
      y: position.y,
      frame: false,
      transparent: true,
      alwaysOnTop: this.alwaysOnTopMode !== 'disabled',
      resizable: false,
      skipTaskbar: false,
      hasShadow: false,
      show: false,
      icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    };

    // On macOS, use panel type to prevent focus stealing
    if (process.platform === 'darwin') {
      windowOptions.type = 'panel';
    }

    const window = new BrowserWindow(windowOptions);

    if (typeof window.webContents.setWindowOpenHandler === 'function') {
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    }
    if (typeof window.webContents.on === 'function') {
      window.webContents.on('will-navigate', (event) => event.preventDefault());
    }

    window.loadFile(path.join(__dirname, '..', 'index.html'));

    // Allow window to be dragged across workspaces
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    const entry = { window, state: null, projectId };
    this.entry = entry;

    // Show window without stealing focus once ready
    window.once('ready-to-show', () => {
      const currentState = entry.state ? entry.state.state : null;
      window.setAlwaysOnTop(this.shouldBeAlwaysOnTop(currentState), ALWAYS_ON_TOP_LEVEL);

      window.showInactive();

      // Send initial state if available
      if (entry.state) {
        window.webContents.send('state-update', entry.state);
      }
    });

    window.on('closed', () => {
      // The entry may already have been replaced (e.g. destroyed and
      // recreated); only clean up if this window still owns it.
      if (this.entry !== entry) return;

      if (this.snapTimer) {
        clearTimeout(this.snapTimer);
        this.snapTimer = null;
      }
      this.entry = null;

      if (this.onWindowClosed) {
        this.onWindowClosed(entry.projectId);
      }
    });

    window.on('move', () => {
      // Notify immediately (not debounced) so the speech bubble window can
      // follow along live while this window is being dragged.
      if (this.onWindowMoved) {
        this.onWindowMoved(entry.projectId);
      }
      this.handleWindowMove();
    });

    return { window, switchedProject: null };
  }

  /**
   * Check if a window entry is valid (exists and not destroyed)
   * @param {Object} entry
   * @returns {boolean}
   */
  isWindowValid(entry) {
    return !!(entry && entry.window && !entry.window.isDestroyed());
  }

  /**
   * Get the character window if it currently follows projectId
   * @param {string} projectId
   * @returns {BrowserWindow|null}
   */
  getWindow(projectId) {
    if (this.entry && this.entry.projectId === projectId) {
      return this.entry.window;
    }
    return null;
  }

  /**
   * Get the character window regardless of which project it follows
   * @returns {BrowserWindow|null}
   */
  getActiveWindow() {
    return this.entry ? this.entry.window : null;
  }

  /**
   * Get the window's current state if it follows projectId
   * @param {string} projectId
   * @returns {Object|null}
   */
  getState(projectId) {
    if (this.entry && this.entry.projectId === projectId) {
      return this.entry.state;
    }
    return null;
  }

  /**
   * Update the window's state with change detection. No-op when the window
   * doesn't exist or follows a different project.
   * @param {string} projectId
   * @param {Object} newState
   * @returns {{updated: boolean, stateChanged: boolean, infoChanged: boolean}}
   */
  updateState(projectId, newState) {
    if (!this.entry || this.entry.projectId !== projectId) {
      return { updated: false, stateChanged: false, infoChanged: false };
    }

    const oldState = this.entry.state || {};

    const stateChanged = oldState.state !== newState.state;

    // Check if info fields changed (tool, model, memory, usage, character,
    // terminalId — a stale terminalId would break click-to-focus)
    const infoChanged = !stateChanged && (
      oldState.tool !== newState.tool ||
      oldState.model !== newState.model ||
      oldState.memory !== newState.memory ||
      oldState.usage5h !== newState.usage5h ||
      oldState.usageWeek !== newState.usageWeek ||
      oldState.usage5hResetsIn !== newState.usage5hResetsIn ||
      oldState.usageWeekResetsIn !== newState.usageWeekResetsIn ||
      oldState.character !== newState.character ||
      oldState.terminalId !== newState.terminalId
    );

    // No change - skip update
    if (!stateChanged && !infoChanged) {
      return { updated: false, stateChanged: false, infoChanged: false };
    }

    this.entry.state = { ...newState };
    if (this.onStateUpdated) {
      this.onStateUpdated(projectId);
    }
    return { updated: true, stateChanged, infoChanged };
  }

  /**
   * Send data to the window via IPC if it follows projectId
   * @param {string} projectId
   * @param {string} channel
   * @param {*} data
   * @returns {boolean}
   */
  sendToWindow(projectId, channel, data) {
    if (this.entry && this.entry.projectId === projectId &&
        this.isWindowValid(this.entry) && !this.entry.window.webContents.isDestroyed()) {
      this.entry.window.webContents.send(channel, data);
      return true;
    }
    return false;
  }

  /**
   * Close the window if it follows projectId
   * @param {string} projectId
   * @returns {boolean}
   */
  closeWindow(projectId) {
    if (this.entry && this.entry.projectId === projectId && this.isWindowValid(this.entry)) {
      this.entry.window.close();
      return true;
    }
    return false;
  }

  /**
   * Show the window if it follows projectId
   * @param {string} projectId
   * @returns {boolean}
   */
  showWindow(projectId) {
    if (this.entry && this.entry.projectId === projectId && this.isWindowValid(this.entry)) {
      this.entry.window.showInactive();
      return true;
    }
    return false;
  }

  /**
   * Show and focus the window regardless of which project it follows
   * @returns {boolean} Whether the window was shown
   */
  showActiveWindow() {
    if (this.isWindowValid(this.entry)) {
      this.entry.window.show();
      this.entry.window.focus();
      return true;
    }
    return false;
  }

  /**
   * @returns {string[]} the followed project's id, or [] with no window
   */
  getProjectIds() {
    return this.entry ? [this.entry.projectId] : [];
  }

  /**
   * @returns {number} 0 or 1
   */
  getWindowCount() {
    return this.entry ? 1 : 0;
  }

  /**
   * Cleanup resources on app quit
   */
  cleanup() {
    if (this.snapTimer) {
      clearTimeout(this.snapTimer);
      this.snapTimer = null;
    }
    if (this.restoreTimer) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
  }

  // ============================================================================
  // State Registry & Focus
  // ============================================================================

  /**
   * Cap stateRegistry's size, since every incoming status keeps it growing.
   * Evicts the least-recently-updated entries first, skipping the project
   * the window currently follows.
   */
  pruneStateRegistry() {
    while (this.stateRegistry.size > MAX_STATE_REGISTRY_SIZE) {
      let evicted = false;
      for (const projectId of this.stateRegistry.keys()) {
        if (!this.entry || this.entry.projectId !== projectId) {
          this.stateRegistry.delete(projectId);
          evicted = true;
          break;
        }
      }
      if (!evicted) break;
    }
  }

  /**
   * Get the latest known state for a project, even if the window doesn't
   * currently follow it.
   * @param {string} projectId
   * @returns {Object|null}
   */
  getRegisteredState(projectId) {
    return this.stateRegistry.get(projectId) || null;
  }

  /**
   * Get all projects with a known state.
   * @returns {Object.<string, Object>}
   */
  getRegisteredStates() {
    const result = {};
    for (const [projectId, state] of this.stateRegistry) {
      result[projectId] = state;
    }
    return result;
  }

  /**
   * Remove every in-memory reference to a tracked project.
   * @param {string} projectId
   * @returns {boolean} whether the project was registered
   */
  removeProject(projectId) {
    const removed = this.stateRegistry.delete(projectId);
    if (this.focusedProjectId === projectId) {
      this.focusedProjectId = null;
      this.focusedLastActiveAt = 0;
    }
    return removed;
  }

  /**
   * @returns {string|null} the project the window currently follows
   */
  getFocusedProjectId() {
    return this.focusedProjectId;
  }

  /**
   * Decide which project the window should show, given an incoming status
   * update. The focused project holds focus while it is busy: currently in
   * an active state, or within FOCUS_HYSTERESIS_MS of its last active
   * update — AI tools pass through momentary inactive states (done after
   * every tool, idle between prompts), and treating those gaps as "no
   * longer busy" made concurrent sessions steal the window from each other
   * many times a minute. Priority states (alert/notification) bypass the
   * hold since they need the user's attention immediately. Once the
   * focused project has settled past the window, the most recently
   * updated project takes focus.
   * @param {string} projectId
   * @param {string} state
   * @returns {string} the projectId that should now be focused
   */
  selectFocus(projectId, state) {
    const now = Date.now();
    const isActive = ACTIVE_STATES.includes(state);

    if (projectId === this.focusedProjectId) {
      if (isActive) this.focusedLastActiveAt = now;
      return this.focusedProjectId;
    }

    if (this.focusedProjectId) {
      const focusedState = this.stateRegistry.get(this.focusedProjectId);
      const focusedIsActive = focusedState && ACTIVE_STATES.includes(focusedState.state);
      const focusedIsBusy = focusedIsActive || now - this.focusedLastActiveAt < FOCUS_HYSTERESIS_MS;

      if (focusedIsBusy && !(isActive && PRIORITY_FOCUS_STATES.includes(state))) {
        return this.focusedProjectId;
      }

      // Focus only leaves a settled project for another one that has
      // something to show: an active update, or any update while the
      // settled project has gone quiet (most-recently-updated rule).
    }

    this.focusedProjectId = projectId;
    this.focusedLastActiveAt = isActive ? now : 0;

    return this.focusedProjectId;
  }

  /**
   * Record an incoming status update, decide focus, and apply it to the
   * window when the update's project is (or becomes) the focused one.
   * Always records the incoming state in stateRegistry first, so state
   * survives even while another project holds focus.
   * Shared by the HTTP POST /status and WebSocket status-update paths.
   * @param {string} projectId
   * @param {Object} stateData - validated/normalized state data
   * @param {{preserveFocus?: boolean}} [options] - preserveFocus records the
   *   state without moving focus; used by state timeouts, which are clock
   *   events rather than project activity and must not steal the window.
   * @returns {{
   *   switchedProject: string|null,
   *   updateResult: {updated: boolean, stateChanged: boolean, infoChanged: boolean},
   *   stateData: Object
   * }}
   */
  routeStatusUpdate(projectId, stateData, { preserveFocus = false } = {}) {
    // Character Lock overrides whatever character the incoming status
    // specifies — reassign the local reference to a new object (not the
    // caller's) so every downstream use (stateRegistry, window state, the
    // 'state-update' IPC payload the caller sends afterward) stays in sync.
    if (this.characterLock !== 'auto') {
      stateData = { ...stateData, character: this.characterLock };
    }

    // terminalId only arrives via local HTTP — the cloud API neither stores
    // nor rebroadcasts it — so a WebSocket echo of a locally-posted status
    // would otherwise wipe the terminal reference and break click-to-focus.
    // Keep the project's last known terminalId when an update omits it.
    if (stateData.terminalId === undefined) {
      const previous = this.stateRegistry.get(projectId);
      if (previous && previous.terminalId !== undefined) {
        stateData = { ...stateData, terminalId: previous.terminalId };
      }
    }

    // Delete-then-set moves projectId to the end of the Map's insertion
    // order, so pruneStateRegistry() evicts the least-recently-updated
    // project first rather than whichever happened to be added earliest.
    this.stateRegistry.delete(projectId);
    this.stateRegistry.set(projectId, stateData);
    this.pruneStateRegistry();

    const focusedProjectId = preserveFocus
      ? this.focusedProjectId
      : this.selectFocus(projectId, stateData.state);

    if (focusedProjectId !== projectId) {
      // Focus stayed on a different (still-active) project — state was
      // recorded above, but the visible window doesn't change.
      return {
        switchedProject: null,
        updateResult: { updated: false, stateChanged: false, infoChanged: false },
        stateData
      };
    }

    const { switchedProject } = this.ensureWindow(focusedProjectId);
    const updateResult = this.updateState(focusedProjectId, stateData);
    return { switchedProject, updateResult, stateData };
  }

  // ============================================================================
  // Always on Top
  // ============================================================================

  /**
   * Determine if the window should be always on top based on mode and state
   * @param {string|null} state - Current window state
   * @returns {boolean}
   */
  shouldBeAlwaysOnTop(state) {
    switch (this.alwaysOnTopMode) {
      case 'all':
        return true;
      case 'active-only':
        return Boolean(state && ACTIVE_STATES.includes(state));
      case 'disabled':
      default:
        return false;
    }
  }

  /**
   * Get always on top mode
   * @returns {'active-only'|'all'|'disabled'}
   */
  getAlwaysOnTopMode() {
    return this.alwaysOnTopMode;
  }

  /**
   * Get all available always on top modes
   * @returns {Object}
   */
  getAlwaysOnTopModes() {
    return ALWAYS_ON_TOP_MODES;
  }

  /**
   * Set always on top mode and update the window
   * @param {'active-only'|'all'|'disabled'} mode
   */
  setAlwaysOnTopMode(mode) {
    if (!ALWAYS_ON_TOP_MODES[mode]) return;

    this.alwaysOnTopMode = mode;
    this.store.set('alwaysOnTopMode', mode);

    if (this.isWindowValid(this.entry)) {
      const state = this.entry.state ? this.entry.state.state : null;
      this.entry.window.setAlwaysOnTop(this.shouldBeAlwaysOnTop(state), ALWAYS_ON_TOP_LEVEL);
      if (this.onAlwaysOnTopChanged) {
        this.onAlwaysOnTopChanged(this.entry.projectId);
      }
    }
  }

  /**
   * Update always on top based on state. Active states enable on top
   * immediately; inactive states disable it immediately (no grace period,
   * prevents focus stealing). Respects alwaysOnTopMode.
   * @param {string} state
   */
  updateAlwaysOnTopByState(state) {
    if (!this.isWindowValid(this.entry)) return;

    this.entry.window.setAlwaysOnTop(this.shouldBeAlwaysOnTop(state), ALWAYS_ON_TOP_LEVEL);

    if (this.onAlwaysOnTopChanged) {
      this.onAlwaysOnTopChanged(this.entry.projectId);
    }
  }

  // ============================================================================
  // Terminal / Debug
  // ============================================================================

  /**
   * Get terminal ID for the followed project
   * @param {string} projectId
   * @returns {string|null}
   */
  getTerminalId(projectId) {
    const state = this.getState(projectId);
    return state ? state.terminalId || null : null;
  }

  /**
   * Get project ID by webContents
   * @param {Electron.WebContents} webContents
   * @returns {string|null}
   */
  getProjectIdByWebContents(webContents) {
    if (this.isWindowValid(this.entry) && this.entry.window.webContents === webContents) {
      return this.entry.projectId;
    }
    return null;
  }

  /**
   * Get debug info
   * @returns {Object}
   */
  getDebugInfo() {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();

    const window = this.isWindowValid(this.entry)
      ? {
        projectId: this.entry.projectId,
        bounds: this.entry.window.getBounds(),
        state: this.entry.state ? this.entry.state.state : null
      }
      : null;

    return {
      primaryDisplay: {
        bounds: primary.bounds,
        workArea: primary.workArea,
        workAreaSize: primary.workAreaSize,
        scaleFactor: primary.scaleFactor
      },
      allDisplays: displays.map(d => ({
        id: d.id,
        bounds: d.bounds,
        workArea: d.workArea,
        scaleFactor: d.scaleFactor
      })),
      window,
      focusedProjectId: this.focusedProjectId,
      trackedProjects: Array.from(this.stateRegistry.keys()),
      alwaysOnTopMode: this.alwaysOnTopMode,
      platform: process.platform
    };
  }
}

module.exports = { CharacterWindowManager };
