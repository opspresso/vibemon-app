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
const { getUsageCachePath, getUsageSnapshot } = require('../src/modules/usage-cache-reader.cjs');

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
    const customDirectory = path.resolve('/custom/dir');
    fs.readFileSync.mockImplementation((p) => {
      if (p === CONFIG_PATH) return JSON.stringify({ cache_path: path.join(customDirectory, 'projects.json') });
      throw new Error('ENOENT');
    });

    expect(getUsageCachePath()).toBe(path.join(customDirectory, 'usage.json'));
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
      claude: { session: null, week: null, modelWeek: null },
      codex: { session: null, week: null, modelWeek: null }
    });
  });

  test('returns fresh buckets with their measurement and reset times', () => {
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
        session: { pct: 32, resetsAt: 5000, updatedAt: 1000 },
        week: { pct: 67, resetsAt: 900000, updatedAt: 1000 },
        modelWeek: null
      },
      codex: {
        session: { pct: 10, resetsAt: 2000, updatedAt: 1000 },
        week: null,
        modelWeek: null
      }
    });
  });

  test('returns the model-scoped weekly bucket with its label', () => {
    mockCache({
      claude: {
        updated_at: 1000,
        week_all: { pct: 7, resets_at: 900000, updated_at: 1000 },
        week_fable: { pct: 12, resets_at: 900000, label: 'Fable', updated_at: 1000 }
      }
    });

    expect(getUsageSnapshot(1_500_000).claude.modelWeek).toEqual({
      pct: 12,
      resetsAt: 900000,
      updatedAt: 1000,
      label: 'Fable'
    });
  });

  test('derives a label from the bucket key when the cache has none', () => {
    mockCache({
      claude: {
        updated_at: 1000,
        week_fable: { pct: 12, resets_at: 900000, updated_at: 1000 }
      }
    });

    expect(getUsageSnapshot(1_500_000).claude.modelWeek.label).toBe('Fable');
  });

  test('picks the highest-pct model bucket when several exist', () => {
    mockCache({
      claude: {
        updated_at: 1000,
        week_fable: { pct: 12, resets_at: 900000, label: 'Fable', updated_at: 1000 },
        week_sonnet: { pct: 40, resets_at: 900000, label: 'Sonnet', updated_at: 1000 }
      }
    });

    expect(getUsageSnapshot(1_500_000).claude.modelWeek).toEqual({
      pct: 40,
      resetsAt: 900000,
      updatedAt: 1000,
      label: 'Sonnet'
    });
  });

  test('drops a stale model-scoped bucket', () => {
    mockCache({
      claude: {
        updated_at: 4900,
        week_fable: { pct: 12, resets_at: 900000, label: 'Fable', updated_at: 1000 }
      }
    });

    expect(getUsageSnapshot(5_000_000).claude.modelWeek).toBeNull();
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

describe('profile isolation', () => {
  const original = { ...process.env };
  afterEach(() => { process.env = { ...original }; });
  test('environment cache path wins over config and named accounts never borrow default data', () => {
    process.env.VIBEMON_CACHE_PATH = '~/separate/projects.json';
    process.env.VIBEMON_ACCOUNT_ID = 'work';
    delete process.env.VIBEMON_CLAUDE_ACCOUNT_ID;
    delete process.env.VIBEMON_CODEX_ACCOUNT_ID;
    const target = path.join(os.homedir(), 'separate', 'usage.json');
    fs.readFileSync.mockImplementation(file => {
      if (file === target) return JSON.stringify({ claude: { updated_at: 1000, session: { pct: 90 } }, 'claude:work': { updated_at: 1000, session: { pct: 20 } }, codex: { updated_at: 1000, session: { pct: 80 } } });
      throw new Error('Unexpected cache location');
    });
    expect(getUsageCachePath()).toBe(target);
    const snapshot = getUsageSnapshot(1000000);
    expect(snapshot.claude.session.pct).toBe(90);
    expect(snapshot['claude:work'].session.pct).toBe(20);
    expect(snapshot.codex.session.pct).toBe(80);
    expect(snapshot['codex:work']).toBeUndefined();
  });
});

test('aggregates separate profile caches and keeps the newest observation for each account', () => {
  const registry = path.join(os.homedir(), '.vibemon', 'accounts.json');
  const custom = path.join(os.homedir(), 'work-cache', 'usage.json');
  const account = { provider: 'claude', id: 'work', displayName: 'Work' };
  fs.readFileSync.mockImplementation(file => {
    if (file === registry) return JSON.stringify({ version: 1, profiles: { ['d'.repeat(64)]: {
      provider: 'claude', root: os.homedir(), instance: 'fixture', account: { ...account, kind: 'manual' },
      cachePath: path.join(path.dirname(custom), 'projects.json')
    } } });
    if (file === custom) return JSON.stringify({ 'claude:work': { updated_at: 1100, account, session: { pct: 32 }, week_all: { pct: 10 } } });
    if (file === DEFAULT_USAGE_PATH) return JSON.stringify({ 'claude:work': { updated_at: 1000, session: { pct: 90 } }, 'codex:personal': { updated_at: 1100, session: { pct: 4 } } });
    throw new Error('ENOENT');
  });
  const snapshot = getUsageSnapshot(1200000);
  expect(snapshot['claude:work']).toMatchObject({ account, session: { pct: 32 }, week: { pct: 10 } });
  expect(snapshot['codex:personal'].session.pct).toBe(4);
  expect(snapshot.claude.session).toBeNull();
});
