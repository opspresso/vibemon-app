jest.mock('electron', () => ({ screen: { getCursorScreenPoint: jest.fn() } }));
const { EventEmitter } = require('node:events');
const { screen } = require('electron');
const { trackWindowPointer } = require('../src/modules/window-pointer.cjs');
const { WINDOW_POINTER_POLL_MS, WINDOW_POINTER_IDLE_POLL_MS, WINDOW_POINTER_RESEND_MS } = require('../src/shared/config.cjs');

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function visibleWindow() {
  const window = new EventEmitter();
  Object.assign(window, {
    isDestroyed: () => false, isVisible: () => true,
    getContentBounds: () => ({ x: -1000, y: 200, width: 134, height: 138 }),
    webContents: { isDestroyed: () => false, getZoomFactor: () => 1, send: jest.fn() }
  });
  return window;
}

test('DIP cursor positions map to content coordinates without applying display scale again', () => {
  const window = visibleWindow();
  screen.getCursorScreenPoint.mockReturnValue({ x: -950, y: 260 });
  trackWindowPointer(window);
  expect(window.webContents.send).toHaveBeenLastCalledWith('window-pointer', { x: 50, y: 60 });
  screen.getCursorScreenPoint.mockReturnValue({ x: 0, y: 0 });
  jest.advanceTimersByTime(WINDOW_POINTER_POLL_MS);
  expect(window.webContents.send).toHaveBeenLastCalledWith('window-pointer', null);
  window.emit('closed');
  const sent = window.webContents.send.mock.calls.length;
  screen.getCursorScreenPoint.mockReturnValue({ x: -950, y: 260 });
  jest.advanceTimersByTime(WINDOW_POINTER_IDLE_POLL_MS);
  expect(window.webContents.send).toHaveBeenCalledTimes(sent);
});

test('a stationary pointer is sent once, then again only at the resend interval', () => {
  const window = visibleWindow();
  screen.getCursorScreenPoint.mockReturnValue({ x: -950, y: 260 });
  trackWindowPointer(window);
  jest.advanceTimersByTime(WINDOW_POINTER_RESEND_MS - WINDOW_POINTER_POLL_MS);
  expect(window.webContents.send).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(WINDOW_POINTER_POLL_MS * 2);
  expect(window.webContents.send).toHaveBeenCalledTimes(2);
  screen.getCursorScreenPoint.mockReturnValue({ x: -949, y: 260 });
  jest.advanceTimersByTime(WINDOW_POINTER_POLL_MS);
  expect(window.webContents.send).toHaveBeenCalledTimes(3);
  expect(window.webContents.send).toHaveBeenLastCalledWith('window-pointer', { x: 51, y: 60 });
  window.emit('closed');
});

test('outside the window, the cursor is polled at the idle rate and nothing is sent', () => {
  const window = visibleWindow();
  screen.getCursorScreenPoint.mockClear().mockReturnValue({ x: 0, y: 0 });
  trackWindowPointer(window);
  jest.advanceTimersByTime(WINDOW_POINTER_IDLE_POLL_MS * 3);
  expect(screen.getCursorScreenPoint).toHaveBeenCalledTimes(4);
  expect(window.webContents.send).not.toHaveBeenCalled();
  window.emit('closed');
});

test('hidden windows are not polled for cursor position', () => {
  const window = new EventEmitter();
  Object.assign(window, { isDestroyed: () => false, isVisible: () => false });
  screen.getCursorScreenPoint.mockClear();
  trackWindowPointer(window);
  jest.advanceTimersByTime(WINDOW_POINTER_IDLE_POLL_MS);
  expect(screen.getCursorScreenPoint).not.toHaveBeenCalled();
  window.emit('closed');
});
