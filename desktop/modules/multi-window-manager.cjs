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
  MAX_STATE_REGISTRY_SIZE,
  SNAP_THRESHOLD,
  SNAP_DEBOUNCE,
  LOCK_MODES,
  ALWAYS_ON_TOP_MODES,
  ACTIVE_STATES,
  SPEECH_BUBBLE_FIELDS,
  CHARACTER_NAMES,
  CHAR_Y_BASE,
  CHAR_SIZE
} = require('../shared/config.cjs');

// Platform-specific always-on-top level
// macOS: 'floating' (required for tray menu visibility)
// Windows/Linux: 'screen-saver' (required for window visibility in WSL/Windows)
const ALWAYS_ON_TOP_LEVEL = process.platform === 'darwin' ? 'floating' : 'screen-saver';

// Character Mode window height: just tall enough for the character sprite
// (CHAR_Y_BASE + CHAR_SIZE) plus a little clearance for its floating
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
    this.onResyncNeeded = null;  // callback: () => void, fires after leaving Input Mode

    // Persistent settings
    this.store = new Store({
      defaults: {
        windowMode: 'multi',  // 'multi' or 'single'
        lockedProject: null,
        lockMode: 'on-thinking',  // 'first-project' or 'on-thinking'
        alwaysOnTopMode: 'active-only',  // 'active-only', 'all', or 'disabled'
        projectList: [],  // Persisted project list for lock menu
        speechBubbleFields: { status: true, project: true, model: true, memory: true, usage5h: true, usageWeek: true },
        windowPositions: {},  // { [positionKey]: {x, y} } - last dragged position, restored on next creation
        characterLock: 'auto'  // 'auto' or a CHARACTER_NAMES entry - forces every window to show one character
      }
    });

    // Window mode: 'multi' (multiple windows) or 'single' (one window with lock)
    this.windowMode = this.store.get('windowMode');
    this.lockedProject = this.store.get('lockedProject');
    this.lockMode = this.store.get('lockMode');
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
    this.characterLock = this.store.get('characterLock');
    this.windowPositions = this.store.get('windowPositions');

    // Project list (tracks all projects seen) - persisted
    this.projectList = this.store.get('projectList') || [];

    // App mode: 'window' (per-project windows), 'character' (single persistent
    // character+bubble), or 'input' (headless, state collection only).
    // Not in the `defaults` above on purpose — an unset key must be
    // distinguishable from an explicit 'window', so first run after an
    // upgrade can migrate from the legacy characterOnlyMode checkbox instead
    // of silently defaulting to 'window'.
    this.appMode = this.store.get('appMode');
    if (this.appMode === undefined) {
      this.appMode = this.store.get('characterOnlyMode') === true ? 'character' : 'window';
      this.store.set('appMode', this.appMode);
    }

    // Latest known state per project, independent of whether a window exists
    // for it — lets Input Mode collect status in the background and lets any
    // mode switch immediately recover the last known state.
    this.stateRegistry = new Map();

    // Character Mode's single persistent window always targets this project.
    this.focusedProjectId = null;
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
  // App Mode Management (Character / Window / Input)
  // ============================================================================

  /**
   * Get current app mode
   * @returns {'character'|'window'|'input'}
   */
  getAppMode() {
    return this.appMode;
  }

  /**
   * @returns {boolean} whether the app is currently in Character Mode
   */
  isCharacterMode() {
    return this.appMode === 'character';
  }

  /**
   * Pick which project Character Mode's window should show when entering
   * the mode with state already sitting in stateRegistry (e.g. switching
   * from Window/Input Mode mid-session) — prefers an active project,
   * falling back to whichever was seen first.
   * @returns {string|null}
   */
  pickInitialFocus() {
    for (const [projectId, state] of this.stateRegistry) {
      if (state && ACTIVE_STATES.includes(state.state)) {
        return projectId;
      }
    }
    const first = this.stateRegistry.keys().next();
    return first.done ? null : first.value;
  }

  /**
   * Set app mode
   * @param {'character'|'window'|'input'} mode
   */
  setAppMode(mode) {
    if (mode !== 'character' && mode !== 'window' && mode !== 'input') return;
    if (mode === this.appMode) return;

    this.appMode = mode;
    this.store.set('appMode', mode);
    this.focusedProjectId = null;

    if (mode === 'character') {
      const initialFocus = this.pickInitialFocus();

      if (initialFocus) {
        // Reuse/retarget an existing window if one is available (avoids a
        // destroy-then-recreate race on the window we're about to keep),
        // then discard every other leftover window from the previous mode.
        const result = this.createWindow(initialFocus);
        // A reused window keeps whatever size it had in the previous mode
        // (createWindow() only sets the height on brand-new windows) — shrink
        // it to Character Mode's height explicitly.
        if (this.isWindowValid(this.windows.get(initialFocus))) {
          result.window.setSize(WINDOW_WIDTH, CHARACTER_ONLY_WINDOW_HEIGHT);
        }
        this.updateState(initialFocus, this.stateRegistry.get(initialFocus));
        for (const projectId of this.getProjectIds()) {
          if (projectId !== initialFocus) {
            this.discardWindow(projectId);
          }
        }
        // A reused window already had its one-shot 'display-mode-update' push
        // sent back when it was first created (possibly in a different app
        // mode) — push the current settings again so it actually hides its
        // title bar/device frame now that it's showing the character.
        this.broadcastDisplayMode();
      } else {
        for (const projectId of this.getProjectIds()) {
          this.discardWindow(projectId);
        }
      }
      return;
    }

    // Leaving Character Mode, or switching to/from Input Mode: none of the
    // previous mode's windows carry over as-is.
    for (const projectId of this.getProjectIds()) {
      this.discardWindow(projectId);
    }

    if (mode === 'window' && this.onResyncNeeded) {
      // Recreate per-project windows from whatever state is tracked.
      this.onResyncNeeded();
    }
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

    // Enforce max limit (remove oldest entries), dropping their saved
    // window position too so windowPositions doesn't grow unbounded.
    while (this.projectList.length > MAX_PROJECT_LIST) {
      const evicted = this.projectList.shift();
      this.deleteWindowPosition(evicted);
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
  // Display Mode Management (Speech Bubble)
  // ============================================================================

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
      characterOnlyMode: this.isCharacterMode(),
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
  // Character Lock Management
  // ============================================================================

  /**
   * Get current character lock
   * @returns {'auto'|string} 'auto', or a CHARACTER_NAMES entry
   */
  getCharacterLock() {
    return this.characterLock;
  }

  /**
   * Force every window to display one character regardless of what incoming
   * status updates specify ('auto' restores each project's own character on
   * its next status update — already-open windows aren't retroactively
   * corrected, since the original character isn't tracked separately).
   * @param {'auto'|string} character
   */
  setCharacterLock(character) {
    if (character !== 'auto' && !CHARACTER_NAMES.includes(character)) return;

    this.characterLock = character;
    this.store.set('characterLock', character);

    if (character === 'auto') return;

    // Immediately reflect the lock in every currently open window instead of
    // waiting for each project's next status update.
    for (const [projectId, entry] of this.windows) {
      if (this.isWindowValid(entry) && entry.state && entry.state.character !== character) {
        const newState = { ...entry.state, character };
        this.updateState(projectId, newState);
        this.sendToWindow(projectId, 'state-update', newState);
      }
    }
  }

  // ============================================================================
  // Window Position Calculation
  // ============================================================================

  /**
   * Key used to save/restore a window's last dragged position. Character
   * Mode shares one window across whichever project is focused, so it uses a
   * fixed key instead of the (constantly changing) focused project id;
   * Window Mode saves one position per project.
   * @param {string} projectId
   * @returns {string}
   */
  positionKeyFor(projectId) {
    return this.isCharacterMode() ? '__character__' : projectId;
  }

  /**
   * @param {string} positionKey
   * @returns {{x: number, y: number}|null}
   */
  getSavedWindowPosition(positionKey) {
    return this.windowPositions[positionKey] || null;
  }

  /**
   * Persist a window's position, keyed by positionKeyFor(). Used as the spawn
   * position the next time a window is created for that key — existing open
   * windows are left alone (e.g. Window Mode's grid keeps managing them after
   * creation; only the initial spawn point comes from here).
   * @param {string} positionKey
   * @param {{x: number, y: number}} position
   */
  saveWindowPosition(positionKey, position) {
    this.windowPositions = { ...this.windowPositions, [positionKey]: position };
    this.store.set('windowPositions', this.windowPositions);
  }

  /**
   * Remove a persisted window position (e.g. once its project ages out of
   * projectList via LRU eviction).
   * @param {string} positionKey
   */
  deleteWindowPosition(positionKey) {
    if (!positionKey || !(positionKey in this.windowPositions)) return;
    const updated = { ...this.windowPositions };
    delete updated[positionKey];
    this.windowPositions = updated;
    this.store.set('windowPositions', this.windowPositions);
  }

  /**
   * Clamp a candidate spawn position (e.g. restored from a saved position)
   * to whichever display it falls on, so a screen/monitor configuration
   * change since it was saved can't spawn the window off-screen.
   * @param {{x: number, y: number}} position
   * @param {number} height
   * @returns {{x: number, y: number}}
   */
  clampPositionToScreen(position, height) {
    const display = screen.getDisplayMatching({ x: position.x, y: position.y, width: WINDOW_WIDTH, height });
    const { workArea } = display;
    const x = Math.min(Math.max(position.x, workArea.x), workArea.x + workArea.width - WINDOW_WIDTH);
    const y = Math.min(Math.max(position.y, workArea.y), workArea.y + workArea.height - height);
    return { x, y };
  }

  /**
   * Number of window columns that fit in the given work area width.
   * @param {Electron.Rectangle} workArea
   * @returns {number}
   */
  gridColumns(workArea) {
    return Math.max(1, Math.floor((workArea.width + WINDOW_GAP) / (WINDOW_WIDTH + WINDOW_GAP)));
  }

  /**
   * Number of window rows that fit in the given work area height.
   * @param {Electron.Rectangle} workArea
   * @returns {number}
   */
  gridRows(workArea) {
    const windowHeight = this.isCharacterMode() ? CHARACTER_ONLY_WINDOW_HEIGHT : WINDOW_HEIGHT;
    return Math.max(1, Math.floor((workArea.height + WINDOW_GAP) / (windowHeight + WINDOW_GAP)));
  }

  /**
   * Calculate window position within a 2D grid.
   * Row 0 is topmost; within a row, col 0 is rightmost (matches the previous
   * single-row layout, extended to wrap into a new row below once a row
   * fills up, like tiles on a board).
   * @param {number} index - Window index (0 = most prominent: top row, rightmost)
   * @returns {{x: number, y: number}}
   */
  calculateGridPosition(index) {
    const { workArea } = screen.getPrimaryDisplay();
    const cols = this.gridColumns(workArea);
    const col = index % cols;
    const row = Math.floor(index / cols);
    const windowHeight = this.isCharacterMode() ? CHARACTER_ONLY_WINDOW_HEIGHT : WINDOW_HEIGHT;

    const x = workArea.x + workArea.width - WINDOW_WIDTH - (col * (WINDOW_WIDTH + WINDOW_GAP));
    const y = workArea.y + (row * (windowHeight + WINDOW_GAP));
    return { x, y };
  }

  /**
   * Check if more windows can be created.
   * Considers MAX_WINDOWS limit and whether the 2D grid still has a free cell
   * on screen — once the grid is full (both across and down), no more
   * windows are created.
   * @returns {boolean}
   */
  canCreateWindow() {
    if (this.windows.size >= MAX_WINDOWS) {
      return false;
    }

    const { workArea } = screen.getPrimaryDisplay();
    const gridCapacity = this.gridColumns(workArea) * this.gridRows(workArea);

    return this.windows.size < gridCapacity;
  }

  /**
   * Create a window for a project
   * In single mode (or Character Mode): reuses existing window or respects lock
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

    // Single-window family: Window Mode's single sub-mode reuses/locks a
    // window per the user's lock settings; Character Mode always reuses the
    // one persistent window instead (no lock — focus is automatic, see
    // selectFocus()).
    const isCharacterMode = this.isCharacterMode();
    if (this.windowMode === 'single' || isCharacterMode) {
      // If locked to different project, block (Window Mode's single sub-mode only)
      if (!isCharacterMode && this.lockedProject && this.lockedProject !== projectId) {
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

    const windowHeight = this.isCharacterMode() ? CHARACTER_ONLY_WINDOW_HEIGHT : WINDOW_HEIGHT;

    // Spawn at this project's/Character Mode's last dragged position if one
    // was saved, otherwise the default top-right grid slot. Window Mode's
    // grid still takes over immediately after (see arrangeWindowsByName()),
    // so this mainly matters for Character Mode's window, which isn't
    // auto-rearranged.
    const savedPosition = this.getSavedWindowPosition(this.positionKeyFor(projectId));
    const position = savedPosition
      ? this.clampPositionToScreen(savedPosition, windowHeight)
      : this.calculateGridPosition(0);

    // Shift existing windows into the grid
    // Windows will be arranged after ready-to-show

    // macOS: Use 'panel' type to prevent focus stealing
    const windowOptions = {
      width: WINDOW_WIDTH,
      height: windowHeight,
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
        characterOnlyMode: this.isCharacterMode(),
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
    // Character Mode's window is meant to be freely positioned like a
    // desktop pet — don't auto-rearrange it back into the grid on every
    // state change. handleWindowMove()'s off-screen clamp still applies
    // regardless, since that's a separate code path.
    if (this.isCharacterMode()) return;

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

    // Assign grid positions (index 0 = top row, rightmost)
    let index = 0;
    for (const { entry } of windowsList) {
      const position = this.calculateGridPosition(index);
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

      // Remember where this settled so the next window created for this
      // project (or Character Mode's window) spawns here instead of the
      // default corner. Re-read currentProjectId in case the window was
      // reused for a different project during the debounce window.
      this.saveWindowPosition(this.positionKeyFor(entry.currentProjectId), { x: newX, y: newY });
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
   * Cap stateRegistry's size, since every incoming status keeps it growing
   * (unlike projectList, it has no MAX_PROJECT_LIST-style limit). Evicts the
   * least-recently-updated entries first, skipping any project that still
   * has a live window — those must stay reachable via getState().
   */
  pruneStateRegistry() {
    while (this.stateRegistry.size > MAX_STATE_REGISTRY_SIZE) {
      let evicted = false;
      for (const projectId of this.stateRegistry.keys()) {
        if (!this.windows.has(projectId)) {
          this.stateRegistry.delete(projectId);
          evicted = true;
          break;
        }
      }
      if (!evicted) break; // every remaining entry still has a live window
    }
  }

  /**
   * Get the latest known state for a project, even if no window currently
   * exists for it (e.g. Input Mode, or after a mode switch closed windows).
   * @param {string} projectId
   * @returns {Object|null}
   */
  getRegisteredState(projectId) {
    return this.stateRegistry.get(projectId) || null;
  }

  /**
   * Get all projects with a known state, independent of window existence.
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
   * Decide which project Character Mode's single window should show, given
   * an incoming status update. An active-state project always takes focus;
   * otherwise the most recently updated project keeps focus unless the
   * currently focused project is itself still active.
   * @param {string} projectId
   * @param {string} state
   * @returns {string} the projectId that should now be focused
   */
  selectFocus(projectId, state) {
    if (ACTIVE_STATES.includes(state)) {
      this.focusedProjectId = projectId;
      return this.focusedProjectId;
    }

    if (!this.focusedProjectId) {
      this.focusedProjectId = projectId;
      return this.focusedProjectId;
    }

    const focusedState = this.stateRegistry.get(this.focusedProjectId);
    const focusedIsActive = focusedState && ACTIVE_STATES.includes(focusedState.state);
    if (!focusedIsActive) {
      this.focusedProjectId = projectId;
    }

    return this.focusedProjectId;
  }

  /**
   * Ensure a window exists for projectId per the current window/lock mode,
   * apply auto-lock, and update its state. Always records the incoming state
   * in stateRegistry first, regardless of outcome, so state survives even
   * when no window is created for it.
   * Shared by the HTTP POST /status and WebSocket status-update paths, which
   * otherwise duplicate this exact sequence.
   * @param {string} projectId
   * @param {Object} stateData - validated/normalized state data
   * @returns {{
   *   blocked: boolean,
   *   maxWindowsReached: boolean,
   *   switchedProject: string|null,
   *   updateResult: {updated: boolean, stateChanged: boolean, infoChanged: boolean},
   *   stateData: Object
   * }}
   */
  routeStatusUpdate(projectId, stateData) {
    // Character Lock overrides whatever character the incoming status
    // specifies — reassign the local reference to a new object (not the
    // caller's) so every downstream use (stateRegistry, window state, the
    // 'state-update' IPC payload the caller sends afterward) stays in sync.
    if (this.characterLock !== 'auto') {
      stateData = { ...stateData, character: this.characterLock };
    }

    // Delete-then-set moves projectId to the end of the Map's insertion
    // order, so pruneStateRegistry() evicts the least-recently-updated
    // project first rather than whichever happened to be added earliest.
    this.stateRegistry.delete(projectId);
    this.stateRegistry.set(projectId, stateData);
    this.pruneStateRegistry();

    if (this.appMode === 'input') {
      // Input Mode collects state in the background only — no window is ever
      // created for it.
      return {
        blocked: false, maxWindowsReached: false, switchedProject: null,
        updateResult: { updated: false, stateChanged: false, infoChanged: false },
        stateData
      };
    }

    if (this.isCharacterMode()) {
      const focusedProjectId = this.selectFocus(projectId, stateData.state);

      if (focusedProjectId !== projectId) {
        // Focus stayed on a different (still-active) project — state was
        // recorded above, but the single visible window doesn't change.
        return {
          blocked: false, maxWindowsReached: false, switchedProject: null,
          updateResult: { updated: false, stateChanged: false, infoChanged: false },
          stateData
        };
      }

      const result = this.createWindow(focusedProjectId);
      const updateResult = this.updateState(focusedProjectId, stateData);
      return { blocked: false, maxWindowsReached: false, switchedProject: result.switchedProject, updateResult, stateData };
    }

    let switchedProject = null;

    if (!this.getWindow(projectId)) {
      const result = this.createWindow(projectId);

      if (result.blocked) {
        return {
          blocked: true, maxWindowsReached: false, switchedProject: null,
          updateResult: { updated: false, stateChanged: false, infoChanged: false },
          stateData
        };
      }

      if (!result.window) {
        return {
          blocked: false, maxWindowsReached: true, switchedProject: null,
          updateResult: { updated: false, stateChanged: false, infoChanged: false },
          stateData
        };
      }

      switchedProject = result.switchedProject;
    }

    this.applyAutoLock(projectId, stateData.state);
    const updateResult = this.updateState(projectId, stateData);

    return { blocked: false, maxWindowsReached: false, switchedProject, updateResult, stateData };
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
   * Close a window and remove its map entry immediately, instead of waiting
   * for the async 'closed' event — needed when the caller must see
   * `this.windows` reflect the removal within the same tick (e.g. an app
   * mode switch that reuses one window while discarding the rest). Still
   * fires onWindowClosed synchronously so cleanup (timers, speech bubble)
   * runs exactly as it would on a normal close; the eventual real 'closed'
   * event becomes a no-op since its own guard sees the entry already gone.
   * @param {string} projectId
   */
  discardWindow(projectId) {
    const entry = this.windows.get(projectId);
    if (!entry) return;

    this.windows.delete(projectId);

    const snapTimer = this.snapTimers.get(projectId);
    if (snapTimer) {
      clearTimeout(snapTimer);
      this.snapTimers.delete(projectId);
    }

    if (this.isWindowValid(entry)) {
      entry.window.close();
    }

    if (this.onWindowClosed) {
      this.onWindowClosed(projectId);
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
