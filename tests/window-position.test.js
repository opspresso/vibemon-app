/**
 * Tests for window-position.cjs
 */

jest.mock('electron', () => ({
  screen: {
    getCursorScreenPoint: jest.fn(),
    getDisplayNearestPoint: jest.fn()
  }
}));

const { screen } = require('electron');
const { centerOnCursorDisplay } = require('../src/modules/window-position.cjs');

function makeWindow(bounds) {
  return {
    getBounds: () => bounds,
    setBounds: jest.fn()
  };
}

beforeEach(() => {
  screen.getCursorScreenPoint.mockReset().mockReturnValue({ x: 10, y: 10 });
  screen.getDisplayNearestPoint.mockReset();
});

describe('centerOnCursorDisplay', () => {
  test('centers the window inside the cursor display work area', () => {
    screen.getDisplayNearestPoint.mockReturnValue({
      workArea: { x: 0, y: 25, width: 1920, height: 1055 }
    });
    const window = makeWindow({ x: 0, y: 0, width: 600, height: 400 });

    centerOnCursorDisplay(window);

    expect(window.setBounds).toHaveBeenCalledWith({
      x: 660,
      y: 353,
      width: 600,
      height: 400
    });
  });

  test('uses the display the cursor is on, including negative-origin displays', () => {
    screen.getCursorScreenPoint.mockReturnValue({ x: -500, y: -300 });
    screen.getDisplayNearestPoint.mockReturnValue({
      workArea: { x: -1600, y: -900, width: 1600, height: 900 }
    });
    const window = makeWindow({ x: 0, y: 0, width: 400, height: 300 });

    centerOnCursorDisplay(window);

    expect(screen.getDisplayNearestPoint).toHaveBeenCalledWith({ x: -500, y: -300 });
    expect(window.setBounds).toHaveBeenCalledWith({
      x: -1000,
      y: -600,
      width: 400,
      height: 300
    });
  });

  test('clamps the window size to the work area when it is larger', () => {
    screen.getDisplayNearestPoint.mockReturnValue({
      workArea: { x: 100, y: 50, width: 800, height: 600 }
    });
    const window = makeWindow({ x: 0, y: 0, width: 1000, height: 900 });

    centerOnCursorDisplay(window);

    expect(window.setBounds).toHaveBeenCalledWith({
      x: 100,
      y: 50,
      width: 800,
      height: 600
    });
  });
});
