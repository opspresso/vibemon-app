/**
 * State and timer management for Vibe Monitor (Multi-Window Architecture)
 *
 * Each window manages its own state. StateManager handles:
 * - Per-project timers (state timeouts, window close timeouts)
 * - State data validation
 */

const {
  IDLE_TIMEOUT, SLEEP_TIMEOUT, WINDOW_CLOSE_TIMEOUT,
  CHARACTER_CONFIG, DEFAULT_CHARACTER
} = require('../shared/config.cjs');

class StateManager {
  constructor() {
    // Per-project timers
    this.stateTimeoutTimers = new Map();
    this.windowCloseTimers = new Map();

    // Callbacks (set by main.js)
    this.onStateTimeout = null;      // (projectId, newState) => void
    this.onWindowCloseTimeout = null; // (projectId) => void
  }

  // Timer management - per project

  /**
   * Clear state timeout timer for a specific project
   * @param {string} projectId - Project identifier
   */
  clearStateTimeout(projectId) {
    const timer = this.stateTimeoutTimers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      this.stateTimeoutTimers.delete(projectId);
    }
  }

  /**
   * Clear window close timer for a specific project
   * @param {string} projectId - Project identifier
   */
  clearWindowCloseTimer(projectId) {
    const timer = this.windowCloseTimers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      this.windowCloseTimers.delete(projectId);
    }
  }

  /**
   * Set up window close timer for a project in sleep state
   * @param {string} projectId - Project identifier
   * @param {string} currentState - Current state of the project
   */
  setupWindowCloseTimer(projectId, currentState) {
    this.clearWindowCloseTimer(projectId);

    if (currentState === 'sleep' && this.onWindowCloseTimeout) {
      const timer = setTimeout(() => {
        this.windowCloseTimers.delete(projectId);
        this.onWindowCloseTimeout(projectId);
      }, WINDOW_CLOSE_TIMEOUT);
      this.windowCloseTimers.set(projectId, timer);
    }
  }

  /**
   * Set up state timeout for automatic state transitions
   * @param {string} projectId - Project identifier
   * @param {string} currentState - Current state of the project
   */
  setupStateTimeout(projectId, currentState) {
    this.clearStateTimeout(projectId);
    this.clearWindowCloseTimer(projectId);

    if (currentState === 'start' || currentState === 'done') {
      // start/done -> idle after 1 minute
      const timer = setTimeout(() => {
        this.stateTimeoutTimers.delete(projectId);
        if (this.onStateTimeout) {
          this.onStateTimeout(projectId, 'idle');
        }
      }, IDLE_TIMEOUT);
      this.stateTimeoutTimers.set(projectId, timer);
    } else if (currentState === 'planning' || currentState === 'thinking' ||
               currentState === 'working' || currentState === 'packing' ||
               currentState === 'notification' || currentState === 'alert') {
      // planning/thinking/working/packing/notification/alert -> idle after 5 minutes
      const timer = setTimeout(() => {
        this.stateTimeoutTimers.delete(projectId);
        if (this.onStateTimeout) {
          this.onStateTimeout(projectId, 'idle');
        }
      }, SLEEP_TIMEOUT);
      this.stateTimeoutTimers.set(projectId, timer);
    } else if (currentState === 'idle') {
      // idle -> sleep after 5 minutes
      const timer = setTimeout(() => {
        this.stateTimeoutTimers.delete(projectId);
        if (this.onStateTimeout) {
          this.onStateTimeout(projectId, 'sleep');
        }
      }, SLEEP_TIMEOUT);
      this.stateTimeoutTimers.set(projectId, timer);
    } else if (currentState === 'sleep') {
      // sleep -> close window after 10 minutes
      this.setupWindowCloseTimer(projectId, currentState);
    }
  }

  // Validation

  /**
   * Validate and normalize state data
   * @param {Object} data - Incoming state data
   * @returns {Object} Normalized data with validated character field
   */
  validateStateData(data) {
    if (!data || typeof data !== 'object') {
      return { valid: false, error: 'Invalid data format' };
    }

    // Create a new normalized data object (immutability)
    const normalized = { ...data };

    // Validate and normalize character field
    if (normalized.character !== undefined) {
      normalized.character = CHARACTER_CONFIG[normalized.character]
        ? normalized.character
        : DEFAULT_CHARACTER;
    }

    return {
      valid: true,
      data: normalized
    };
  }

  // Cleanup

  /**
   * Clear all timers for a specific project
   * @param {string} projectId - Project identifier
   */
  cleanupProject(projectId) {
    this.clearStateTimeout(projectId);
    this.clearWindowCloseTimer(projectId);
  }

  /**
   * Clear all timers for all projects
   */
  cleanup() {
    // Clear all state timeout timers
    for (const [, timer] of this.stateTimeoutTimers) {
      clearTimeout(timer);
    }
    this.stateTimeoutTimers.clear();

    // Clear all window close timers
    for (const [, timer] of this.windowCloseTimers) {
      clearTimeout(timer);
    }
    this.windowCloseTimers.clear();
  }
}

module.exports = { StateManager };
