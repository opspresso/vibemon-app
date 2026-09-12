const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../src/native/dock-bounds.jxa'), 'utf8');

function query({ rect, missingSymbol = false, windows = [] } = {}) {
  const list = jest.fn(() => windows);
  const bind = jest.fn(() => { if (missingSymbol) throw new Error('Symbol unavailable'); });
  const context = {
    ObjC: { import: () => {}, bindFunction: bind, deepUnwrap: value => value, castRefToObject: value => value },
    $: {
      NSMutableData: { dataWithLength: () => ({ bytes: {}, mutableBytes: {} }) },
      NSValue: { valueWithBytesObjCType: () => ({ rectValue: rect }) },
      CoreDockGetRect: jest.fn(),
      CGWindowListCopyWindowInfo: list,
      kCGWindowListOptionOnScreenOnly: 1,
      kCGNullWindowID: 0
    }
  };
  vm.createContext(context);
  const bounds = JSON.parse(vm.runInContext(script + '\nrun();', context));
  return { bounds, list, bind };
}

test('reads the actual Dock rectangle without relying on compositor window bounds', () => {
  const { bounds, list, bind } = query({ rect: { origin: { x: 319, y: 844 }, size: { width: 801, height: 56 } } });
  expect(bounds).toEqual([{ x: 319, y: 844, width: 801, height: 56 }]);
  expect(list).not.toHaveBeenCalled();
  expect(bind).toHaveBeenCalledWith('CoreDockGetRect', ['void', ['void *']]);
});

test('falls back to public geometry when the private symbol is unavailable', () => {
  const windows = [
    { kCGWindowOwnerName: 'Dock', kCGWindowLayer: 20, kCGWindowBounds: { X: 300, Y: 800, Width: 840, Height: 100 }, kCGWindowName: 'Unused title' },
    { kCGWindowOwnerName: 'Other app', kCGWindowLayer: 20, kCGWindowBounds: { X: 10, Y: 10, Width: 500, Height: 300 } },
    { kCGWindowOwnerName: 'Dock', kCGWindowLayer: -1, kCGWindowBounds: { X: 0, Y: 0, Width: 1440, Height: 900 } }
  ];
  const { bounds, list } = query({ missingSymbol: true, windows });
  expect(bounds).toEqual([{ x: 300, y: 800, width: 840, height: 100 }]);
  expect(list).toHaveBeenCalledWith(1, 0);
});

test.each([0, -1, Infinity, NaN])('does not trust an invalid private rectangle with width %s', width => {
  const { bounds, list } = query({ rect: { origin: { x: 0, y: 0 }, size: { width, height: 56 } } });
  expect(bounds).toEqual([]);
  expect(list).toHaveBeenCalledTimes(1);
});

test('handles an unavailable WindowServer without returning stale geometry', () => {
  expect(query({ missingSymbol: true, windows: null }).bounds).toEqual([]);
});
