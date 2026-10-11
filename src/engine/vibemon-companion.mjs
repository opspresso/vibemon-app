// One 64-unit drawing defines the logo, 128px sprite, and 3D silhouette.
// Eye bounds are top-left rectangles, matching the character registry contract.
export const COMPANION_SIZE = 64;
export const COMPANION_OUTLINE = [
  ['M', 8, 7],
  ['C', 5, 5, 2, 7, 3, 11],
  ['L', 9, 38],
  ['C', 12, 51, 21, 59, 32, 59],
  ['C', 43, 59, 52, 51, 55, 38],
  ['L', 61, 11],
  ['C', 62, 7, 59, 5, 56, 7],
  ['L', 35, 23],
  ['C', 33, 24.5, 31, 24.5, 29, 23],
  ['Z']
];
export const COMPANION_EYES = {
  left: { x: 19.5, y: 30, w: 7, h: 12 },
  right: { x: 37.5, y: 30, w: 7, h: 12 }
};

export const companionBodyPath = () => COMPANION_OUTLINE.map(command => command.join(' ')).join(' ');
export const companionEyePath = () => Object.values(COMPANION_EYES).map(({ x, y, w, h }) => {
  const r = w / 2;
  return `M${x + r} ${y}a${r} ${r} 0 0 1 ${r} ${r}v${h - w}a${r} ${r} 0 0 1-${w} 0v-${h - w}a${r} ${r} 0 0 1 ${r}-${r}Z`;
}).join(' ');
