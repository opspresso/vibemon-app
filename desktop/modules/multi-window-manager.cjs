/**
 * Multi-window management for Vibe Monitor
 * Manages multiple windows, one per project
 * Supports both multi-window and single-window modes
 */

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const Store = require('electron-store');
const {
  WINDOW_WIDTH,
  WINDOW_HEIGHT,
  WINDOW_GAP,
  MAX_WINDOWS,
  MAX_PROJECT_LIST,
  SNAP_THRESHOLD,
  SNAP_DEBOUNCE,
  LOCK_MODES,
  ALWAYS_ON_TOP_MODES,
  ACTIVE_STATES,
  SPEECH_BUBBLE_FIELDS,
  CHAR_Y_BASE,
  CHAR_SIZE
} = require('../shared/config.cjs');

// Platform-specific always-on-top level
// macOS: 'floating' (required for tray menu visibility)
// Windows/Linux: 'screen-saver' (required for window visibility in WSL/Windows)
const ALWAYS_ON_TOP_LEVEL = process.platform === 'darwin' ? 'floating' : 'screen-saver';

// Character Only Mode window height: just tall enough for the character
// sprite (CHAR_Y_BASE + CHAR_SIZE) plus a little clearance for its floating
// animation, instead of the full WINDOW_HEIGHT which leaves a tall empty
// transparent area below the character (the engine's own info panel, hidden
// in this mode, normally fills that space).
const CHARACTER_ONLY_WINDOW_HEIGHT = CHAR_Y_BASE + CHAR_SIZE + 12;

class MultiWindowManager {
  constructor() {
    this.windows = new Map();  // Map<projectId, { window, state }>
    this.snapTimers = new Map();  // Map<projectId, timerId>
    this.onWindowClosed = null;  // callback: (projectId) => void
    this.onStateUpdated = null;  // callback: (projectId) => void, fires after state/info changes
    this.onAlwaysOnTopChanged = null;  // callback: (projectId) => void, fires after a window's always-on-top flag changes
    this.onWindowMoved = null;  // callback: (projectId) => void
    this.onDisplayModeChanged = null;  // callback: () => void

    // Persistent settings
    this.store = new Store({
      defaults: {
        windowMode: 'multi',  // 'multi' or 'single'
        lockedProject: null,
        lockMode: 'on-thinking',  // 'first-project' or 'on-thinking'
        alwaysOnTopMode: 'active-only',  // 'active-only', 'all', or 'disabled'
        projectList: [],  // Persisted project list for lock menu
        characterOnlyMode: false,  // Hide title bar/device frame, show speech bubble instead
        speechBubbleFields: { project: true, memory: true, usage5h: true, usageWeek: true }
      }
    });

    // Window mode: 'multi' (multiple windows) or 'single' (one window with lock)
    this.windowMode = this.store.get('windowMode');
    this.lockedProject = this.store.get('lockedProject');
    this.lockMode = this.store.get('lockMode');
    this.alwaysOnTopMode = this.store.get('alwaysOnTopMode');
    this.characterOnlyMode = this.store.get('characterOnlyMode');
    this.speechBubbleFields = this.store.get('speechBubbleFields');

    // Project list (tracks all projects seen) - persisted
    this.projectList = this.store.get('projectList') || [];
  }

  // ============================================================================
  // Window Mode Management
  // ============================================================================

  /**
   * Get current window mode
   * @returns {'multi'|'single'}
   */
  getWindowMode() {
    return this.windowMode;
  }

  /**
   * Set window mode
   * @param {'multi'|'single'} mode
   */
  setWindowMode(mode) {
    if (mode !== 'multi' && mode !== 'single') return;

    this.windowMode = mode;
    this.store.set('windowMode', mode);

    // When switching to single mode, close extra windows
    if (mode === 'single' && this.windows.size > 1) {
      const projectIds = Array.from(this.windows.keys());
      // Keep only the first (or locked) window
      const keepProject = this.lockedProject || projectIds[0];
      for (const projectId of projectIds) {
        if (projectId !== keepProject) {
          this.closeWindow(projectId);
        }
      }
    }

    // Clear lock when switching to multi mode
    if (mode === 'multi') {
      this.lockedProject = null;
      this.store.set('lockedProject', null);
    }
  }

  /**
   * Check if in multi-window mode
   * @returns {boolean}
   */
  isMultiMode() {
    return this.windowMode === 'multi';
  }

  // ============================================================================
  // Lock Management (Single Window Mode)
  // ============================================================================

  /**
   * Add project to the project list (persisted)
   * Uses LRU (Least Recently Used) strategy to limit list size
   * @param {string} project
   */
  addProjectToList(project) {
    if (!project) return;

    // Remove if already exists (will be re-added at end for LRU)
    const existingIndex = this.projectList.indexOf(project);
    if (existingIndex !== -1) {
      this.projectList.splice(existingIndex, 1);
    }

    // Add to end (most recently used)
    this.projectList.push(project);

    // Enforce max limit (remove oldest entries)
    while (this.projectList.length > MAX_PROJECT_LIST) {
      this.projectList.shift();
    }

    this.store.set('projectList', this.projectList);
  }

  /**
   * Get list of all known projects
   * @returns {string[]}
   */
  getProjectList() {
    return this.projectList;
  }

  /**
   * Lock to a specific project (single mode only)
   * @param {string} projectId
   * @returns {boolean}
   */
  lockProject(projectId) {
    if (this.windowMode !== 'single') return false;
    if (!projectId) return false;

    this.addProjectToList(projectId);
    this.lockedProject = projectId;
    this.store.set('lockedProject', projectId);
    return true;
  }

  /**
   * Unlock project (single mode only)
   */
  unlockProject() {
    this.lockedProject = null;
    this.store.set('lockedProject', null);
  }

  /**
   * Get locked project
   * @returns {string|null}
   */
  getLockedProject() {
    return this.lockedProject;
  }

  /**
   * Get current lock mode
   * @returns {'first-project'|'on-thinking'}
   */
  getLockMode() {
    return this.lockMode;
  }

  /**
   * Get all available lock modes
   * @returns {Object}
   */
  getLockModes() {
    return LOCK_MODES;
  }

  /**
   * Set lock mode (single mode only)
   * @param {'first-project'|'on-thinking'} mode
   * @returns {boolean}
   */
  setLockMode(mode) {
    if (!LOCK_MODES[mode]) return false;

    this.lockMode = mode;
    this.lockedProject = null;  // Reset lock when mode changes
    this.store.set('lockMode', mode);
    this.store.set('lockedProject', null);
    return true;
  }

  /**
   * Apply auto-lock based on lock mode
   * Called when a status update is received
   * @param {string} projectId
   * @param {string} state - Current state (thinking, working, etc.)
   */
  applyAutoLock(projectId, state) {
    if (this.windowMode !== 'single') return;
    if (!projectId) return;

    this.addProjectToList(projectId);

    if (this.lockMode === 'first-project') {
      // Lock to first project if not already locked
      if (this.projectList.length === 1 && this.lockedProject === null) {
        this.lockedProject = projectId;
        this.store.set('lockedProject', projectId);
      }
    } else if (this.lockMode === 'on-thinking') {
      // Lock when entering thinking state
      if (state === 'thinking') {
        this.lockedProject = projectId;
        this.store.set('lockedProject', projectId);
      }
    }
  }

  // ============================================================================
  // Display Mode Management (Character Only Mode)
  // ============================================================================

  /**
   * Get character-only mode (hides title bar/device frame, shows speech bubble instead)
   * @returns {boolean}
   */
  getCharacterOnlyMode() {
    return this.characterOnlyMode;
  }

  /**
   * Set character-only mode and broadcast to all open windows
   * @param {boolean} enabled
   */
  setCharacterOnlyMode(enabled) {
    this.characterOnlyMode = !!enabled;
    this.store.set('characterOnlyMode', this.characterOnlyMode);

    // Shrink/restore every open window's height to match — Character Only
    // Mode hides everything below the character sprite, so the window
    // shouldn't keep the tall empty area the normal mode's info panel fills.
    const height = this.characterOnlyMode ? CHARACTER_ONLY_WINDOW_HEIGHT : WINDOW_HEIGHT;
    for (const [, entry] of this.windows) {
      if (this.isWindowValid(entry)) {
        entry.window.setSize(WINDOW_WIDTH, height);
      }
    }

    this.broadcastDisplayMode();
  }

  /**
   * Get speech bubble field visibility
   * @returns {{project: boolean, memory: boolean, usage5h: boolean, usageWeek: boolean}}
   */
  getSpeechBubbleFields() {
    return this.speechBubbleFields;
  }

  /**
   * Set visibility for a single speech bubble field and broadcast to all open windows
   * @param {string} field - One of SPEECH_BUBBLE_FIELDS
   * @param {boolean} enabled
   */
  setSpeechBubbleField(field, enabled) {
    if (!SPEECH_BUBBLE_FIELDS.includes(field)) return;

    this.speechBubbleFields = { ...this.speechBubbleFields, [field]: !!enabled };
    this.store.set('speechBubbleFields', this.speechBubbleFields);
    this.broadcastDisplayMode();
  }

  /**
   * Send current display-mode settings to every open window
   */
  broadcastDisplayMode() {
    const payload = {
      characterOnlyMode: this.characterOnlyMode,
      speechBubbleFields: this.speechBubbleFields
    };
    for (const [, entry] of this.windows) {
      if (this.isWindowValid(entry) && !entry.window.webContents.isDestroyed()) {
        entry.window.webContents.send('display-mode-update', payload);
      }
    }
    if (this.onDisplayModeChanged) {
      this.onDisplayModeChanged();
    }
  }

  // ============================================================================
  // Window Position Calculation
  // ============================================================================

  /**
   * Calculate window position by index
   * Index 0 = rightmost (top-right corner)
   * Each subsequent index moves left by (WINDOW_WIDTH + WINDOW_GAP)
   * @param {number} index - Window index (0 = rightmost)
   * @returns {{x: number, y: number}}
   */
  calculatePosition(index) {
    const { workArea } = screen.getPrimaryDisplay();
    const x = workArea.x + workArea.width - WINDOW_WIDTH - (index * (WINDOW_WIDTH + WINDOW_GAP));
    const y = workArea.y;
    return { x, y };
  }

  /**
   * Check if more windows can be created
   * Considers MAX_WINDOWS limit and screen width
   * @returns {boolean}
   */
  canCreateWindow() {
    // Check MAX_WINDOWS limit
    if (this.windows.size >= MAX_WINDOWS) {
      return false;
    }

    // Check if there's enough screen space
    const { workArea } = screen.getPrimaryDisplay();
    const requiredWidth = (this.windows.size + 1) * (WINDOW_WIDTH + WINDOW_GAP) - WINDOW_GAP;
    if (requiredWidth > workArea.width) {
      return false;
    }

    return true;
  }

  /**
   * Create a window for a project
   * In single mode: reuses existing window or respects lock
   * In multi mode: creates new window per project
   * @param {string} projectId - Project identifier
   * @returns {{window: BrowserWindow|null, blocked: boolean, switchedProject: string|null}}
   */
  createWindow(projectId) {
    // Return existing window if it exists for this project
    const existing = this.windows.get(projectId);
    if (existing) {
      return { window: existing.window, blocked: false, switchedProject: null };
    }

    // Single window mode handling
    if (this.windowMode === 'single') {
      // If locked to different project, block
      if (this.lockedProject && this.lockedProject !== projectId) {
        return { window: null, blocked: true, switchedProject: null };
      }

      // If window exists for different project, switch it
      if (this.windows.size > 0) {
        const [oldProjectId, entry] = this.windows.entries().next().value;

        // Clear timers for the old project
        const snapTimer = this.snapTimers.get(oldProjectId);
        if (snapTimer) {
          clearTimeout(snapTimer);
          this.snapTimers.delete(oldProjectId);
        }

        // Remove old entry and re-register with new projectId
        // Note: These operations are atomic within Node.js event loop tick
        this.windows.delete(oldProjectId);
        this.windows.set(projectId, entry);
        // Update mutable projectId for event handlers using closure
        entry.currentProjectId = projectId;
        // Reset state for new project (clear previous project's data)
        entry.state = { project: projectId };
        return { window: entry.window, blocked: false, switchedProject: oldProjectId };
      }
    }

    // Check if we can create more windows (multi mode)
    if (!this.canCreateWindow()) {
      return { window: null, blocked: false, switchedProject: null };
    }

    // Calculate position for new window (will be the newest, so rightmost)
    const index = 0;
    const position = this.calculatePosition(index);

    // Shift existing windows to the left
    // Windows will be arranged after ready-to-show

    // macOS: Use 'panel' type to prevent focus stealing
    const windowOptions = {
      width: WINDOW_WIDTH,
      height: this.characterOnlyMode ? CHARACTER_ONLY_WINDOW_HEIGHT : WINDOW_HEIGHT,
      x: position.x,
      y: position.y,
      frame: false,
      transparent: true,
      alwaysOnTop: this.alwaysOnTopMode !== 'disabled',
      resizable: false,
      skipTaskbar: false,
      hasShadow: true,
      show: false,
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    };

    // On macOS, use panel type to prevent focus stealing
    if (process.platform === 'darwin') {
      windowOptions.type = 'panel';
    }

    const window = new BrowserWindow(windowOptions);

    window.loadFile(path.join(__dirname, '..', 'index.html'));

    // Allow window to be dragged across workspaces
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Store window entry with initial state
    // currentProjectId is mutable to handle single-mode window reuse
    const windowEntry = {
      window,
      state: null,  // Initial state, will be set via updateState
      currentProjectId: projectId  // Mutable: updated when window is reused in single mode
    };
    this.windows.set(projectId, windowEntry);

    // Show window without stealing focus once ready
    window.once('ready-to-show', () => {
      // Set always on top based on mode and current state
      const currentState = windowEntry.state ? windowEntry.state.state : null;
      const shouldBeOnTop = this.shouldBeAlwaysOnTop(currentState);
      window.setAlwaysOnTop(shouldBeOnTop, ALWAYS_ON_TOP_LEVEL);

      window.showInactive();

      // Send initial state if available
      if (windowEntry.state) {
        window.webContents.send('state-update', windowEntry.state);
      }

      // Send current display-mode settings (character-only mode, speech bubble fields)
      window.webContents.send('display-mode-update', {
        characterOnlyMode: this.characterOnlyMode,
        speechBubbleFields: this.speechBubbleFields
      });

      // Arrange all windows by state and name
      this.arrangeWindowsByName();
    });

    // Handle window closed
    // Use windowEntry.currentProjectId to get the current project (handles single-mode reuse)
    window.on('closed', () => {
      const currentProjectId = windowEntry.currentProjectId;

      // Verify this entry still owns the projectId in the Map
      // In single-mode, window may have been reused for a different project
      const entry = this.windows.get(currentProjectId);
      if (entry !== windowEntry) {
        // Window was reused - skip cleanup for this projectId
        return;
      }

      // Clear snap timer if exists
      const snapTimer = this.snapTimers.get(currentProjectId);
      if (snapTimer) {
        clearTimeout(snapTimer);
        this.snapTimers.delete(currentProjectId);
      }

      // Remove from windows map
      this.windows.delete(currentProjectId);

      // Notify callback
      if (this.onWindowClosed) {
        this.onWindowClosed(currentProjectId);
      }

      // Rearrange remaining windows
      this.rearrangeWindows();
    });

    // Handle window move for snap to edges
    // Use windowEntry.currentProjectId to get the current project (handles single-mode reuse)
    window.on('move', () => {
      // Notify immediately (not debounced) so the speech bubble window can
      // follow along live while this window is being dragged.
      if (this.onWindowMoved) {
        this.onWindowMoved(windowEntry.currentProjectId);
      }
      this.handleWindowMove(windowEntry.currentProjectId);
    });

    return { window, blocked: false, switchedProject: null };
  }

  /**
   * Arrange all windows by state and project name
   * Right side: active states (thinking, planning, working, notification)
   * Left side: inactive states (start, idle, done, sleep)
   * Within each group: sorted by project name (Z first = rightmost)
   */
  arrangeWindowsByName() {
    // Character Only Mode windows are meant to be freely positioned like a
    // desktop pet — don't auto-rearrange them back into the grid on every
    // state change. handleWindowMove()'s off-screen clamp still applies
    // regardless, since that's a separate code path.
    if (this.characterOnlyMode) return;

    // Collect all windows with projectId and state
    const windowsList = [];
    for (const [projectId, entry] of this.windows) {
      if (this.isWindowValid(entry)) {
        const state = entry.state ? entry.state.state : 'idle';
        const isActive = ACTIVE_STATES.includes(state);
        windowsList.push({ projectId, entry, isActive });
      }
    }

    // Sort: active first (rightmost), then by name descending (Z first)
    windowsList.sort((a, b) => {
      // Active states come first (rightmost)
      if (a.isActive !== b.isActive) {
        return a.isActive ? -1 : 1;
      }
      // Within same group, sort by name descending (Z first = rightmost)
      return b.projectId.localeCompare(a.projectId);
    });

    // Assign positions (index 0 = rightmost)
    let index = 0;
    for (const { entry } of windowsList) {
      const position = this.calculatePosition(index);
      entry.window.setPosition(position.x, position.y);
      index++;
    }
  }

  /**
   * Rearrange windows after one closes or new one created
   * Sorts by project name alphabetically (A-Z from right to left)
   */
  rearrangeWindows() {
    this.arrangeWindowsByName();
  }

  /**
   * Handle window move event with debounced snap to edges
   * @param {string} projectId - Project identifier
   */
  handleWindowMove(projectId) {
    const entry = this.windows.get(projectId);
    if (!entry || !entry.window || entry.window.isDestroyed()) {
      return;
    }

    // Clear previous timer
    const existingTimer = this.snapTimers.get(projectId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timer - snap after debounce time (drag ended)
    const timerId = setTimeout(() => {
      if (!entry.window || entry.window.isDestroyed()) {
        return;
      }

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
    }, SNAP_DEBOUNCE);

    this.snapTimers.set(projectId, timerId);
  }

  // ========== Utility Methods ==========

  /**
   * Check if a window entry is valid (exists and not destroyed)
   * @param {Object} entry - Window entry from the Map
   * @returns {boolean}
   */
  isWindowValid(entry) {
    return entry && entry.window && !entry.window.isDestroyed();
  }

  /**
   * Get window by project ID
   * @param {string} projectId
   * @returns {BrowserWindow|null}
   */
  getWindow(projectId) {
    const entry = this.windows.get(projectId);
    return entry ? entry.window : null;
  }

  /**
   * Get state by project ID
   * @param {string} projectId
   * @returns {Object|null}
   */
  getState(projectId) {
    const entry = this.windows.get(projectId);
    return entry ? entry.state : null;
  }

  /**
   * Update state for a project with change detection
   * Note: Entry object is mutated to preserve event handler closure references.
   * The state property is replaced with a new object for partial immutability.
   * @param {string} projectId
   * @param {Object} newState
   * @returns {{updated: boolean, stateChanged: boolean, infoChanged: boolean}}
   */
  updateState(projectId, newState) {
    const entry = this.windows.get(projectId);
    if (!entry) {
      return { updated: false, stateChanged: false, infoChanged: false };
    }

    const oldState = entry.state || {};

    // Check if state changed
    const stateChanged = oldState.state !== newState.state;

    // Check if info fields changed (tool, model, memory, usage, character)
    const infoChanged = !stateChanged && (
      oldState.tool !== newState.tool ||
      oldState.model !== newState.model ||
      oldState.memory !== newState.memory ||
      oldState.usage5h !== newState.usage5h ||
      oldState.usageWeek !== newState.usageWeek ||
      oldState.character !== newState.character
    );

    // No change - skip update
    if (!stateChanged && !infoChanged) {
      return { updated: false, stateChanged: false, infoChanged: false };
    }

    // Mutate entry's state property (entry object must be preserved for event handler closures)
    entry.state = { ...newState };
    if (this.onStateUpdated) {
      this.onStateUpdated(projectId);
    }
    return { updated: true, stateChanged, infoChanged };
  }

  /**
   * Check if window exists for project
   * @param {string} projectId
   * @returns {boolean}
   */
  hasWindow(projectId) {
    const entry = this.windows.get(projectId);
    return entry !== undefined && entry.window !== null && !entry.window.isDestroyed();
  }

  /**
   * Send data to window via IPC
   * @param {string} projectId
   * @param {string} channel
   * @param {*} data
   * @returns {boolean}
   */
  sendToWindow(projectId, channel, data) {
    const entry = this.windows.get(projectId);
    if (this.isWindowValid(entry) && !entry.window.webContents.isDestroyed()) {
      entry.window.webContents.send(channel, data);
      return true;
    }
    return false;
  }

  /**
   * Close window for project
   * @param {string} projectId
   * @returns {boolean}
   */
  closeWindow(projectId) {
    const entry = this.windows.get(projectId);
    if (this.isWindowValid(entry)) {
      entry.window.close();
      return true;
    }
    return false;
  }

  /**
   * Close all windows
   */
  closeAllWindows() {
    for (const [projectId] of this.windows) {
      this.closeWindow(projectId);
    }
  }

  /**
   * Cleanup resources on app quit
   * Clears all pending timers
   */
  cleanup() {
    for (const [, timerId] of this.snapTimers) {
      clearTimeout(timerId);
    }
    this.snapTimers.clear();
  }

  /**
   * Show window for project
   * @param {string} projectId
   * @returns {boolean}
   */
  showWindow(projectId) {
    const entry = this.windows.get(projectId);
    if (this.isWindowValid(entry)) {
      entry.window.showInactive();
      return true;
    }
    return false;
  }

  /**
   * Show all windows
   * @returns {number} Number of windows shown
   */
  showAllWindows() {
    let count = 0;
    for (const [, entry] of this.windows) {
      if (this.isWindowValid(entry)) {
        entry.window.showInactive();
        count++;
      }
    }
    return count;
  }

  /**
   * Hide window for project
   * @param {string} projectId
   * @returns {boolean}
   */
  hideWindow(projectId) {
    const entry = this.windows.get(projectId);
    if (this.isWindowValid(entry)) {
      entry.window.hide();
      return true;
    }
    return false;
  }

  /**
   * Get all project IDs
   * @returns {string[]}
   */
  getProjectIds() {
    return Array.from(this.windows.keys());
  }

  /**
   * Get number of active windows
   * @returns {number}
   */
  getWindowCount() {
    return this.windows.size;
  }

  /**
   * Determine if a window should be always on top based on mode and state
   * @param {string|null} state - Current window state
   * @returns {boolean}
   */
  shouldBeAlwaysOnTop(state) {
    switch (this.alwaysOnTopMode) {
      case 'all':
        return true;
      case 'active-only':
        return state && ACTIVE_STATES.includes(state);
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
   * Set always on top mode and update all windows
   * @param {'active-only'|'all'|'disabled'} mode
   */
  setAlwaysOnTopMode(mode) {
    if (!ALWAYS_ON_TOP_MODES[mode]) return;

    this.alwaysOnTopMode = mode;
    this.store.set('alwaysOnTopMode', mode);

    // Update all windows based on new mode
    for (const [projectId, entry] of this.windows) {
      if (this.isWindowValid(entry)) {
        const state = entry.state ? entry.state.state : null;
        const shouldBeOnTop = this.shouldBeAlwaysOnTop(state);
        entry.window.setAlwaysOnTop(shouldBeOnTop, ALWAYS_ON_TOP_LEVEL);
        if (this.onAlwaysOnTopChanged) {
          this.onAlwaysOnTopChanged(projectId);
        }
      }
    }
  }

  /**
   * Update always on top for a specific window based on state
   * Active states (thinking, planning, working, notification) keep always on top
   * Inactive states immediately disable on top (prevents focus stealing)
   * Respects alwaysOnTopMode setting
   * @param {string} projectId
   * @param {string} state
   */
  updateAlwaysOnTopByState(projectId, state) {
    const entry = this.windows.get(projectId);
    if (!entry || !entry.window || entry.window.isDestroyed()) {
      return;
    }

    const isActiveState = ACTIVE_STATES.includes(state);

    if (this.alwaysOnTopMode === 'active-only') {
      if (isActiveState) {
        // Active state: immediately enable on top
        entry.window.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);
      } else {
        // Inactive states (start, idle, done, sleep): immediately disable on top
        // No grace period to prevent focus stealing
        entry.window.setAlwaysOnTop(false, ALWAYS_ON_TOP_LEVEL);
      }
    } else {
      // 'all' or 'disabled' mode: apply immediately without grace period
      const shouldBeOnTop = this.shouldBeAlwaysOnTop(state);
      entry.window.setAlwaysOnTop(shouldBeOnTop, ALWAYS_ON_TOP_LEVEL);
    }

    if (this.onAlwaysOnTopChanged) {
      this.onAlwaysOnTopChanged(projectId);
    }
  }

  /**
   * Get always on top setting (legacy compatibility)
   * @returns {boolean}
   * @deprecated Use getAlwaysOnTopMode() instead
   */
  getIsAlwaysOnTop() {
    return this.alwaysOnTopMode !== 'disabled';
  }

  /**
   * Get first window (for backward compatibility)
   * Returns the first (oldest) window from the Map iteration order
   * Note: Map preserves insertion order, so this returns the earliest created window
   * @returns {BrowserWindow|null}
   */
  getFirstWindow() {
    if (this.windows.size === 0) {
      return null;
    }
    // Return the first entry's window (oldest, by Map insertion order)
    const firstEntry = this.windows.values().next().value;
    return firstEntry ? firstEntry.window : null;
  }

  /**
   * Get states of all windows
   * @returns {Object.<string, Object>} Map of projectId to state
   */
  getStates() {
    const states = {};
    for (const [projectId, entry] of this.windows) {
      states[projectId] = entry.state;
    }
    return states;
  }

  /**
   * Get all window entries
   * @returns {Object.<string, {window: BrowserWindow, state: Object}>}
   */
  getWindows() {
    const result = {};
    for (const [projectId, entry] of this.windows) {
      result[projectId] = entry;
    }
    return result;
  }

  /**
   * Show and focus the first available window
   * @returns {boolean} Whether a window was shown
   */
  showFirstWindow() {
    const firstWindow = this.getFirstWindow();
    if (firstWindow && !firstWindow.isDestroyed()) {
      firstWindow.show();
      firstWindow.focus();
      return true;
    }
    return false;
  }

  /**
   * Get terminal ID for a project
   * @param {string} projectId
   * @returns {string|null}
   */
  getTerminalId(projectId) {
    const entry = this.windows.get(projectId);
    return entry && entry.state ? entry.state.terminalId || null : null;
  }

  /**
   * Get project ID by webContents
   * @param {Electron.WebContents} webContents
   * @returns {string|null}
   */
  getProjectIdByWebContents(webContents) {
    for (const [projectId, entry] of this.windows) {
      if (entry.window && !entry.window.isDestroyed() &&
          entry.window.webContents === webContents) {
        return projectId;
      }
    }
    return null;
  }

  /**
   * Get debug info for all windows
   * @returns {Object}
   */
  getDebugInfo() {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();

    const windowsInfo = [];
    for (const [projectId, entry] of this.windows) {
      if (this.isWindowValid(entry)) {
        windowsInfo.push({
          projectId,
          bounds: entry.window.getBounds(),
          state: entry.state ? entry.state.state : null
        });
      }
    }

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
      windows: windowsInfo,
      windowCount: this.windows.size,
      maxWindows: MAX_WINDOWS,
      alwaysOnTopMode: this.alwaysOnTopMode,
      platform: process.platform
    };
  }
}

module.exports = { MultiWindowManager };
