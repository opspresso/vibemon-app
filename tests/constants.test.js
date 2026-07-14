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
    test('window dimensions are positive', () => {
      expect(constants.WINDOW_WIDTH).toBeGreaterThan(0);
      expect(constants.WINDOW_HEIGHT).toBeGreaterThan(0);
    });

    test('MAX_WINDOWS is reasonable', () => {
      expect(constants.MAX_WINDOWS).toBe(5);
      expect(constants.MAX_WINDOWS).toBeGreaterThan(0);
    });

    test('MAX_PROJECT_LIST is defined and reasonable', () => {
      expect(constants.MAX_PROJECT_LIST).toBe(10);
      expect(constants.MAX_PROJECT_LIST).toBeGreaterThan(constants.MAX_WINDOWS);
    });

    test('MAX_STATE_REGISTRY_SIZE is defined and larger than MAX_PROJECT_LIST', () => {
      expect(constants.MAX_STATE_REGISTRY_SIZE).toBeGreaterThan(constants.MAX_PROJECT_LIST);
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

  describe('Window Modes', () => {
    test('LOCK_MODES has required modes', () => {
      expect(constants.LOCK_MODES).toHaveProperty('first-project');
      expect(constants.LOCK_MODES).toHaveProperty('on-thinking');
    });

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

  describe('Character Settings', () => {
    test('DEFAULT_CHARACTER is valid', () => {
      expect(constants.DEFAULT_CHARACTER).toBe('vibemon');
    });

    test('CHAR_SIZE and SCALE are positive', () => {
      expect(constants.CHAR_SIZE).toBeGreaterThan(0);
      expect(constants.SCALE).toBeGreaterThan(0);
    });
  });
});
