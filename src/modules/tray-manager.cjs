/**
 * System tray management for Vibe Monitor
 */

const { Tray, Menu, nativeImage, BrowserWindow } = require('electron');
const { createCanvas } = require('canvas');
const fs = require('fs');
const {
  STATE_COLORS, CHARACTER_CONFIG, DEFAULT_CHARACTER,
  HTTP_PORT, LOCK_MODES, ALWAYS_ON_TOP_MODES, APP_MODES,
  VALID_STATES, CHARACTER_NAMES, TRAY_ICON_SIZE,
  STATS_CACHE_PATH, SPEECH_BUBBLE_FIELDS
} = require('../shared/config.cjs');

const COLOR_EYE = '#000000';

const SPEECH_BUBBLE_FIELD_LABELS = {
  status: 'Status',
  project: 'Project',
  model: 'Model',
  memory: 'Memory',
  usage5h: 'Usage 5h',
  usageWeek: 'Usage Week'
};

// Tray icon cache for performance
const trayIconCache = new Map();

/**
 * Create tray icon with state-based background color using canvas
 */
function createTrayIcon(state, character = 'clawd', hasUpdate = false) {
  const cacheKey = `${state}-${character}-${hasUpdate}`;

  // Return cached icon if available
  if (trayIconCache.has(cacheKey)) {
    return trayIconCache.get(cacheKey);
  }

  const size = TRAY_ICON_SIZE;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  const bgColor = STATE_COLORS[state] || STATE_COLORS.idle;
  const charConfig = CHARACTER_CONFIG[character] || CHARACTER_CONFIG[DEFAULT_CHARACTER];
  const charColor = charConfig.color;
  const charName = charConfig.name;

  // Helper to draw filled rectangle
  function rect(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  }

  // Clear canvas (transparent)
  ctx.clearRect(0, 0, size, size);

  // Draw rounded background
  const radius = 4;
  ctx.fillStyle = bgColor;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, radius);
  ctx.fill();

  if (charName === 'kiro') {
    // Draw ghost character for kiro
    rect(6, 4, 10, 2, charColor);   // Rounded top
    rect(5, 6, 12, 8, charColor);   // Main body
    rect(5, 14, 4, 3, charColor);   // Left wave
    rect(9, 15, 4, 2, charColor);   // Middle wave
    rect(13, 14, 4, 3, charColor);  // Right wave
    rect(7, 8, 2, 2, COLOR_EYE);    // Left eye
    rect(13, 8, 2, 2, COLOR_EYE);   // Right eye
  } else if (charName === 'claw') {
    // Draw claw character (red with antennae)
    rect(8, 2, 2, 4, charColor);    // Left antenna
    rect(12, 2, 2, 4, charColor);   // Right antenna
    rect(5, 6, 12, 10, charColor);  // Body
    rect(6, 16, 3, 3, charColor);   // Left leg
    rect(13, 16, 3, 3, charColor);  // Right leg
    rect(7, 10, 2, 2, '#40E0D0');   // Left eye (cyan)
    rect(13, 10, 2, 2, '#40E0D0');  // Right eye (cyan)
  } else if (charName === 'codex') {
    // Draw codex character (green terminal robot)
    rect(8, 2, 6, 2, charColor);    // Top cap
    rect(6, 4, 10, 2, charColor);   // Head taper
    rect(5, 6, 12, 9, charColor);   // Main body
    rect(3, 9, 2, 5, charColor);    // Left arm
    rect(17, 9, 2, 5, charColor);   // Right arm
    rect(7, 15, 3, 4, charColor);   // Left leg
    rect(12, 15, 3, 4, charColor);  // Right leg
    rect(7, 9, 2, 2, COLOR_EYE);    // Left eye
    rect(12, 9, 2, 2, COLOR_EYE);   // Right eye
    rect(9, 12, 4, 1, COLOR_EYE);   // Mouth
  } else if (charName === 'daangni') {
    // Draw daangni character (round face with fluffy teal top)
    const teal = '#2EC4B6';
    rect(7, 2, 8, 4, teal);          // Fluffy top
    rect(5, 3, 3, 3, teal);          // Left tuft
    rect(14, 3, 3, 3, teal);         // Right tuft
    rect(4, 6, 14, 12, charColor);   // Round face
    rect(3, 9, 2, 6, charColor);     // Left cheek
    rect(17, 9, 2, 6, charColor);    // Right cheek
    rect(7, 11, 2, 2, COLOR_EYE);    // Left eye
    rect(13, 11, 2, 2, COLOR_EYE);   // Right eye
    rect(10, 15, 2, 1, COLOR_EYE);   // Nose
  } else {
    // Draw clawd character (default)
    rect(4, 6, 14, 8, charColor);   // Body
    rect(2, 8, 2, 3, charColor);    // Left arm
    rect(18, 8, 2, 3, charColor);   // Right arm
    rect(5, 14, 2, 4, charColor);   // Left outer leg
    rect(8, 14, 2, 4, charColor);   // Left inner leg
    rect(12, 14, 2, 4, charColor);  // Right inner leg
    rect(15, 14, 2, 4, charColor);  // Right outer leg
    rect(6, 9, 2, 2, COLOR_EYE);    // Left eye
    rect(14, 9, 2, 2, COLOR_EYE);   // Right eye
  }

  if (hasUpdate) {
    // Small badge in the top-right corner signaling an update is available.
    ctx.fillStyle = '#FF6633';
    ctx.beginPath();
    ctx.arc(size - 5, 5, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Convert canvas to PNG buffer and create nativeImage
  const pngBuffer = canvas.toBuffer('image/png');
  const icon = nativeImage.createFromBuffer(pngBuffer);

  // Cache the icon for future use
  trayIconCache.set(cacheKey, icon);

  return icon;
}

class TrayManager {
  constructor(windowManager, app, stateManager, wsClient = null) {
    this.tray = null;
    this.windowManager = windowManager;
    this.app = app;
    this.stateManager = stateManager;
    this.wsClient = wsClient;
    this.hookInstaller = null;
    this.updateChecker = null;
    this.settingsWindowManager = null;
    this.statsWindow = null;
  }

  /**
   * Set WebSocket client reference (can be set after construction)
   * @param {WsClient} wsClient
   */
  setWsClient(wsClient) {
    this.wsClient = wsClient;
  }

  /**
   * Set HookInstaller reference (can be set after construction)
   * @param {HookInstaller} hookInstaller
   */
  setHookInstaller(hookInstaller) {
    this.hookInstaller = hookInstaller;
  }

  /**
   * Set UpdateChecker reference (can be set after construction)
   * @param {UpdateChecker} updateChecker
   */
  setUpdateChecker(updateChecker) {
    this.updateChecker = updateChecker;
  }

  /**
   * Set SettingsWindowManager reference (can be set after construction)
   * @param {SettingsWindowManager} settingsWindowManager
   */
  setSettingsWindowManager(settingsWindowManager) {
    this.settingsWindowManager = settingsWindowManager;
  }

  openStatsWindow() {
    // If window exists, close it first
    if (this.statsWindow && !this.statsWindow.isDestroyed()) {
      this.statsWindow.close();
      this.statsWindow = null;
    }

    // Create new stats window (frameless like monitor window)
    this.statsWindow = new BrowserWindow({
      width: 640,
      height: 475,
      frame: false,
      transparent: true,
      resizable: false,
      hasShadow: true,
      alwaysOnTop: false,
      skipTaskbar: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    this.statsWindow.loadURL(`http://127.0.0.1:${HTTP_PORT}/stats`);

    this.statsWindow.on('closed', () => {
      this.statsWindow = null;
    });

    // Close on blur (lose focus)
    this.statsWindow.on('blur', () => {
      if (this.statsWindow && !this.statsWindow.isDestroyed()) {
        this.statsWindow.close();
      }
    });
  }

  /**
   * Get state from first window or return default state
   * @returns {Object}
   */
  getFirstWindowState() {
    const projectIds = this.windowManager.getProjectIds();
    if (projectIds.length === 0) {
      return { state: 'idle', character: DEFAULT_CHARACTER, project: null };
    }
    const firstProjectId = projectIds[0];
    const state = this.windowManager.getState(firstProjectId);
    return state || { state: 'idle', character: DEFAULT_CHARACTER, project: firstProjectId };
  }

  /**
   * Whether an update is available/downloading/downloaded, for the tray icon badge.
   * @returns {boolean}
   */
  hasUpdateAvailable() {
    return Boolean(this.updateChecker && this.updateChecker.getState().status !== null);
  }

  createTray() {
    const state = this.getFirstWindowState();
    const icon = createTrayIcon(state.state, state.character, this.hasUpdateAvailable());
    this.tray = new Tray(icon);
    this.tray.setToolTip('Vibe Monitor');
    this.updateMenu();

    // Left-click to show menu (Windows support)
    this.tray.on('click', () => {
      this.tray.popUpContextMenu();
    });

    return this.tray;
  }

  updateIcon() {
    if (!this.tray) return;
    const state = this.getFirstWindowState();
    const icon = createTrayIcon(state.state, state.character, this.hasUpdateAvailable());
    this.tray.setImage(icon);
  }

  buildWindowsSubmenu() {
    const projectIds = this.windowManager.getProjectIds();

    if (projectIds.length === 0) {
      return [{ label: 'No windows', enabled: false }];
    }

    const items = projectIds.map(projectId => {
      const state = this.windowManager.getState(projectId);
      const currentState = state ? state.state : 'idle';
      const currentCharacter = state ? state.character : DEFAULT_CHARACTER;
      return {
        label: `${projectId} (${currentState})`,
        submenu: [
          { label: 'Show', click: () => this.windowManager.showWindow(projectId) },
          { label: 'Close', click: () => this.windowManager.closeWindow(projectId) },
          { type: 'separator' },
          {
            label: 'State',
            submenu: VALID_STATES.map(s => ({
              label: s,
              type: 'radio',
              checked: currentState === s,
              click: () => {
                // Re-fetch state at click time to avoid stale closure reference
                const currentState = this.windowManager.getState(projectId);
                if (!currentState) return;
                const newState = { ...currentState, state: s };
                this.windowManager.updateState(projectId, newState);
                this.windowManager.sendToWindow(projectId, 'state-update', newState);
                this.windowManager.updateAlwaysOnTopByState(projectId, s);
                this.stateManager.setupStateTimeout(projectId, s);
                this.updateMenu();
                this.updateIcon();
              }
            }))
          },
          {
            label: 'Character',
            submenu: CHARACTER_NAMES.map(c => ({
              label: c,
              type: 'radio',
              checked: currentCharacter === c,
              click: () => {
                // Re-fetch state at click time to avoid stale closure reference
                const currentState = this.windowManager.getState(projectId);
                if (!currentState) return;
                const newState = { ...currentState, character: c };
                this.windowManager.updateState(projectId, newState);
                this.windowManager.sendToWindow(projectId, 'state-update', newState);
                this.updateMenu();
                this.updateIcon();
              }
            }))
          }
        ]
      };
    });

    items.push({ type: 'separator' });
    items.push({
      label: 'Show All',
      enabled: projectIds.length > 0,
      click: () => this.windowManager.showAllWindows()
    });
    items.push({
      label: 'Close All',
      enabled: projectIds.length > 0,
      click: () => this.windowManager.closeAllWindows()
    });

    return items;
  }

  buildProjectLockSubmenu() {
    const items = [];
    const lockMode = this.windowManager.getLockMode();
    const lockedProject = this.windowManager.getLockedProject();
    const projectList = this.windowManager.getProjectList();

    // Lock Mode selection
    items.push({
      label: 'Lock Mode',
      submenu: Object.entries(LOCK_MODES).map(([mode, label]) => ({
        label: label,
        type: 'radio',
        checked: lockMode === mode,
        click: () => {
          this.windowManager.setLockMode(mode);
          this.updateMenu();
        }
      }))
    });

    items.push({ type: 'separator' });

    if (projectList.length === 0) {
      items.push({
        label: 'No projects',
        enabled: false
      });
    } else {
      // List all projects sorted by name
      const sortedProjects = [...projectList].sort((a, b) => a.localeCompare(b));
      sortedProjects.forEach(project => {
        const isLocked = project === lockedProject;
        items.push({
          label: project,
          type: 'radio',
          checked: isLocked,
          click: () => {
            this.windowManager.lockProject(project);
            this.updateMenu();
            this.updateIcon();
          }
        });
      });

      items.push({ type: 'separator' });
    }

    // Unlock option
    items.push({
      label: 'Unlock',
      enabled: lockedProject !== null,
      click: () => {
        this.windowManager.unlockProject();
        this.updateMenu();
      }
    });

    return items;
  }

  buildAppModeSubmenu() {
    const currentMode = this.windowManager.getAppMode();

    return Object.entries(APP_MODES).map(([mode, label]) => ({
      label: label,
      type: 'radio',
      checked: currentMode === mode,
      click: () => {
        this.windowManager.setAppMode(mode);
        this.updateMenu();
        this.updateIcon();
      }
    }));
  }

  buildCharacterLockSubmenu() {
    const currentLock = this.windowManager.getCharacterLock();

    const items = [{
      label: 'Auto',
      type: 'radio',
      checked: currentLock === 'auto',
      click: () => {
        this.windowManager.setCharacterLock('auto');
        this.updateMenu();
        this.updateIcon();
      }
    }];

    for (const c of CHARACTER_NAMES) {
      items.push({
        label: c,
        type: 'radio',
        checked: currentLock === c,
        click: () => {
          this.windowManager.setCharacterLock(c);
          this.updateMenu();
          this.updateIcon();
        }
      });
    }

    return items;
  }

  buildAlwaysOnTopSubmenu() {
    const currentMode = this.windowManager.getAlwaysOnTopMode();

    return Object.entries(ALWAYS_ON_TOP_MODES).map(([mode, label]) => ({
      label: label,
      type: 'radio',
      checked: currentMode === mode,
      click: () => {
        this.windowManager.setAlwaysOnTopMode(mode);
        this.updateMenu();
      }
    }));
  }

  buildSpeechBubbleSubmenu() {
    const fields = this.windowManager.getSpeechBubbleFields();

    return SPEECH_BUBBLE_FIELDS.map(field => ({
      label: SPEECH_BUBBLE_FIELD_LABELS[field] || field,
      type: 'checkbox',
      checked: !!fields[field],
      click: () => {
        const current = this.windowManager.getSpeechBubbleFields();
        this.windowManager.setSpeechBubbleField(field, !current[field]);
        this.updateMenu();
      }
    }));
  }

  buildWebSocketStatusMenu() {
    if (!this.wsClient) {
      return [];
    }

    const status = this.wsClient.getStatus();
    let statusLabel;
    let statusIcon;

    switch (status) {
      case 'connected':
        statusIcon = '●';
        statusLabel = 'WebSocket: Connected';
        break;
      case 'connecting':
        statusIcon = '○';
        statusLabel = 'WebSocket: Connecting...';
        break;
      case 'disconnected':
        statusIcon = '○';
        statusLabel = 'WebSocket: Disconnected';
        break;
      case 'not-configured':
      default:
        statusIcon = '○';
        statusLabel = 'WebSocket: Not configured';
    }

    return [
      {
        label: `${statusIcon} ${statusLabel}`,
        enabled: false
      }
    ];
  }

  /**
   * Per-tool install status/action for the "AI Tool Hooks" submenu.
   * Not detected/already-installed tools are shown disabled; a tool that's
   * present but missing its VibeMon hook gets a manual "Install..." action
   * (bypasses the dismissed/suppressed filters used by the periodic check).
   */
  buildHookInstallerSubmenu() {
    if (!this.hookInstaller) {
      return [{ label: 'Unavailable', enabled: false }];
    }

    return this.hookInstaller.getCachedStatuses().map(tool => {
      if (!tool.present) {
        return { label: `${tool.name}: Not detected`, enabled: false };
      }
      if (tool.hasHook) {
        return { label: `${tool.name}: Installed ✓`, enabled: false };
      }
      return {
        label: `${tool.name}: Install...`,
        click: () => {
          const token = this.wsClient ? this.wsClient.getToken() : null;
          this.hookInstaller.installByFlag(tool.flag, token).then(() => this.updateMenu());
        }
      };
    });
  }

  /**
   * Version/update row shown near the bottom of the tray menu. Reflects the
   * current UpdateChecker state — a plain version label normally, or a
   * clickable one-click upgrade action while an update is available.
   */
  buildUpdateMenuItems() {
    const { status, version } = this.updateChecker ? this.updateChecker.getState() : {};

    if (status === 'available') {
      return [{
        label: `⬆ Update to v${version}`,
        click: () => this.updateChecker.downloadAndInstall(version)
      }];
    }
    if (status === 'downloading') {
      return [{ label: `Downloading v${version}…`, enabled: false }];
    }
    if (status === 'downloaded') {
      return [{
        label: `Restart to install v${version}`,
        click: () => this.updateChecker.installDownloaded()
      }];
    }
    return [{ label: `Version: ${this.app.getVersion()}`, enabled: false }];
  }

  /**
   * Menu items specific to the current app mode — Window Mode's per-project
   * window management, Character Mode's speech bubble settings, or nothing
   * extra for Input Mode (which has no windows or bubble to configure).
   * @param {'character'|'window'|'input'} appMode
   * @param {number} windowCount
   * @returns {Array}
   */
  buildModeSection(appMode, windowCount) {
    if (appMode === 'window') {
      return [
        {
          label: 'Windows',
          submenu: this.buildWindowsSubmenu()
        },
        {
          label: 'Rearrange',
          enabled: windowCount > 1 && this.windowManager.isMultiMode(),
          click: () => {
            this.windowManager.arrangeWindowsByName();
          }
        },
        { type: 'separator' },
        {
          label: 'Always on Top',
          submenu: this.buildAlwaysOnTopSubmenu()
        },
        {
          label: 'Multi-Window Mode',
          type: 'checkbox',
          checked: this.windowManager.isMultiMode(),
          click: () => {
            const newMode = this.windowManager.isMultiMode() ? 'single' : 'multi';
            this.windowManager.setWindowMode(newMode);
            this.updateMenu();
          }
        },
        ...(this.windowManager.isMultiMode() ? [] : [{
          label: 'Project Lock',
          submenu: this.buildProjectLockSubmenu()
        }])
      ];
    }

    if (appMode === 'character') {
      return [
        {
          label: 'Always on Top',
          submenu: this.buildAlwaysOnTopSubmenu()
        },
        {
          label: 'Speech Bubble',
          submenu: this.buildSpeechBubbleSubmenu()
        }
      ];
    }

    // Input Mode shows nothing, so there's no window/bubble setting to expose.
    return [];
  }

  buildMenuTemplate() {
    const appMode = this.windowManager.getAppMode();
    const projectIds = this.windowManager.getProjectIds();
    const windowCount = projectIds.length;
    const state = this.getFirstWindowState();

    // Build status display based on app mode and window count
    let statusLabel;
    if (appMode === 'input') {
      const trackedCount = Object.keys(this.windowManager.getRegisteredStates()).length;
      statusLabel = trackedCount === 0
        ? 'Input Mode: no projects tracked yet'
        : `Input Mode: ${trackedCount} project(s) tracked`;
    } else if (windowCount === 0) {
      statusLabel = appMode === 'character' ? 'Character Mode: waiting for status' : 'No active windows';
    } else if (windowCount === 1) {
      statusLabel = `${state.project || 'Unknown'}: ${state.state}`;
    } else {
      statusLabel = `${windowCount} windows active`;
    }

    return [
      {
        label: statusLabel,
        enabled: false
      },
      { type: 'separator' },
      ...(this.settingsWindowManager ? [{
        label: 'Settings...',
        click: () => this.settingsWindowManager.open()
      }, { type: 'separator' }] : []),
      // VibeMon — mirrors the Settings window's VibeMon tab
      {
        label: 'App Mode',
        submenu: this.buildAppModeSubmenu()
      },
      {
        label: 'Character Lock',
        submenu: this.buildCharacterLockSubmenu()
      },
      ...this.buildModeSection(appMode, windowCount),
      {
        label: 'Open at Login',
        type: 'checkbox',
        checked: this.app.getLoginItemSettings().openAtLogin,
        click: () => {
          const current = this.app.getLoginItemSettings().openAtLogin;
          this.app.setLoginItemSettings({ openAtLogin: !current });
          this.updateMenu();
        }
      },
      { type: 'separator' },
      // Collector — mirrors the Settings window's Collector tab
      ...this.buildWebSocketStatusMenu(),
      {
        label: `HTTP Server: localhost:${HTTP_PORT}`,
        enabled: false
      },
      { type: 'separator' },
      // AI Tools — mirrors the Settings window's AI Tools tab
      {
        label: 'AI Tool Hooks',
        submenu: this.buildHookInstallerSubmenu()
      },
      { type: 'separator' },
      // Extras with no Settings tab equivalent
      {
        label: 'Claude Stats',
        enabled: fs.existsSync(STATS_CACHE_PATH),
        click: () => this.openStatsWindow()
      },
      { type: 'separator' },
      // About — opens the Settings window's About tab
      ...(this.settingsWindowManager ? [{
        label: 'About',
        click: () => this.settingsWindowManager.open('about')
      }] : []),
      ...this.buildUpdateMenuItems(),
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          this.app.quit();
        }
      }
    ];
  }

  updateMenu() {
    if (!this.tray) return;
    const contextMenu = Menu.buildFromTemplate(this.buildMenuTemplate());
    this.tray.setContextMenu(contextMenu);
  }

  showContextMenu(sender) {
    const contextMenu = Menu.buildFromTemplate(this.buildMenuTemplate());
    const win = BrowserWindow.fromWebContents(sender);
    if (win && !win.isDestroyed()) {
      contextMenu.popup({ window: win });
    } else {
      // Fallback: popup without specific window
      contextMenu.popup();
    }
  }

  /**
   * Cleanup resources on app quit
   */
  cleanup() {
    // Clear tray icon cache to free memory
    trayIconCache.clear();
    if (this.statsWindow && !this.statsWindow.isDestroyed()) {
      this.statsWindow.close();
      this.statsWindow = null;
    }
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = { TrayManager, createTrayIcon };
