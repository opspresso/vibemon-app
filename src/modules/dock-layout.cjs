const { SNAP_THRESHOLD, DOCK_EDGE_TOLERANCE, DOCK_OVERLAY_GAP } = require('../shared/constants.cjs');

function isRectangle(rect) {
  return rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) &&
    rect.width > 0 && rect.height > 0;
}

// Quartz and Electron both use points with the main display's top-left as
// their origin on macOS. Do not multiply Retina coordinates by scaleFactor.
function dockCorner(display, dock, window, margin = 0, autoScale = true) {
  if (!isRectangle(display?.bounds) || !isRectangle(dock) || !isRectangle(window)) return null;
  const bounds = display.bounds;
  const work = display.workArea;
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  const dockRight = dock.x + dock.width;
  const dockBottom = dock.y + dock.height;
  // Ignore wallpaper, Mission Control surfaces, hidden Docks, and other displays.
  if (dock.width >= bounds.width || dock.height >= bounds.height ||
      dock.x < bounds.x || dockRight > right || dock.y < bounds.y || dockBottom > bottom ||
      dock.width <= DOCK_EDGE_TOLERANCE || dock.height <= DOCK_EDGE_TOLERANCE) return null;

  const atLeft = window.x <= Math.max(bounds.x, work.x) + margin + SNAP_THRESHOLD;
  const atRight = window.x + window.width >= Math.min(right, work.x + work.width) - margin - SNAP_THRESHOLD;
  const atBottom = window.y + window.height >= work.y + work.height - margin - SNAP_THRESHOLD;
  if (!atBottom || (!atLeft && !atRight)) return null;
  const side = atLeft ? 'left' : 'right';
  let area;
  let axis;
  if (dock.width > dock.height && bottom - dockBottom <= DOCK_EDGE_TOLERANCE) {
    const top = Math.min(dock.y, work.y + work.height);
    area = side === 'left'
      ? { x: bounds.x, y: top, width: dock.x - bounds.x, height: bottom - top }
      : { x: dockRight, y: top, width: right - dockRight, height: bottom - top };
    axis = 'horizontal';
  } else if (dock.height > dock.width &&
      ((side === 'left' && dock.x - bounds.x <= DOCK_EDGE_TOLERANCE) ||
       (side === 'right' && right - dockRight <= DOCK_EDGE_TOLERANCE))) {
    const left = side === 'left' ? bounds.x : Math.min(dock.x, work.x + work.width);
    const edge = side === 'left' ? Math.max(dockRight, work.x) : right;
    area = { x: left, y: dockBottom, width: edge - left, height: bottom - dockBottom };
    axis = 'vertical';
  } else {
    return null;
  }
  // Keeping size can use the whole free column beside a bottom Dock, or
  // the whole free row below a side Dock, rather than its narrow strip.
  if (!autoScale) {
    area = axis === 'horizontal'
      ? { ...area, y: work.y, height: bottom - work.y }
      : { ...area, x: bounds.x, width: bounds.width };
  }
  const inset = {
    x: Math.ceil(area.x + margin), y: Math.ceil(area.y + margin),
    width: Math.floor(area.width - margin * 2), height: Math.floor(area.height - margin * 2)
  };
  return isRectangle(inset) ? { area: inset, side, axis, displayId: display.id } : null;
}

// Both overlays share one scale, and their complete windows (including the
// tail padding) fit in the same free rectangle without intersecting the Dock.
function fitDockLayout(corner, character, bubble = null, autoScale = true) {
  if (!corner || !isRectangle({ x: 0, y: 0, ...character }) ||
      (bubble && !isRectangle({ x: 0, y: 0, ...bubble }))) return null;
  const { area, side } = corner;
  let { axis } = corner;
  const gap = bubble ? DOCK_OVERLAY_GAP : 0;
  if (!autoScale) {
    const fits = direction => {
      const width = bubble ? (direction === 'horizontal' ? character.width + gap + bubble.width : Math.max(character.width, bubble.width)) : character.width;
      const height = bubble ? (direction === 'horizontal' ? Math.max(character.height, bubble.height) : character.height + gap + bubble.height) : character.height;
      return width <= area.width && height <= area.height;
    };
    if (!fits(axis)) axis = axis === 'horizontal' ? 'vertical' : 'horizontal';
    if (!fits(axis)) return null;
  }
  const horizontal = axis === 'horizontal';
  const totalWidth = bubble ? (horizontal ? character.width + bubble.width : Math.max(character.width, bubble.width)) : character.width;
  const totalHeight = bubble ? (horizontal ? Math.max(character.height, bubble.height) : character.height + bubble.height) : character.height;
  // Reserve one rounding pixel per overlay before rounding native bounds up.
  const rounding = bubble ? 2 : 1;
  const scale = autoScale ? Math.min(1,
    (area.width - (horizontal ? gap : 0) - rounding) / totalWidth,
    (area.height - (horizontal ? 0 : gap) - rounding) / totalHeight) : 1;
  if (scale <= 0) return null;
  const size = input => ({ width: Math.ceil(input.width * scale), height: Math.ceil(input.height * scale) });
  const charSize = size(character);
  const charBounds = {
    x: side === 'left' ? area.x : area.x + area.width - charSize.width,
    y: area.y + area.height - charSize.height, ...charSize
  };
  if (!bubble) return { ...corner, axis, scale, character: charBounds, bubble: null };
  const bubbleSize = size(bubble);
  const bubbleBounds = {
    x: horizontal
      ? (side === 'left' ? charBounds.x + charSize.width + gap : charBounds.x - gap - bubbleSize.width)
      : (side === 'left' ? area.x : area.x + area.width - bubbleSize.width),
    y: horizontal ? area.y + area.height - bubbleSize.height : charBounds.y - gap - bubbleSize.height,
    ...bubbleSize
  };
  const tailSide = horizontal ? (side === 'left' ? 'left' : 'right') : 'bottom';
  const offset = horizontal
    ? (charBounds.y + charSize.height / 2 - bubbleBounds.y) / scale - 6
    : (charBounds.x + charSize.width / 2 - bubbleBounds.x) / scale - 6;
  const extent = horizontal ? bubble.height : bubble.width;
  return { ...corner, axis, scale, character: charBounds, bubble: { ...bubbleBounds, tailSide, tailOffset: Math.max(12, Math.min(extent - 24, offset)) } };
}

module.exports = { dockCorner, fitDockLayout, isRectangle };
