/**
 * Invariants between values in src/shared/data/constants.json. Each check
 * guards a relationship that code relies on, not a specific number.
 */

const constants = require('../src/shared/constants.cjs');

test('state timeouts escalate from idle to sleep to closing the window', () => {
  expect(constants.IDLE_TIMEOUT_MS).toBeGreaterThan(0);
  expect(constants.SLEEP_TIMEOUT_MS).toBeGreaterThan(constants.IDLE_TIMEOUT_MS);
  expect(constants.WINDOW_CLOSE_TIMEOUT_MS).toBeGreaterThan(constants.SLEEP_TIMEOUT_MS);
});

test('a usage refresh accepts only a cache younger than its own interval', () => {
  expect(constants.USAGE_REFRESH_MAX_AGE_SECONDS * 1000).toBeLessThan(constants.USAGE_REFRESH_INTERVAL_MS);
});

test('the local server listens on a valid port with a positive body limit', () => {
  expect(Number.isInteger(constants.HTTP_PORT) && constants.HTTP_PORT > 0 && constants.HTTP_PORT < 65536).toBe(true);
  expect(constants.MAX_PAYLOAD_SIZE).toBeGreaterThan(0);
});

test('always-on-top offers every mode the settings screen lists', () => {
  expect(Object.keys(constants.ALWAYS_ON_TOP_MODES).sort()).toEqual(['active-only', 'all', 'disabled']);
});

test('character sizes run from 100% down to 30%, largest first', () => {
  expect(constants.CHARACTER_SCALES[0]).toBe(100);
  expect(constants.CHARACTER_SCALES.at(-1)).toBe(30);
  expect([...constants.CHARACTER_SCALES].sort((a, b) => b - a)).toEqual(constants.CHARACTER_SCALES);
});

test('edge margins start flush with the edge and only grow', () => {
  expect(constants.EDGE_MARGINS[0]).toBe(0);
  expect([...constants.EDGE_MARGINS].sort((a, b) => a - b)).toEqual(constants.EDGE_MARGINS);
});

test('the character window fits the sprite plus its floating clearance', () => {
  // 5px is FLOAT_AMPLITUDE_Y in vibemon-engine.js; .vibemon-display in styles.css uses the same height.
  expect(constants.WINDOW_HEIGHT).toBe(constants.CHAR_Y_BASE + constants.CHAR_SIZE + 5);
});
