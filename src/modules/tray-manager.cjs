/**
 * System tray management for VibeMon
 */

const { Tray, Menu, nativeImage, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { STATE_COLORS, CHARACTER_CONFIG, DEFAULT_CHARACTER, TRAY_ICON_SIZE } = require('../shared/config.cjs');
const { trayIconBitmap, dotBitmap } = require('./tray-icon.cjs');
const { t } = require('../shared/i18n/locale.cjs');

// The tray badge and menu dots share one attention color.
const ATTENTION_COLOR = '#FF6633';

// Tray icon cache for performance
const trayIconCache = new Map();

// Character sprite PNGs, decoded once and downscaled onto the tray
// icon — the icon is derived from the same registry image as the character
// window, so new characters need no tray-specific artwork.
const characterImageCache = new Map(); // name -> Promise<{width, height, data}|null>

function getCharacterImage(name) {
  if (!characterImageCache.has(name)) {
    const config = CHARACTER_CONFIG[name];
    const imagePath = path.join(__dirname, '..', 'assets', 'characters', config.image);
    characterImageCache.set(
      name,
      // Electron's fs reads inside app.asar in packaged builds.
      fs.promises.readFile(imagePath)
        .then((buffer) => {
          const image = nativeImage.createFromBuffer(buffer);
          if (image.isEmpty()) throw new Error('not a decodable PNG');
          return { ...image.getSize(), data: image.toBitmap() };
        })
        .catch((err) => {
          console.warn(`Failed to load tray character image ${config.image}:`, err.message);
          return null;
        })
    );
  }
  return characterImageCache.get(name);
}

/**
 * Draw the tray icon: state-colored rounded background, optionally the
 * character sprite, and the attention badge.
 * @param {string} state
 * @param {{width: number, height: number, data: Buffer}|null} sprite
 * @param {boolean} showBadge
 * @returns {Electron.NativeImage}
 */
function drawTrayIcon(state, sprite, showBadge) {
  // Drawn at 2x so Retina menu bars show the sprite without upscaling.
  const scale = 2, pixels = TRAY_ICON_SIZE * scale;
  const bitmap = trayIconBitmap(TRAY_ICON_SIZE, STATE_COLORS[state] || STATE_COLORS.idle, sprite, showBadge ? ATTENTION_COLOR : null, scale);
  return nativeImage.createFromBitmap(bitmap, { width: pixels, height: pixels, scaleFactor: scale });
}

let attentionDotImage = null;
/**
 * The red dot beside a menu item whose page has an issue: the same color as
 * the tray icon's badge, drawn at 2x for Retina menus.
 */
function attentionDot() {
  attentionDotImage ??= nativeImage.createFromBitmap(dotBitmap(32, ATTENTION_COLOR), { width: 32, height: 32, scaleFactor: 2 });
  return attentionDotImage;
}

/**
 * Create tray icon with state-based background color and the character's
 * registry sprite.
 * @returns {Promise<Electron.NativeImage>}
 */
async function createTrayIcon(state, character = DEFAULT_CHARACTER, showBadge = false) {
  const name = Object.hasOwn(CHARACTER_CONFIG, character) ? character : DEFAULT_CHARACTER;
  const cacheKey = `${state}-${name}-${showBadge}`;

  // Return cached icon if available
  if (trayIconCache.has(cacheKey)) {
    return trayIconCache.get(cacheKey);
  }

  const icon = drawTrayIcon(state, await getCharacterImage(name), showBadge);

  trayIconCache.set(cacheKey, icon);
  return icon;
}

class TrayManager {
  constructor(windowManager, app) {
    this.tray = null;
    this.windowManager = windowManager;
    this.app = app;
    this.contextMenu = null;
    this.menuKey = null;
    // One notice per area that needs the user (see shared/attention.cjs).
    this.notices = { dashboard: null, connection: null, integrations: null, update: null };
    this.iconGeneration = 0;
    this.iconKey = null;
    this.tooltip = null;
    this.openSettings = null;
    this.showCharacterHandler = null;
    this.openDashboard = null;
  }

  /**
   * Show where issues are: the icon badge, the tooltip, and the menu items
   * that open each affected page.
   * @param {ReturnType<import('../shared/attention.cjs').attentionNotices>} notices
   */
  setAttention(notices) {
    this.notices = { ...notices };
    this.updateIcon();
    this.updateMenu();
  }

  /**
   * Set the handler that re-shows the character window after it closed
   * (sleep close-timeout or a manual close). Wired by main.js, which owns
   * the window/state/bubble orchestration.
   * @param {() => void} handler
   */
  setShowCharacterHandler(handler) {
    this.showCharacterHandler = handler;
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

  hasAttentionBadge() {
    return this.attentionReasons().length > 0;
  }

  /** Tooltip lines: each notice and the menu item that resolves it. */
  attentionReasons() {
    const { dashboard, connection, integrations, update } = this.notices;
    return [
      connection && t('tray.reason.settings', { notice: connection }),
      dashboard && t('tray.reason.dashboard', { notice: dashboard }),
      integrations && t('tray.reason.integrations', { notice: integrations }),
      update && t('tray.reason.about', { notice: update })
    ].filter(Boolean);
  }

  createTray() {
    if (typeof this.openDashboard !== 'function') throw new Error('A dashboard action is required before creating the tray');
    const state = this.getFocusedState();
    // Start with a synchronous background-only icon; the character sprite
    // is drawn in as soon as its image finishes loading (updateIcon below).
    this.tray = new Tray(drawTrayIcon(state.state, null, this.hasAttentionBadge()));
    this.updateMenu();
    this.updateIcon();

    if (process.platform === 'win32') {
      const showMenu = () => {
        this.tray.popUpContextMenu(this.contextMenu);
      };
      this.tray.on('click', showMenu);
      this.tray.on('right-click', showMenu);
    }

    return this.tray;
  }

  updateIcon() {
    if (!this.tray) return;
    const state = this.getFocusedState();
    const reasons = this.attentionReasons();
    const badge = reasons.length > 0;
    const tooltip = ['VibeMon', ...reasons].join('\n');
    if (this.tooltip !== tooltip) { this.tray.setToolTip(tooltip); this.tooltip = tooltip; }
    const key = `${state.state}:${state.character}:${badge}`;
    if (this.iconKey === key) return;
    this.iconKey = key;
    const generation = ++this.iconGeneration;
    createTrayIcon(state.state, state.character, badge).then(image => {
      if (this.tray && generation === this.iconGeneration) this.tray.setImage(image);
    });
  }

  buildMenuTemplate() {
    const { dashboard, connection, integrations, update } = this.notices;
    // An item that opens an affected page carries a red dot and the reason.
    // Only macOS draws a sublabel, so other platforms put the reason in the label.
    const flagged = (item, notice) => !notice ? item : process.platform === 'darwin'
      ? { ...item, icon: attentionDot(), sublabel: notice }
      : { ...item, icon: attentionDot(), label: t('tray.flagged', { label: item.label, notice }) };
    // Groups: identity, what you watch, how it is set up, the app itself.
    // Shortcut hints match the workspace menu; a tray menu registers none.
    return [
      { label: t('tray.version', { version: this.app.getVersion() }), enabled: false },
      { type: 'separator' },
      flagged({ label: t('nav.dashboard'), click: () => this.openDashboard?.() }, dashboard),
      { label: t('action.showCompanion'), click: () => this.showCharacterHandler?.() },
      { type: 'separator' },
      flagged({ label: t('action.settingsMenu'), accelerator: 'CmdOrCtrl+,', registerAccelerator: false, click: () => this.openSettings?.(connection ? 'connections' : 'companion') }, connection),
      flagged({ label: t('action.integrationsMenu'), click: () => this.openSettings?.('integrations') }, integrations),
      { type: 'separator' },
      flagged({ label: t('action.aboutApp'), click: () => this.openSettings?.('about') }, update),
      { label: t('action.quitApp'), accelerator: 'CmdOrCtrl+Q', registerAccelerator: false, click: () => this.app.quit() }
    ];
  }

  updateMenu() {
    // macOS handles mouse-down/tracking natively. Rebuilding a menu in a JS
    // click callback delays opening and loses clicks during double-clicks,
    // so the menu is rebuilt only when its notices change.
    const key = JSON.stringify(this.notices);
    if (!this.tray || (this.contextMenu && this.menuKey === key)) return;
    this.menuKey = key;
    this.contextMenu = Menu.buildFromTemplate(this.buildMenuTemplate());
    if (process.platform !== 'win32') this.tray.setContextMenu(this.contextMenu);
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
    this.iconGeneration++;
    this.iconKey = null;
    this.tooltip = null;
    this.contextMenu = null;
    this.menuKey = null;
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = { TrayManager, createTrayIcon };
