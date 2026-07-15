/**
 * System tray management for VibeMon
 */

const { Tray, Menu, nativeImage, BrowserWindow } = require('electron');
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');
const {
  STATE_COLORS, CHARACTER_CONFIG, DEFAULT_CHARACTER,
  HTTP_PORT, ALWAYS_ON_TOP_MODES,
  CHARACTER_NAMES, TRAY_ICON_SIZE,
  SPEECH_BUBBLE_FIELDS
} = require('../shared/config.cjs');

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

// Character sprite PNGs (128x128), loaded once and downscaled onto the tray
// icon — the icon is derived from the same registry image as the character
// window, so new characters need no tray-specific artwork.
const characterImageCache = new Map(); // name -> Promise<Image|null>

function getCharacterImage(name) {
  if (!characterImageCache.has(name)) {
    const config = CHARACTER_CONFIG[name];
    const imagePath = path.join(__dirname, '..', 'assets', 'characters', config.image);
    characterImageCache.set(
      name,
      // Read through Electron's asar-aware fs and hand loadImage a Buffer:
      // node-canvas reads path arguments with its own native I/O, which
      // cannot see inside app.asar in packaged builds.
      fs.promises.readFile(imagePath)
        .then((buffer) => loadImage(buffer))
        .catch((err) => {
          console.warn(`Failed to load tray character image ${config.image}:`, err.message);
          return null;
        })
    );
  }
  return characterImageCache.get(name);
}

/**
 * Draw the tray icon canvas: state-colored rounded background, optionally
 * the character sprite (nearest-neighbor downscale), and the update badge.
 * @param {string} state
 * @param {import('canvas').Image|null} characterImage
 * @param {boolean} hasUpdate
 * @returns {Electron.NativeImage}
 */
function drawTrayIcon(state, characterImage, hasUpdate) {
  const size = TRAY_ICON_SIZE;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  const bgColor = STATE_COLORS[state] || STATE_COLORS.idle;

  // Clear canvas (transparent)
  ctx.clearRect(0, 0, size, size);

  // Draw rounded background
  const radius = 4;
  ctx.fillStyle = bgColor;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, radius);
  ctx.fill();

  if (characterImage) {
    // Nearest-neighbor keeps the pixel-art look at tray size.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(characterImage, 1, 1, size - 2, size - 2);
  }

  if (hasUpdate) {
    // Small badge in the top-right corner signaling an update is available.
    ctx.fillStyle = '#FF6633';
    ctx.beginPath();
    ctx.arc(size - 5, 5, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  return nativeImage.createFromBuffer(canvas.toBuffer('image/png'));
}

/**
 * Create tray icon with state-based background color and the character's
 * registry sprite.
 * @returns {Promise<Electron.NativeImage>}
 */
async function createTrayIcon(state, character = DEFAULT_CHARACTER, hasUpdate = false) {
  const name = CHARACTER_CONFIG[character] ? character : DEFAULT_CHARACTER;
  const cacheKey = `${state}-${name}-${hasUpdate}`;

  // Return cached icon if available
  if (trayIconCache.has(cacheKey)) {
    return trayIconCache.get(cacheKey);
  }

  const characterImage = await getCharacterImage(name);
  const icon = drawTrayIcon(state, characterImage, hasUpdate);

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

  /**
   * Get the followed project's state or a default
   * @returns {Object}
   */
  getFocusedState() {
    const projectIds = this.windowManager.getProjectIds();
    if (projectIds.length === 0) {
      return { state: 'idle', character: DEFAULT_CHARACTER, project: null };
    }
    const projectId = projectIds[0];
    const state = this.windowManager.getState(projectId);
    return state || { state: 'idle', character: DEFAULT_CHARACTER, project: projectId };
  }

  /**
   * Whether an update is available/downloading/downloaded, for the tray icon badge.
   * @returns {boolean}
   */
  hasUpdateAvailable() {
    return Boolean(this.updateChecker && this.updateChecker.getState().status !== null);
  }

  createTray() {
    const state = this.getFocusedState();
    // Start with a synchronous background-only icon; the character sprite
    // is drawn in as soon as its image finishes loading (updateIcon below).
    this.tray = new Tray(drawTrayIcon(state.state, null, this.hasUpdateAvailable()));
    this.tray.setToolTip('VibeMon');
    this.updateMenu();
    this.updateIcon();

    // Left-click to show menu (Windows support)
    this.tray.on('click', () => {
      this.tray.popUpContextMenu();
    });

    return this.tray;
  }

  updateIcon() {
    if (!this.tray) return;
    const state = this.getFocusedState();
    createTrayIcon(state.state, state.character, this.hasUpdateAvailable()).then((icon) => {
      // The tray can be destroyed while the character image is loading.
      if (this.tray) this.tray.setImage(icon);
    });
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
        label: CHARACTER_CONFIG[c].displayName,
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
      case 'disconnected': {
        statusIcon = '○';
        const lastError = this.wsClient.getLastError();
        statusLabel = lastError
          ? `WebSocket: Disconnected (${lastError})`
          : 'WebSocket: Disconnected';
        break;
      }
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

  buildMenuTemplate() {
    const state = this.getFocusedState();

    const statusLabel = state.project
      ? `${state.project}: ${state.state}`
      : 'Waiting for status';

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
        label: 'Character Lock',
        submenu: this.buildCharacterLockSubmenu()
      },
      {
        label: 'Always on Top',
        submenu: this.buildAlwaysOnTopSubmenu()
      },
      {
        label: 'Speech Bubble',
        submenu: this.buildSpeechBubbleSubmenu()
      },
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
    // Clear icon caches to free memory
    trayIconCache.clear();
    characterImageCache.clear();
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = { TrayManager, createTrayIcon };
