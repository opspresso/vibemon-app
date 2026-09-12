const { dockCorner } = require('../../src/modules/dock-layout.cjs');

function getDockCandidates(display, docks, size) {
  const { bounds } = display;
  return ['left', 'right'].map(side => ({
    side,
    bounds: {
      x: side === 'left' ? bounds.x : bounds.x + bounds.width - size.width,
      y: bounds.y + bounds.height - size.height,
      ...size
    }
  })).filter(candidate => docks.some(dock => dockCorner(display, dock, candidate.bounds)?.side === candidate.side));
}

module.exports = { getDockCandidates };
