const { screen } = require('electron');
const { WINDOW_POINTER_POLL_MS, WINDOW_POINTER_IDLE_POLL_MS, WINDOW_POINTER_RESEND_MS } = require('../shared/config.cjs');

const samePoint = (a, b) => a === b || (Boolean(a) && Boolean(b) && a.x === b.x && a.y === b.y);

// Native mouse forwarding can stop while a click-through window is unfocused.
// Cursor and content bounds both use DIP, including on mixed-DPI Windows displays.
// The cursor is polled every WINDOW_POINTER_POLL_MS while it is over the window
// and every WINDOW_POINTER_IDLE_POLL_MS otherwise. A position is sent when it
// changes, and one null clears hover on leaving.
function trackWindowPointer(window) {
  let sent = null;
  let sentAt = 0;
  let timer = null;
  const poll = () => {
    let inside = false;
    if (!window.isDestroyed() && window.isVisible() && !window.webContents.isDestroyed()) {
      const cursor = screen.getCursorScreenPoint();
      const bounds = window.getContentBounds();
      const x = cursor.x - bounds.x;
      const y = cursor.y - bounds.y;
      inside = x >= 0 && y >= 0 && x < bounds.width && y < bounds.height;
      const zoom = inside ? window.webContents.getZoomFactor() : 1;
      const point = inside ? { x: x / zoom, y: y / zoom } : null;
      // A renderer that subscribes late gets a stationary pointer within the resend interval.
      const resend = inside && Date.now() - sentAt >= WINDOW_POINTER_RESEND_MS;
      if (!samePoint(point, sent) || resend) {
        window.webContents.send('window-pointer', point);
        sent = point;
        sentAt = Date.now();
      }
    }
    timer = setTimeout(poll, inside ? WINDOW_POINTER_POLL_MS : WINDOW_POINTER_IDLE_POLL_MS);
    timer.unref();
  };
  poll();
  window.once('closed', () => clearTimeout(timer));
}

module.exports = { trackWindowPointer };
