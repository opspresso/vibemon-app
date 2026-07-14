/**
 * Tests for constants.cjs
 */

const constants = require('../src/shared/constants.cjs');

describe('Constants', () => {
  describe('HTTP Server', () => {
    test('HTTP_PORT is valid port number', () => {
      expect(constants.HTTP_PORT).toBe(19280);
      expect(constants.HTTP_PORT).toBeGreaterThan(0);
      expect(constants.HTTP_PORT).toBeLessThan(65536);
    });

    test('MAX_PAYLOAD_SIZE is reasonable', () => {
      expect(constants.MAX_PAYLOAD_SIZE).toBe(10 * 1024);
      expect(constants.MAX_PAYLOAD_SIZE).toBeGreaterThan(0);
    });
  });

  describe('Window Settings', () => {
    test('window width is positive', () => {
      expect(constants.WINDOW_WIDTH).toBeGreaterThan(0);
    });

    test('MAX_STATE_REGISTRY_SIZE is defined and reasonable', () => {
      expect(constants.MAX_STATE_REGISTRY_SIZE).toBeGreaterThan(0);
    });

    test('SNAP_THRESHOLD is positive', () => {
      expect(constants.SNAP_THRESHOLD).toBeGreaterThan(0);
    });
  });

  describe('Timeouts', () => {
    test('timeout values are positive and in correct order', () => {
      expect(constants.IDLE_TIMEOUT).toBeGreaterThan(0);
      expect(constants.SLEEP_TIMEOUT).toBeGreaterThan(constants.IDLE_TIMEOUT);
      expect(constants.WINDOW_CLOSE_TIMEOUT).toBeGreaterThan(constants.SLEEP_TIMEOUT);
    });
  });

  describe('Modes and States', () => {
    test('ALWAYS_ON_TOP_MODES has required modes', () => {
      expect(constants.ALWAYS_ON_TOP_MODES).toHaveProperty('active-only');
      expect(constants.ALWAYS_ON_TOP_MODES).toHaveProperty('all');
      expect(constants.ALWAYS_ON_TOP_MODES).toHaveProperty('disabled');
    });

    test('ACTIVE_STATES includes expected states', () => {
      expect(constants.ACTIVE_STATES).toContain('thinking');
      expect(constants.ACTIVE_STATES).toContain('planning');
      expect(constants.ACTIVE_STATES).toContain('working');
      expect(constants.ACTIVE_STATES).toContain('notification');
      expect(constants.ACTIVE_STATES).not.toContain('idle');
      expect(constants.ACTIVE_STATES).not.toContain('sleep');
    });
  });

  describe('Character Layout', () => {
    test('CHAR_SIZE is positive', () => {
      expect(constants.CHAR_SIZE).toBeGreaterThan(0);
    });
  });
});
