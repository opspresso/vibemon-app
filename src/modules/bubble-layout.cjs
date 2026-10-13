const { WINDOW_WIDTH, CHAR_Y_BASE, CHAR_SIZE } = require('../shared/constants.cjs');
const WINDOW_HEIGHT = CHAR_Y_BASE + CHAR_SIZE + 5;
const GAP = 4;
const EDGE_EPSILON = 2;
const clamp = (value, start, end) => Math.max(start, Math.min(end, value));

// Prefer a full-size bubble beside a pinned horizontal edge, otherwise above
// the character. Evaluate four rectangles once; shrink only when none fits.
function placeBubble(bounds, size, workArea, characterScale, margin = 0) {
  const area = { x: workArea.x + margin, y: workArea.y + margin,
    width: workArea.width - 2 * margin, height: workArea.height - 2 * margin };
  if (!(area.width > 0 && area.height > 0 && size.width > 0 && size.height > 0 && characterScale > 0)) return null;
  const character = { x: bounds.x, y: bounds.y, width: WINDOW_WIDTH * characterScale, height: WINDOW_HEIGHT * characterScale };
  const cx = character.x + character.width / 2, cy = character.y + character.height / 2;
  const right = area.x + area.width, bottom = area.y + area.height;
  const horizontal = cx > area.x + area.width / 2 ? ['left', 'right'] : ['right', 'left'];
  const pinned = character.y <= area.y + EDGE_EPSILON || character.y + character.height >= bottom - EDGE_EPSILON;
  const order = pinned ? [...horizontal, 'above', 'below'] : ['above', 'below', ...horizontal];
  const available = {
    above: { width: area.width, height: character.y - GAP - area.y },
    below: { width: area.width, height: bottom - character.y - character.height - GAP },
    left: { width: character.x - GAP - area.x, height: area.height },
    right: { width: right - character.x - character.width - GAP, height: area.height }
  };
  let best = null;
  for (const side of order) {
    const room = available[side];
    const scale = Math.min(1, Math.floor(room.width) / size.width, Math.floor(room.height) / size.height);
    if (scale <= 0 || (best && scale <= best.scale)) continue;
    best = { side, scale, width: Math.min(Math.floor(room.width), Math.ceil(size.width * scale)), height: Math.min(Math.floor(room.height), Math.ceil(size.height * scale)) };
    if (scale === 1) break;
  }
  if (!best) return null;
  const { side, scale, width, height } = best;
  let x = cx - width / 2, y = cy - height / 2;
  if (side === 'above') y = character.y - GAP - height;
  if (side === 'below') y = character.y + character.height + GAP;
  if (side === 'left') x = character.x - GAP - width;
  if (side === 'right') x = character.x + character.width + GAP;
  x = Math.round(clamp(x, area.x, right - width));
  y = Math.round(clamp(y, area.y, bottom - height));
  const vertical = side === 'above' || side === 'below';
  const tailOffset = clamp(Math.round((vertical ? cx - x : cy - y) / scale - 6), 12, (vertical ? size.width : size.height) - 24);
  return { x, y, width, height, scale, tailSide: { above: 'bottom', below: 'top', left: 'right', right: 'left' }[side], tailOffset };
}

module.exports = { placeBubble };
