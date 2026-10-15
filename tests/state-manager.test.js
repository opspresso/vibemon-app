/**
 * Tests for state-manager.cjs
 */

const { StateManager } = require('../src/modules/state-manager.cjs');

describe('StateManager', () => {
  let stateManager;

  beforeEach(() => {
    jest.useFakeTimers();
    stateManager = new StateManager();
  });

  afterEach(() => {
    stateManager.cleanup();
    jest.useRealTimers();
  });

  describe('constructor', () => {
    test('initializes with empty timer maps', () => {
      expect(stateManager.stateTimeoutTimers.size).toBe(0);
      expect(stateManager.windowCloseTimers.size).toBe(0);
    });

    test('initializes with null callbacks', () => {
      expect(stateManager.onStateTimeout).toBeNull();
      expect(stateManager.onWindowCloseTimeout).toBeNull();
    });
  });

  test('remote presentation has one clock while sleeping windows still close', () => {
    stateManager.onStateTimeout = jest.fn();
    stateManager.onWindowCloseTimeout = jest.fn();
    stateManager.setupStateTimeout('cloud:waiting', 'notification');
    stateManager.setupStateTimeout('cloud:waiting', 'notification', { remote: true });
    jest.advanceTimersByTime(3600000);
    expect(stateManager.onStateTimeout).not.toHaveBeenCalled();
    stateManager.setupStateTimeout('cloud:waiting', 'sleep', { remote: true });
    jest.advanceTimersByTime(600000);
    expect(stateManager.onWindowCloseTimeout).toHaveBeenCalledWith('cloud:waiting');
  });

  describe('validateStateData', () => {
    test('returns invalid for null data', () => {
      const result = stateManager.validateStateData(null);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid data format');
    });

    test('returns invalid for non-object data', () => {
      const result = stateManager.validateStateData('string');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid data format');
    });

    test('returns valid for empty object', () => {
      const result = stateManager.validateStateData({});
      expect(result.valid).toBe(true);
      expect(result.data).toEqual({});
    });

    test('returns valid for valid state data', () => {
      const data = { state: 'working', project: 'test' };
      const result = stateManager.validateStateData(data);
      expect(result.valid).toBe(true);
      expect(result.data).toEqual(data);
    });

    test('preserves valid character', () => {
      const data = { state: 'idle', character: 'clawd' };
      const result = stateManager.validateStateData(data);
      expect(result.valid).toBe(true);
      expect(result.data.character).toBe('clawd');
    });

    test.each(['constructor', '__proto__'])('does not accept inherited character %s', character => {
      expect(stateManager.validateStateData({ state: 'idle', character }).data.character).toBe('vibemon');
    });

    test('replaces invalid character with default', () => {
      const data = { state: 'idle', character: 'invalid-character' };
      const result = stateManager.validateStateData(data);
      expect(result.valid).toBe(true);
      expect(result.data.character).toBe('vibemon'); // DEFAULT_CHARACTER
    });

    test('does not add character field if not present', () => {
      const data = { state: 'idle' };
      const result = stateManager.validateStateData(data);
      expect(result.valid).toBe(true);
      expect(result.data.character).toBeUndefined();
    });

    test('drops empty project name', () => {
      const result = stateManager.validateStateData({ state: 'working', project: '' });
      expect(result.valid).toBe(true);
      expect(result.data.project).toBeUndefined();
    });

    test('drops "-" placeholder project name', () => {
      const result = stateManager.validateStateData({ state: 'working', project: '-' });
      expect(result.valid).toBe(true);
      expect(result.data.project).toBeUndefined();
    });

    test('creates new object (immutability)', () => {
      const data = { state: 'idle', project: 'test' };
      const result = stateManager.validateStateData(data);
      expect(result.data).not.toBe(data);
      expect(result.data).toEqual(data);
    });

    test('drops unknown payload fields at the application boundary', () => {
      const result = stateManager.validateStateData({ state: 'working', project: 'a', secret: 'do-not-store' });

      expect(result.data).toEqual({ state: 'working', project: 'a' });
    });
  });

  describe('clearStateTimeout', () => {
    test('clears existing timer', () => {
      stateManager.setupStateTimeout('project1', 'start');
      expect(stateManager.stateTimeoutTimers.has('project1')).toBe(true);

      stateManager.clearStateTimeout('project1');
      expect(stateManager.stateTimeoutTimers.has('project1')).toBe(false);
    });

    test('handles non-existent timer gracefully', () => {
      expect(() => stateManager.clearStateTimeout('nonexistent')).not.toThrow();
    });
  });

  describe('clearWindowCloseTimer', () => {
    test('clears existing timer', () => {
      stateManager.onWindowCloseTimeout = jest.fn();
      stateManager.setupWindowCloseTimer('project1', 'sleep');
      expect(stateManager.windowCloseTimers.has('project1')).toBe(true);

      stateManager.clearWindowCloseTimer('project1');
      expect(stateManager.windowCloseTimers.has('project1')).toBe(false);
    });

    test('handles non-existent timer gracefully', () => {
      expect(() => stateManager.clearWindowCloseTimer('nonexistent')).not.toThrow();
    });
  });

  describe('setupStateTimeout', () => {
    test.each([
      ['start', 60000, 'idle'], ['done', 60000, 'idle'],
      ['thinking', 300000, 'idle'], ['planning', 300000, 'idle'], ['working', 300000, 'idle'],
      ['packing', 300000, 'idle'], ['notification', 300000, 'idle'], ['alert', 300000, 'idle'],
      ['idle', 300000, 'sleep']
    ])('%s moves to %s after its timeout, not before', (state, delay, next) => {
      const callback = jest.fn();
      stateManager.onStateTimeout = callback;

      stateManager.setupStateTimeout('project1', state);
      jest.advanceTimersByTime(delay - 1);
      expect(callback).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);

      expect(callback).toHaveBeenCalledWith('project1', next);
      expect(stateManager.stateTimeoutTimers.has('project1')).toBe(false);
    });

    test('sets window close timer for sleep state', () => {
      const closeCallback = jest.fn();
      stateManager.onWindowCloseTimeout = closeCallback;

      stateManager.setupStateTimeout('project1', 'sleep');

      expect(stateManager.windowCloseTimers.has('project1')).toBe(true);

      // Advance 10 minutes
      jest.advanceTimersByTime(600000);
      expect(closeCallback).toHaveBeenCalledWith('project1');
    });

    test('clears existing timers before setting new ones', () => {
      const callback = jest.fn();
      stateManager.onStateTimeout = callback;

      stateManager.setupStateTimeout('project1', 'start');
      stateManager.setupStateTimeout('project1', 'working');

      // Original start timer should be cleared
      jest.advanceTimersByTime(60000);
      expect(callback).not.toHaveBeenCalled();

      // Working timer should trigger at 5 min
      jest.advanceTimersByTime(240000);
      expect(callback).toHaveBeenCalledWith('project1', 'idle');
    });

    test('does not call callback if not set', () => {
      stateManager.setupStateTimeout('project1', 'start');

      expect(() => {
        jest.advanceTimersByTime(60000);
      }).not.toThrow();
    });

    test('handles multiple projects independently', () => {
      const callback = jest.fn();
      stateManager.onStateTimeout = callback;

      stateManager.setupStateTimeout('project1', 'start');  // 1 min
      stateManager.setupStateTimeout('project2', 'idle');   // 5 min

      jest.advanceTimersByTime(60000);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith('project1', 'idle');

      jest.advanceTimersByTime(240000);
      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenCalledWith('project2', 'sleep');
    });
  });

  describe('setupWindowCloseTimer', () => {
    test('sets timer only for sleep state', () => {
      const callback = jest.fn();
      stateManager.onWindowCloseTimeout = callback;

      stateManager.setupWindowCloseTimer('project1', 'sleep');
      expect(stateManager.windowCloseTimers.has('project1')).toBe(true);

      jest.advanceTimersByTime(600000); // 10 min
      expect(callback).toHaveBeenCalledWith('project1');
    });

    test('does not set timer for non-sleep state', () => {
      const callback = jest.fn();
      stateManager.onWindowCloseTimeout = callback;

      stateManager.setupWindowCloseTimer('project1', 'idle');
      expect(stateManager.windowCloseTimers.has('project1')).toBe(false);
    });

    test('does not set timer if callback not set', () => {
      stateManager.setupWindowCloseTimer('project1', 'sleep');
      expect(stateManager.windowCloseTimers.has('project1')).toBe(false);
    });
  });

  describe('cleanupProject', () => {
    test('clears both timers for a project', () => {
      const stateCallback = jest.fn();
      const closeCallback = jest.fn();
      stateManager.onStateTimeout = stateCallback;
      stateManager.onWindowCloseTimeout = closeCallback;

      // Set up timers
      stateManager.setupStateTimeout('project1', 'idle');
      stateManager.setupWindowCloseTimer('project1', 'sleep');

      // Cleanup
      stateManager.cleanupProject('project1');

      expect(stateManager.stateTimeoutTimers.has('project1')).toBe(false);
      expect(stateManager.windowCloseTimers.has('project1')).toBe(false);

      // Timers should not fire
      jest.advanceTimersByTime(600000);
      expect(stateCallback).not.toHaveBeenCalled();
      expect(closeCallback).not.toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    test('clears all timers for all projects', () => {
      const callback = jest.fn();
      stateManager.onStateTimeout = callback;
      stateManager.onWindowCloseTimeout = callback;

      // Set up multiple projects
      stateManager.setupStateTimeout('project1', 'start');
      stateManager.setupStateTimeout('project2', 'idle');
      stateManager.setupStateTimeout('project3', 'sleep');

      // Cleanup all
      stateManager.cleanup();

      expect(stateManager.stateTimeoutTimers.size).toBe(0);
      expect(stateManager.windowCloseTimers.size).toBe(0);

      // No timers should fire
      jest.advanceTimersByTime(600000);
      expect(callback).not.toHaveBeenCalled();
    });
  });
});
