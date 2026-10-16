/**
 * Shared BrowserWindow positioning helpers.
 */

const { screen } = require('electron');

// The level of an always-on-top overlay. The character and its speech bubble
// share it so they stack together. macOS: 'floating' keeps the tray menu
// above the overlays. Windows/Linux: 'screen-saver' keeps them visible in WSL.
const ALWAYS_ON_TOP_LEVEL = process.platform === 'darwin' ? 'floating' : 'screen-saver';

/**
 * Center the window on the display the cursor is on, clamped to its work
 * area — tray-opened windows would otherwise always open on the primary
 * display.
 * @param {Electron.BrowserWindow} window
 */
function centerOnCursorDisplay(window) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { workArea } = display;

  const bounds = window.getBounds();
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  const x = workArea.x + Math.round((workArea.width - width) / 2);
  const y = workArea.y + Math.round((workArea.height - height) / 2);

  window.setBounds({ x, y, width, height });
}

module.exports = { ALWAYS_ON_TOP_LEVEL, centerOnCursorDisplay };
