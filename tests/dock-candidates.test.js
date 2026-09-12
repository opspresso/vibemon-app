const { getDockCandidates } = require('./native/dock-candidates.cjs');
const size = { width: 134, height: 138 };
const display = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 30, width: 1440, height: 814 } };

describe('native Dock candidate discovery', () => {
  test('checks both bottom corners for a bottom Dock', () => {
    const candidates = getDockCandidates(display, [{ x: 400, y: 844, width: 640, height: 52 }], size);
    expect(candidates.map(({ side }) => side)).toEqual(['left', 'right']);
  });

  test.each(['left', 'right'])('only selects the usable corner beneath a %s Dock', side => {
    const sideDisplay = { ...display, workArea: { x: side === 'left' ? 60 : 0, y: 30, width: 1380, height: 870 } };
    const dock = { x: side === 'left' ? 4 : 1384, y: 250, width: 52, height: 400 };
    expect(getDockCandidates(sideDisplay, [dock], size).map(candidate => candidate.side)).toEqual([side]);
  });

  test('ignores Docks on other displays and absent Docks', () => {
    expect(getDockCandidates(display, [{ x: 1840, y: 844, width: 640, height: 52 }], size)).toEqual([]);
    expect(getDockCandidates(display, [], size)).toEqual([]);
  });
});
