/**
 * Tests for usage-cache-reader.cjs
 */

const os = require('os');
const path = require('path');

jest.mock('fs');
jest.mock('../src/shared/config.cjs', () => ({
  USAGE_CACHE_STALE_SECONDS: 1800
}));

const fs = require('fs');
const { getUsageCachePath, getUsageSnapshot, formatResetIn } = require('../src/modules/usage-cache-reader.cjs');

const CONFIG_PATH = path.join(os.homedir(), '.vibemon', 'config.json');
const DEFAULT_USAGE_PATH = path.join(os.homedir(), '.vibemon', 'cache', 'usage.json');

beforeEach(() => {
  fs.readFileSync.mockReset();
});

describe('getUsageCachePath', () => {
  test('defaults to ~/.vibemon/cache/usage.json when config.json is missing', () => {
    fs.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(getUsageCachePath()).toBe(DEFAULT_USAGE_PATH);
  });

  test('honors cache_path from config.json', () => {
    fs.readFileSync.mockImplementation((p) => {
      if (p === CONFIG_PATH) return JSON.stringify({ cache_path: '/custom/dir/projects.json' });
      throw new Error('ENOENT');
    });

    expect(getUsageCachePath()).toBe(path.join('/custom/dir', 'usage.json'));
  });

  test('expands a ~-prefixed cache_path', () => {
    fs.readFileSync.mockImplementation((p) => {
      if (p === CONFIG_PATH) return JSON.stringify({ cache_path: '~/custom/projects.json' });
      throw new Error('ENOENT');
    });

    expect(getUsageCachePath()).toBe(path.join(os.homedir(), 'custom', 'usage.json'));
  });

  test('falls back to default when config.json is invalid JSON', () => {
    fs.readFileSync.mockImplementation((p) => {
      if (p === CONFIG_PATH) return '{not json';
      throw new Error('ENOENT');
    });

    expect(getUsageCachePath()).toBe(DEFAULT_USAGE_PATH);
  });
});

describe('getUsageSnapshot', () => {
  function mockCache(cache) {
    fs.readFileSync.mockImplementation((p) => {
      if (p === CONFIG_PATH) throw new Error('ENOENT');
      if (p === DEFAULT_USAGE_PATH) return JSON.stringify(cache);
      throw new Error('ENOENT');
    });
  }

  test('returns all-null buckets when the cache file is missing', () => {
    fs.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(getUsageSnapshot(1_500_000)).toEqual({
      claude: { session: null, week: null },
      codex: { session: null, week: null }
    });
  });

  test('returns fresh buckets with pct and resetsAt', () => {
    mockCache({
      claude: {
        updated_at: 1000,
        session: { pct: 32, resets_at: 5000, updated_at: 1000 },
        week_all: { pct: 67, resets_at: 900000, updated_at: 1000 }
      },
      codex: {
        updated_at: 1000,
        session: { pct: 10, resets_at: 2000, updated_at: 1000 }
      }
    });

    expect(getUsageSnapshot(1_500_000)).toEqual({
      claude: {
        session: { pct: 32, resetsAt: 5000 },
        week: { pct: 67, resetsAt: 900000 }
      },
      codex: {
        session: { pct: 10, resetsAt: 2000 },
        week: null
      }
    });
  });

  test('drops a provider whose updated_at is older than the stale threshold', () => {
    mockCache({
      claude: {
        updated_at: 1000,
        session: { pct: 32, resets_at: 900000, updated_at: 1000 }
      }
    });

    // now = 5000s, provider updated 4000s ago > 1800s stale threshold
    expect(getUsageSnapshot(5_000_000).claude.session).toBeNull();
  });

  test('drops a bucket whose own updated_at is older than the stale threshold, even if the provider is fresh', () => {
    mockCache({
      claude: {
        updated_at: 4900,
        session: { pct: 32, resets_at: 900000, updated_at: 1000 }
      }
    });

    // provider updated 100s ago (fresh), but this bucket was stamped 4000s ago
    expect(getUsageSnapshot(5_000_000).claude.session).toBeNull();
  });

  test('drops a bucket whose resets_at has already passed', () => {
    mockCache({
      claude: {
        updated_at: 1000,
        session: { pct: 32, resets_at: 1000, updated_at: 1000 }
      }
    });

    expect(getUsageSnapshot(1_500_000).claude.session).toBeNull();
  });

  test('drops a bucket with no numeric pct', () => {
    mockCache({
      claude: {
        updated_at: 1000,
        session: { resets_at: 900000, updated_at: 1000 }
      }
    });

    expect(getUsageSnapshot(1_500_000).claude.session).toBeNull();
  });
});

describe('formatResetIn', () => {
  const now = 1_000_000; // 1000s

  test('formats under an hour as minutes', () => {
    expect(formatResetIn(1000 + 24 * 60, now)).toBe('24m');
  });

  test('formats an exact hour with no minutes suffix', () => {
    expect(formatResetIn(1000 + 60 * 60, now)).toBe('1h');
  });

  test('formats hours and minutes', () => {
    expect(formatResetIn(1000 + 2 * 3600 + 5 * 60, now)).toBe('2h5m');
  });

  test('formats an exact day with no hours suffix', () => {
    expect(formatResetIn(1000 + 24 * 3600, now)).toBe('1d');
  });

  test('formats days and hours', () => {
    expect(formatResetIn(1000 + 3 * 86400 + 4 * 3600, now)).toBe('3d4h');
  });

  test('clamps a past resetsAt to 0m', () => {
    expect(formatResetIn(500, now)).toBe('0m');
  });
});
