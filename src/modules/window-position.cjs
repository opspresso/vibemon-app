/**
 * Shared BrowserWindow positioning helpers.
 */

const { screen } = require('electron');

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

module.exports = { centerOnCursorDisplay };
