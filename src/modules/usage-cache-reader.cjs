/**
 * Reads the shared plan-usage cache (~/.vibemon/cache/usage.json) that
 * ~/.vibemon/usage.py and the AI-tool hooks/statuslines refresh under the
 * "claude"/"codex" keys. This mirrors usage_cache.py's get_fresh_provider()
 * staleness rules in JS, so the tray menu can show Claude and Codex usage
 * together — independent of which project (if any) is currently focused,
 * and without a stale % lingering once its window has expired.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { USAGE_CACHE_STALE_SECONDS } = require('../shared/config.cjs');

const VIBEMON_CONFIG_PATH = path.join(os.homedir(), '.vibemon', 'config.json');
const DEFAULT_CACHE_PATH = path.join(os.homedir(), '.vibemon', 'cache', 'projects.json');

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Resolve ~/.vibemon/cache/usage.json, honoring config.json's cache_path
 * (same directory-sibling logic as usage.py's get_usage_cache_path()).
 * @returns {string}
 */
function getUsageCachePath() {
  let projectsCachePath = DEFAULT_CACHE_PATH;
  try {
    const raw = JSON.parse(fs.readFileSync(VIBEMON_CONFIG_PATH, 'utf8'));
    if (raw && typeof raw.cache_path === 'string' && raw.cache_path) {
      projectsCachePath = expandHome(raw.cache_path);
    }
  } catch {
    // Missing/invalid config: fall back to the default cache path.
  }
  return path.join(path.dirname(projectsCachePath), 'usage.json');
}

/**
 * @returns {object|null} parsed cache, or null if missing/unreadable
 */
function readUsageCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(getUsageCachePath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Freshness-filtered {pct, resetsAt} for one provider's bucket, or null if
 * the provider/bucket is missing, its updated_at is older than
 * USAGE_CACHE_STALE_SECONDS, or its reset window has already passed.
 * @param {object|null} cache
 * @param {string} provider - 'claude' | 'codex'
 * @param {string} bucketKey - 'session' | 'week_all'
 * @param {number} nowMs
 * @returns {{pct: number, resetsAt: number|null}|null}
 */
function getFreshBucket(cache, provider, bucketKey, nowMs) {
  if (!cache || typeof cache !== 'object') return null;
  const providerData = cache[provider];
  if (!providerData || typeof providerData !== 'object') return null;

  const providerUpdatedAt = Number(providerData.updated_at ?? cache.ts ?? 0);
  if (!providerUpdatedAt || nowMs - providerUpdatedAt * 1000 > USAGE_CACHE_STALE_SECONDS * 1000) {
    return null;
  }

  const bucket = providerData[bucketKey];
  if (!bucket || typeof bucket !== 'object' || typeof bucket.pct !== 'number') return null;

  const bucketUpdatedAt = Number(bucket.updated_at ?? providerUpdatedAt);
  if (!bucketUpdatedAt || nowMs - bucketUpdatedAt * 1000 > USAGE_CACHE_STALE_SECONDS * 1000) {
    return null;
  }

  const resetsAt = typeof bucket.resets_at === 'number' ? bucket.resets_at : null;
  if (resetsAt !== null && resetsAt * 1000 <= nowMs) {
    return null;
  }

  return { pct: bucket.pct, resetsAt };
}

/**
 * Freshness-filtered model-scoped weekly bucket (any "week_*" key other than
 * "week_all", e.g. "week_fable") for one provider — the one with the highest
 * pct when several exist, since that's the binding limit. Mirrors
 * usage_cache.py's model_week_bucket().
 * @param {object|null} cache
 * @param {string} provider - 'claude' | 'codex'
 * @param {number} nowMs
 * @returns {{pct: number, resetsAt: number|null, label: string}|null}
 */
function getFreshModelWeekBucket(cache, provider, nowMs) {
  const providerData = cache && typeof cache === 'object' ? cache[provider] : null;
  if (!providerData || typeof providerData !== 'object') return null;

  let best = null;
  for (const key of Object.keys(providerData)) {
    if (!key.startsWith('week_') || key === 'week_all') continue;
    const fresh = getFreshBucket(cache, provider, key, nowMs);
    if (!fresh) continue;
    if (!best || fresh.pct > best.pct) {
      const rawLabel = providerData[key] && providerData[key].label;
      const label = typeof rawLabel === 'string' && rawLabel
        ? rawLabel
        : key.slice('week_'.length).replace(/^./, (c) => c.toUpperCase());
      best = { ...fresh, label };
    }
  }
  return best;
}

/**
 * @param {number} [nowMs]
 * @returns {{
 *   claude: {session: {pct, resetsAt}|null, week: {pct, resetsAt}|null,
 *            modelWeek: {pct, resetsAt, label}|null},
 *   codex:  {session: {pct, resetsAt}|null, week: {pct, resetsAt}|null,
 *            modelWeek: {pct, resetsAt, label}|null}
 * }}
 */
function getUsageSnapshot(nowMs = Date.now()) {
  const cache = readUsageCache();
  return {
    claude: {
      session: getFreshBucket(cache, 'claude', 'session', nowMs),
      week: getFreshBucket(cache, 'claude', 'week_all', nowMs),
      modelWeek: getFreshModelWeekBucket(cache, 'claude', nowMs)
    },
    codex: {
      session: getFreshBucket(cache, 'codex', 'session', nowMs),
      week: getFreshBucket(cache, 'codex', 'week_all', nowMs),
      modelWeek: getFreshModelWeekBucket(cache, 'codex', nowMs)
    }
  };
}

/**
 * Format the time remaining until resetsAt (epoch seconds) compactly, e.g.
 * "24m", "2h5m", "3d4h" — same shape as bubble/vibemon-bubble.js's
 * formatMinutes(), duplicated here since that's an ESM renderer-side module
 * this CJS main-process module can't require().
 * @param {number} resetsAt - epoch seconds
 * @param {number} [nowMs]
 * @returns {string}
 */
function formatResetIn(resetsAt, nowMs = Date.now()) {
  const mins = Math.max(0, Math.round((resetsAt * 1000 - nowMs) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

module.exports = { getUsageCachePath, getUsageSnapshot, formatResetIn };
